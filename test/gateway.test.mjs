import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { Gateway, HarnessAdapter } from '../src/gateway.mjs';
import { Relay } from '../src/relay.mjs';

const row = (sessionId = 'a') => ({ sessionId, title: 'Title', archived: false, running: false, readable: true });
const event = (seq, type, data) => ({ type: 'event', event: { seq, type, data, surfaceOp: 'append' } });
const logger = { warn() {} };
function storeFor(t) { const store = new Store(); t.after(() => store.close()); return store; }

test('real DSH reason.kind completion is forwarded instead of silently skipped', async t => {
  for(const kind of ['completed','error','blocked','max-tokens']) {
    const store=storeFor(t); store.set('initial:sessions',[]);
    const adapter={page:async()=>({cursor:0,hasMore:false,records:[event(0,'turn/end',{turn:1,reason:{kind}})]})};
    await new Gateway({store,adapter,logger,notifyTurns:true}).collect([row()]);
    assert.equal(store.pending('outgoing').length,1,kind);
    assert.equal(store.pending('outgoing')[0].payload.reason,kind);
  }
});

test('enabled gateway forwards terminal events durably once and never backfills old completions', async t => {
  const store=storeFor(t);
  store.set('initial:sessions',[]);
  const adapter={page:async()=>({cursor:0,hasMore:false,records:[event(0,'turn/end',{reason:'completed'})]})};
  const gateway=new Gateway({store,adapter,logger,notifyTurns:true});
  await gateway.collect([row()]); await gateway.collect([row()]);
  assert.equal(store.pending('outgoing').length,1);
  assert.deepEqual(store.pending('outgoing')[0].payload,{id:'a:0',sessionId:'a',seq:0,type:'turn/end',reason:'completed'});
  const baseline=storeFor(t);
  await new Gateway({store:baseline,adapter,logger,notifyTurns:true}).collect([row()]);
  assert.equal(baseline.pending('outgoing').length,0);
});

test('existing history is baselined; new durable messages are forwarded exactly once across retries', async t => {
  const store = storeFor(t);
  let records = [event(0, 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'old' }] })];
  let fail = true;
  const received = [];
  const adapter = {
    inventory: async () => [row()],
    page: async () => ({ cursor: records.length - 1, records, hasMore: false }),
    content: async content => content,
  };
  const client = { exchange: async payload => {
    received.push(payload);
    if (fail) throw new Error('offline');
    return { accepted: payload.events.map(e => e.id), commands: [] };
  } };
  const gateway = new Gateway({ store, adapter, client, logger });
  await assert.rejects(() => gateway.tick());
  assert.equal(store.get('cursor:a'), 0);
  records.push(event(1, 'assistant/message', { message: { content: [{ type: 'text', text: 'answer' }] } }));
  await assert.rejects(() => gateway.tick());
  assert.equal(store.pending('outgoing').length, 1);
  fail = false; await gateway.tick(); await gateway.tick();
  assert.equal(received.at(-2).events[0].content[0].text, 'answer');
  assert.equal(received.at(-1).events.length, 0);
  assert.equal(store.pending('outgoing').length, 0);
});

test('tool-only assistant messages do not build a delivery backlog or delay approval context', async t => {
  const store = storeFor(t); store.set('initial:sessions', []);
  const records = Array.from({ length: 740 }, (_, seq) => event(seq, 'assistant/message', { message: { content: [] } }));
  records.push(event(740, 'assistant/message', { message: { content: [{ type: 'text', text: 'Before approval' }] } }));
  const sent = [];
  const gateway = new Gateway({ store, logger,
    adapter: { inventory: async () => [row()], page: async () => ({ cursor: 740, hasMore: false, records }), content: async x => x },
    client: { exchange: async payload => { sent.push(payload); return { accepted: payload.events.map(e => e.id), commands: [] }; } },
  });
  await gateway.tick();
  assert.deepEqual(sent[0].events.map(e => e.seq), [740]);
  assert.equal(store.get('cursor:a'), 740);
  assert.equal(store.pending('outgoing').length, 0);
});

