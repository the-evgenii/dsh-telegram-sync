import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { GatewayInteractions, validAnswer } from '../src/interaction-gateway.mjs';

const questions = [{ id: 'q', question: 'Choose', options: [{ label: 'A' }, { label: 'B' }] }];
const noProvider = () => Promise.reject(Object.assign(new Error('no provider'), { code: 'NO_PROVIDER' }));
function fixture(t) {
  const store = new Store(); t.after(() => store.close());
  const listeners = new Map(), calls = [];
  const agent = { id: 'a', session: { id: 'a' } };
  const ctx = {
    on: (event, handler) => { listeners.set(event, handler); return () => listeners.delete(event); },
    agents: { get: id => id === 'a' ? agent : undefined, roots: () => [agent] },
    workspaceRegistry: { archivedSessionIds: [] },
    sessions: { get: () => agent.session, flush: async () => calls.push('flush') },
    typertGateway: { invoke: async request => { calls.push(request); return true; } },
  };
  let projection = { values: { userQuestions: { active: [] } } };
  const adapter = { peer: {}, invoke: async () => projection };
  const interactions = new GatewayInteractions({ ctx, store, adapter, logger: { warn() {} } });
  t.after(() => interactions.dispose());
  return { interactions, ctx, store, agent, listeners, calls, adapter, projection: value => { projection = value; } };
}

test('remote answer settles exact question without aborting its enclosing Turn signal', async t => {
  const { interactions, agent } = fixture(t);
  const outer = new AbortController();
  const request = { agent, questions, signal: outer.signal };
  const result = interactions.ask('question', request, noProvider);
  const [wire] = interactions.snapshot();
  assert.equal(wire.kind, 'question');
  assert.notEqual(request.signal, outer.signal);
  await interactions.answer({ token: wire.token, sessionId: 'a', answer: { answers: [{ id: 'q', selected: ['A'] }] } });
  assert.deepEqual(await result, { answers: [{ id: 'q', selected: ['A'] }] });
  assert.equal(outer.signal.aborted, false);
  assert.equal(request.signal, outer.signal);
  assert.equal(interactions.snapshot().length, 0);
  await assert.rejects(() => interactions.answer({ token: wire.token, sessionId: 'a', answer: {} }), /expired/);
});

test('GUI answer wins the race and retires remote card without changing policy or Turn lifetime', async t => {
  const { interactions, agent } = fixture(t);
  const outer = new AbortController();
  const result = interactions.ask('question', { agent, signal: outer.signal, questions }, async () => ({ answers: [{ id: 'q', selected: ['B'] }] }));
  const [wire] = interactions.snapshot();
  assert.equal((await result).answers[0].selected[0], 'B');
  await assert.rejects(() => interactions.answer({ token: wire.token, sessionId: 'a', answer: { answers: [{ id: 'q', selected: ['A'] }] } }), /expired/);
  assert.equal(outer.signal.aborted, false);
});

test('approval supports only one-time grant/rejection for live root and exact Session', async t => {
  const { interactions, agent } = fixture(t);
  interactions.observeSessionEvent(agent.session, { type: 'tool/call', data: { callId: 'call', name: 'bash', arguments: '{"command":"pwd"}' } });
  const result = interactions.ask('approval', { agent, toolName: 'bash', callId: 'call', reason: 'approval required' }, async () => 'unavailable');
  const [wire] = interactions.snapshot();
  assert.equal(wire.details, '{"command":"pwd"}');
  await assert.rejects(() => interactions.answer({ token: wire.token, sessionId: 'a', answer: { decision: 'always-allow' } }), /Invalid approval/);
  await assert.rejects(() => interactions.answer({ token: wire.token, sessionId: 'other', answer: { decision: 'allowed-once' } }), /expired/);
  await interactions.answer({ token: wire.token, sessionId: 'a', answer: { decision: 'allowed-once' } });
  assert.equal(await result, 'allowed-once');
});

test('Auto review localized approval reasons become plain text for relay transport', async t => {
  const { interactions, agent } = fixture(t);
  for (const [displayReason, expected] of [
    [{ ru: 'Нужно одобрение', en: 'Approval required' }, 'Нужно одобрение'],
    [{ en: 'Approval required' }, 'Approval required'],
    ['Plain reason', 'Plain reason'],
    [{ de: 'Freigabe' }, 'fallback'],
  ]) {
    const result = interactions.ask('approval', { agent, toolName: 'bash', reason: 'fallback', displayReason }, async () => 'unavailable');
    const [wire] = interactions.snapshot();
    assert.equal(wire.reason, expected);
    await interactions.answer({ token: wire.token, sessionId: 'a', answer: { decision: 'rejected' } });
    assert.equal(await result, 'rejected');
  }
});

test('cancellation, plugin stop, foreign/delegated agent fail closed', async t => {
  const { interactions, agent } = fixture(t);
  const outer = new AbortController();
  const result = interactions.ask('approval', { agent, signal: outer.signal, toolName: 'bash' }, async () => 'unavailable');
  const [wire] = interactions.snapshot();
  outer.abort(); assert.equal(await result, 'cancelled');
  await assert.rejects(() => interactions.answer({ token: wire.token, sessionId: 'a', answer: { decision: 'allowed-once' } }), /expired/);
  let delegated = false;
  assert.equal(await interactions.ask('approval', { agent: { ...agent }, toolName: 'bash' }, async () => { delegated = true; return 'rejected'; }), 'rejected');
  assert.equal(delegated, true);
  const question = interactions.ask('question', { agent, questions }, noProvider);
  interactions.dispose(); await assert.rejects(() => question, /Plugin stopped/);
});

test('continued timed questions are rebuilt from durable projection and answered via native Remote', async t => {
  const { interactions, projection, calls } = fixture(t);
  projection({ values: { userQuestions: { active: [{ callId: 'timed', state: 'continued', questions }] } } });
  await interactions.refresh([{ sessionId: 'a', archived: false, readable: true }]);
  const [wire] = interactions.snapshot();
  await interactions.answer({ token: wire.token, sessionId: 'a', answer: { answers: [{ id: 'q', selected: ['A'] }] } });
  assert.equal(calls[0].namespace, 'userQuestions');
  assert.equal(calls[0].method, 'answer');
  assert.deepEqual(calls[0].args, { agentId: 'a', callId: 'timed', answer: { answers: [{ id: 'q', selected: ['A'] }] } });
  assert.equal(calls[1], 'flush');
});

test('timed wait transitions to continued without changing token or losing its answer window', async t => {
  const { interactions, agent, projection } = fixture(t);
  const timer = new AbortController();
  const pending = interactions.ask('question', { agent, questions, signal: timer.signal, wait: { timed: true, callId: 'timed-call' } }, noProvider);
  const [before] = interactions.snapshot();
  timer.abort(Object.assign(new Error('timeout'), { code: 'ASK_TIMED_OUT' }));
  assert.equal(interactions.snapshot().length, 1);
  await assert.rejects(() => pending, error => error.code === 'ASK_TIMED_OUT');
  await assert.rejects(() => interactions.answer({ token: before.token, sessionId: 'a', answer: { answers: [{ id: 'q', selected: ['A'] }] } }),
    error => error.code === 'QUESTION_NOT_READY');
  projection({ values: { userQuestions: { active: [{ callId: 'timed-call', state: 'continued', questions }] } } });
  await interactions.refresh([{ sessionId: 'a', readable: true, archived: false }]);
  assert.equal(interactions.snapshot()[0].token, before.token);
});

test('temporary projection read failure preserves continued card; authoritative settlement retires it', async t => {
  const { interactions, projection, adapter } = fixture(t);
  projection({ values: { userQuestions: { active: [{ callId: 'late', state: 'continued', questions }] } } });
  const sessions = [{ sessionId: 'a', readable: true, archived: false }];
  await interactions.refresh(sessions); const [before] = interactions.snapshot();
  const invoke = adapter.invoke;
  adapter.invoke = async () => { throw new Error('offline'); };
  await interactions.refresh(sessions); assert.equal(interactions.snapshot()[0].token, before.token);
  adapter.invoke = invoke; projection({ values: { userQuestions: { active: [] } } });
  await interactions.refresh(sessions); assert.equal(interactions.snapshot().length, 0);
});

test('late question answer validates labels, cardinality, custom text and missing IDs', () => {
  assert(validAnswer(questions, { answers: [{ id: 'q', selected: [] }] }));
  assert(validAnswer(questions, { answers: [{ id: 'q', selected: [], custom: 'Other' }] }));
  assert(!validAnswer(questions, { answers: [{ id: 'q', selected: ['A', 'B'] }] }));
  assert(!validAnswer(questions, { answers: [{ id: 'q', selected: ['unknown'] }] }));
  assert(!validAnswer(questions, { answers: [{ id: 'wrong', selected: [] }] }));
  assert(!validAnswer(questions, { answers: [{ id: 'q', selected: ['A'], custom: 'Other' }] }));
  assert(!validAnswer(questions, { answers: [{ id: 'q', selected: [], custom: '  ' }] }));
  assert(validAnswer([{ ...questions[0], multiSelect: true }], { answers: [{ id: 'q', selected: ['A', 'B'], custom: 'Other' }] }));
});