test('backlog drains promptly and an approval waits for all preceding context across batches', async t => {
  const store = storeFor(t); store.set('initial:sessions', []);
  for (let seq = 0; seq < 251; seq++) store.enqueue(`a:${seq}`, 'outgoing', {
    id: `a:${seq}`, sessionId: 'a', seq, type: 'assistant/message', content: [{ type: 'text', text: String(seq) }],
  });
  const snapshots = [];
  const request = { token: 'abcdefghijklmnopqrst', sessionId: 'a', kind: 'approval', toolName: 'write' };
  const gateway = new Gateway({ store, logger,
    adapter: { inventory: async () => [row()], page: async () => ({ cursor: -1, hasMore: false, records: [] }) },
    interactions: { snapshot: () => [request], refresh: async () => {} },
    client: { exchange: async payload => { snapshots.push(payload); return { accepted: payload.events.map(e => e.id), commands: [] }; } },
  });
  assert.equal(await gateway.tick(), true);
  assert.equal(await gateway.tick(), true);
  assert.equal(await gateway.tick(), false);
  assert.deepEqual(snapshots.map(p => p.events.length), [100, 100, 51]);
  assert.deepEqual(snapshots.map(p => p.interactions.length), [0, 0, 1]);
});

test('lost exchange response and new backlog cannot expire an already announced approval', async t => {
  const store = storeFor(t); store.set('initial:sessions', []);
  const relayStore = storeFor(t);
  const relay = new Relay({ store: relayStore, telegram: {}, ownerId: 42, logger });
  const request = { token: 'abcdefghijklmnopqrst', sessionId: 'a', kind: 'approval', toolName: 'write' };
  const enqueue = seq => store.enqueue(`a:${seq}`, 'outgoing', {
    id: `a:${seq}`, sessionId: 'a', seq, type: 'assistant/message', content: [{ type: 'text', text: String(seq) }],
  });
  for (let seq = 0; seq < 100; seq++) enqueue(seq);
  let loseResponse = true;
  const gateway = new Gateway({ store, logger,
    adapter: { inventory: async () => [row()], page: async () => ({ cursor: -1, hasMore: false, records: [] }) },
    interactions: { snapshot: () => [request], refresh: async () => {} },
    client: { exchange: async payload => {
      const result = relay.exchange('local', payload);
      if (loseResponse) { loseResponse = false; throw new Error('response lost'); }
      return result;
    } },
  });
  await assert.rejects(() => gateway.tick(), /response lost/);
  assert.equal(relayStore.get(`interaction:${request.token}`).status, 'pending');
  enqueue(100);
  await gateway.tick();
  assert.equal(relayStore.get(`interaction:${request.token}`).status, 'pending');
  await gateway.tick();
  assert.equal(relayStore.get(`interaction:${request.token}`).status, 'pending');
});

test('persisted empty jobs retire safely and missing ACK progress does not cause a busy loop', async t => {
  const store = storeFor(t); store.set('initial:sessions', []);
  store.enqueue('a:0', 'outgoing', { id: 'a:0', sessionId: 'a', seq: 0, type: 'assistant/message', content: [] });
  store.enqueue('a:1', 'outgoing', { id: 'a:1', sessionId: 'a', seq: 1, type: 'assistant/message', content: [{ type: 'text', text: 'visible' }] });
  const gateway = new Gateway({ store, logger,
    adapter: { inventory: async () => [row()], page: async () => ({ cursor: -1, hasMore: false, records: [] }) },
    client: { exchange: async payload => { assert.deepEqual(payload.events.map(e => e.seq), [1]); return { accepted: [], commands: [] }; } },
  });
  await gateway.tick();
  assert.equal(store.job('a:0').status, 'done');
  assert.equal(await gateway.tick(), false);
  gateway.client.exchange = async () => { throw new Error('offline'); };
  await assert.rejects(() => gateway.tick(), /offline/);
  assert.equal(store.job('a:1').status, 'pending');
});

test('sessions created after initial baseline include their first prompt; pagination pins cut', async t => {
  const store = storeFor(t);
  store.set('initial:sessions', ['a']);
  const calls = [];
  const gateway = new Gateway({ store, logger, adapter: {
    page: async (_id, options) => {
      calls.push(options);
      return options.beforeSeq === undefined
        ? { cursor: 3, hasMore: true, records: [event(2, 'step/start', {}), event(3, 'assistant/message', { message: { content: [{ type: 'text', text: 'reply' }] } })] }
        : { cursor: 3, hasMore: false, records: [event(0, 'turn/start', {}), event(1, 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'first' }] })] };
    },
    content: async x => x,
  } });
  await gateway.collect([row('new')]);
  assert.deepEqual(calls, [{}, { throughSeq: 3, beforeSeq: 2 }]);
  assert.deepEqual(store.pending('outgoing').map(j => j.payload.seq), [1, 3]);
  assert.equal(store.get('cursor:new'), 3);
});

test('failed attachment serialization preserves cursor for replay instead of silently losing message', async t => {
  const store = storeFor(t);
  store.set('initial:sessions', []);
  const gateway = new Gateway({ store, logger, adapter: {
    page: async () => ({ cursor: 1, hasMore: false, records: [event(0, 'turn/start', {}),
      event(1, 'user/message', { source: { kind: 'user' }, content: [{ type: 'image' }] })] }),
    content: async () => { throw new Error('missing bytes'); },
  } });
  await gateway.collect([row()]);
  assert.equal(store.get('cursor:a'), 0);
  assert.equal(store.pending('outgoing').length, 0);
});

test('Host inventory uses full sessionQuery, not only attached/cwd sessions; archive and running are separate', async t => {
  let disposed = false;
  const ctx = {
    connection: { createPeer: () => ({ dispose: () => { disposed = true; } }) },
    sessionQuery: { listSessions: async () => [{ header: { id: 'a' } }, { header: { id: 'cold' } }, { header: { id: 'child', origin: 'subagent' } }] },
    workspaceRegistry: { archivedSessionIds: ['cold'] },
    agents: { get: id => id === 'a' ? { status: 'running' } : undefined },
    typertGateway: { invoke: async request => {
      assert.equal(request.namespace, 'session'); assert.equal(request.method, 'list'); assert.deepEqual(request.args, { _request: {} });
      return { items: [{ sessionId: 'a', blank: true, projections: { values: { title: 'Known title' } } }] };
    } },
  };
  const adapter = new HarnessAdapter(ctx);
  const inventory = await adapter.inventory();
  assert.equal(inventory.length, 2);
  assert.equal(inventory[0].title, 'Known title'); assert.equal(inventory[0].running, true);
  assert.equal(inventory[1].archived, true);
  assert.equal(inventory[0].blank, true);
  assert.equal(inventory[1].blank, false);
  await adapter.close(); assert.equal(disposed, true);
});

function hostContext() {
  const calls = [];
  const ctx = {
    connection: { createPeer: () => ({ dispose() {} }) },
    workspaceRegistry: { archivedSessionIds: [] },
    sessions: { get: () => ({ id: 'a' }), flush: async () => { calls.push({ method: 'flush' }); } },
    fileUploads: { uploadStream: async request => {
      const chunks = []; for await (const chunk of request.data) chunks.push(chunk);
      calls.push({ method: 'upload', bytes: Buffer.concat(chunks), name: request.name });
      return { receiptId: 'receipt' };
    } },
    typertGateway: { invoke: async request => { calls.push(request); return { accepted: true }; } },
  };
  return { ctx, calls };
}
const command = extra => ({ id: 'input:1', sessionId: 'a', requestId: 'tg-sync:42:10', correctionId: 'tg-sync:edit:11',
  content: [{ type: 'text', text: 'hello' }], ...extra });

test('generic files use real upload receipt contract; prompt request id is stable and flushed before ack', async t => {
  const store = storeFor(t), { ctx, calls } = hostContext();
  const adapter = new HarnessAdapter(ctx);
  await adapter.submit(command({ content: [{ type: 'file', name: 'audio.ogg', data: Buffer.from('exact bytes').toString('base64') }] }), store);
  assert.equal(calls[0].bytes.toString(), 'exact bytes');
  assert.deepEqual(calls[1].args.request.content, [{ type: 'file', receiptId: 'receipt' }]);
  assert.equal(calls[1].args.request.requestId, 'tg-sync:42:10');
  assert.equal(calls[2].method, 'flush');
});

test('edits update only pending text; committed messages become explicit corrections with new id', async t => {
  const store = storeFor(t), { ctx, calls } = hostContext();
  let pending = true;
  ctx.typertGateway.invoke = async request => {
    calls.push(request);
    if (request.method === 'state') return { queue: pending ? [{ id: 'queue-item', rpcId: 'tg-sync:42:10' }] : [] };
    return { accepted: true };
  };
  const adapter = new HarnessAdapter(ctx);
  await adapter.submit(command({ edit: true }), store);
  assert.equal(calls[1].method, 'updateQueue');
  assert.equal(calls[1].args.request.itemId, 'queue-item');
  const length = calls.length;
  await adapter.submit(command({ edit: true }), store); assert.equal(calls.length, length);
  pending = false;
  await adapter.submit(command({ id: 'input:2', edit: true }), store);
  const prompt = calls.find(c => c.method === 'prompt');
  assert.equal(prompt.args.request.requestId, 'tg-sync:edit:11');
  assert.match(prompt.args.request.content[0].text, /Исправление/);
});

test('archive fence rejects inbound without running a model or copying files', async t => {
  const store = storeFor(t), { ctx, calls } = hostContext();
  ctx.workspaceRegistry.archivedSessionIds = ['a'];
  await assert.rejects(() => new HarnessAdapter(ctx).submit(command(), store), /archived/);
  assert.equal(calls.length, 0);
});
