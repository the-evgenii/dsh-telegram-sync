import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, sessionKey } from '../src/store.mjs';
import { Relay } from '../src/relay.mjs';
import { Telegram } from '../src/telegram.mjs';
import { InteractionRelay } from '../src/interaction-relay.mjs';

const token = 'abcdefghijklmnopQRSTUV';
const second = '0123456789abcdefQRSTUV';
const question = (id, extra = {}) => ({ id, question: `Question ${id}`, options: [{ label: 'A' }, { label: 'B' }], ...extra });
const request = (questions = [question('one')], extra = {}) => ({ token, sessionId: 's', kind: 'question', questions, ...extra });
const approval = extra => ({ token, sessionId: 's', kind: 'approval', toolName: 'bash', reason: 'Run command?', details: 'echo safe', ...extra });

// This adapter is the proposed wiring, without changing the production Relay.
class WiredRelay extends Relay {
  constructor(options) { super(options); this.interactions = new InteractionRelay(this); }
  async perform(job, row) {
    if (job.payload.op === 'interaction') return this.interactions.perform(job, row);
    return super.perform(job, row);
  }
  async receive() {
    for (const job of this.store.pending('incoming', this.now(), 20)) {
      if (job.payload.callback_query) {
        await this.interactions.callback(job.payload);
        this.store.status(job.id, 'done');
      }
    }
    return super.receive();
  }
}

async function fixture(t, options = {}) {
  const calls = [];
  const handlers = new Map();
  let messageId = 800;
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const payload = JSON.parse(raw);
    const method = req.url.split('/').at(-1);
    calls.push({ method, payload });
    if (handlers.has(method)) return handlers.get(method)(res, payload);
    const result = method === 'sendMessage' ? { message_id: ++messageId }
      : method === 'editMessageText' ? { message_id: payload.message_id } : true;
    res.end(JSON.stringify({ ok: true, result }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const path = options.path ?? ':memory:';
  let store = new Store(path);
  let now = 1000;
  const telegram = new Telegram({ token: 'LOCAL_FAKE_ONLY', baseUrl: `http://127.0.0.1:${server.address().port}` });
  let relay = new WiredRelay({ store, telegram, ownerId: 42, notifications: options.notifications, now: () => now, logger: { warn() {} } });
  const key = sessionKey('g', 's');
  const row = { key, gatewayId: 'g', sessionId: 's', title: 'Test', topic: 100, epoch: 0, archived: false, deleted: false };
  if (!store.get(`session:${key}`)) store.set(`session:${key}`, row);
  t.after(() => store.close());
  let revision = 0;
  let updateId = 0;
  const api = {
    calls, handlers, key, telegram,
    get store() { return store; }, get relay() { return relay; }, get interactions() { return relay.interactions; },
    state: (value = token) => store.get(`interaction:${value}`),
    snapshot(values, gateway = 'g', rev = ++revision) {
      store.transaction(() => relay.interactions.reconcile(gateway, values, rev));
    },
    deliver: () => relay.deliver(),
    time: value => { now = value; },
    card: () => calls.filter(c => ['sendMessage', 'editMessageText'].includes(c.method) && c.payload.reply_markup).at(-1)?.payload,
    button(label) { return this.card().reply_markup.inline_keyboard.flat().find(b => b.text === label)?.callback_data; },
    async click(data, patch = {}) {
      const state = api.state();
      const query = { id: `cb${++updateId}`, from: { id: 42 }, data,
        message: { chat: { id: 42, type: 'private' }, message_id: state.messageId, message_thread_id: 100 }, ...patch };
      relay.ingest([{ update_id: updateId, callback_query: query }]);
      await relay.receive();
    },
    text(text, extra = {}) { return relay.interactions.text({ message_id: ++updateId, from: { id: 42 },
      chat: { id: 42, type: 'private' }, message_thread_id: 100, text, ...extra }); },
    restart() {
      store.close(); store = new Store(path);
      relay = new WiredRelay({ store, telegram, ownerId: 42, notifications: options.notifications, now: () => now, logger: { warn() {} } });
    },
  };
  return api;
}

test('quiet policy keeps question and approval action cards audible but long context silent', async t => {
  for(const kind of ['question','approval']) {
    const f=await fixture(t,{notifications:{silentMessages:true,questions:true}});
    f.snapshot([kind==='approval' ? approval({details:'long '.repeat(1200)})
      : request([question('one',{detail:'long '.repeat(1200)})])]);
    await f.deliver();
    const sends=f.calls.filter(c=>c.method==='sendMessage');
    assert.ok(sends.length>1);
    assert.equal(sends.at(-1).payload.disable_notification,false);
    for(const send of sends.slice(0,-1)) assert.equal(send.payload.disable_notification,true);
  }
});

test('real queued send, sequential single choices, callback ACK failure cannot lose answer', async t => {
  const f = await fixture(t);
  f.snapshot([request([question('one'), question('two')])]);
  await f.deliver();
  assert.equal(f.state().messageId, 801);
  assert.equal(f.store.get('receipt:interaction:abcdefghijklmnopQRSTUV:1:card').message_id, 801);
  const stale = f.button('A');
  await f.click(stale);
  assert.equal(f.state().index, 1);
  await f.click(stale);
  assert.equal(f.state().index, 1);
  await f.deliver();
  assert.equal(f.calls.filter(c => c.method === 'sendMessage').length, 1);
  assert.match(f.card().text, /Вопрос 2\/2/);
  f.handlers.set('answerCallbackQuery', res => res.end(JSON.stringify({ ok: false, error_code: 500 })));
  await f.click(f.button('B'));
  const job = f.store.job(`answer:${token}`);
  assert.equal(job.lane, 'gateway:g');
  assert.deepEqual(job.payload, { kind: 'interaction-answer', key: f.key, sessionId: 's', token,
    answer: { answers: [{ id: 'one', selected: ['A'] }, { id: 'two', selected: ['B'] }] } });
  await f.deliver();
  assert.equal(f.calls.at(-1).method, 'editMessageReplyMarkup');
  assert.deepEqual(f.calls.at(-1).payload.reply_markup, { inline_keyboard: [] });
  await f.click(stale);
  assert.equal(f.store.pending('gateway:g').length, 1);
});

test('pagination, versioned multi-select, toggle and skip', async t => {
  const f = await fixture(t);
  const options = Array.from({ length: 14 }, (_, i) => ({ label: `Option ${i}`, description: `Terms ${i}` }));
  f.snapshot([request([question('multi', { multiSelect: true, options }), question('skip')])]);
  await f.deliver();
  assert.equal(f.card().reply_markup.inline_keyboard.flat().filter(b => b.text.startsWith('Option')).length, 6);
  assert.match(f.card().text, /Terms 0/);
  for (const b of f.card().reply_markup.inline_keyboard.flat()) assert.ok(Buffer.byteLength(b.callback_data) <= 64);
  await f.click(f.button('Option 0')); await f.deliver();
  await f.click(f.button('✓ Option 0')); await f.deliver();
  assert.deepEqual(f.state().selected, []);
  await f.click(f.button('Option 1')); await f.deliver();
  const oldNav = f.button('→');
  await f.click(oldNav); await f.deliver();
  assert.equal(f.state().page, 1);
  await f.click(oldNav);
  assert.equal(f.state().page, 1);
  await f.click(f.button('Option 8')); await f.deliver();
  await f.click(f.button('→')); await f.deliver();
  assert.equal(f.state().page, 2);
  assert.equal(f.card().reply_markup.inline_keyboard.flat().filter(b => b.text.startsWith('Option')).length, 2);
  await f.click(f.button('←')); await f.deliver();
  await f.click(f.button('Готово')); await f.deliver();
  await f.click(f.button('Пропустить'));
  assert.deepEqual(f.store.job(`answer:${token}`).payload.answer.answers, [
    { id: 'multi', selected: ['Option 1', 'Option 8'] }, { id: 'skip', selected: [] },
  ]);
});

test('disk SQLite restart preserves nonce, card ID, selections, pagination and progress', async t => {
  const path = join(mkdtempSync(join(tmpdir(), 'interaction-relay-')), 'test.sqlite');
  const f = await fixture(t, { path });
  f.snapshot([request([question('multi', { multiSelect: true, options: 'ABCDEFGH'.split('').map(label => ({ label })) }), question('open', { options: [] })])]);
  await f.deliver();
  await f.click(f.button('A')); await f.deliver();
  await f.click(f.button('→')); await f.deliver();
  assert.equal(f.state().page, 1);
  const before = f.state();
  const done = f.button('Готово');
  f.restart();
  assert.deepEqual(f.state(), before);
  await f.click(done); await f.deliver();
  assert.equal(f.state().index, 1);
  assert.equal(await f.text('Custom answer'), true);
  assert.deepEqual(f.store.job(`answer:${token}`).payload.answer.answers, [
    { id: 'multi', selected: ['A'] }, { id: 'open', selected: [], custom: 'Custom answer' },
  ]);
  assert.equal(f.calls.filter(c => c.method === 'sendMessage').length, 1);
});

test('foreign owner/chat/type/message/topic, bot sender, nonce/version and forged action cannot answer', async t => {
  const f = await fixture(t);
  f.snapshot([approval()]); await f.deliver();
  const data = f.button('Разрешить один раз');
  const msg = { chat: { id: 42, type: 'private' }, message_id: f.state().messageId, message_thread_id: 100 };
  for (const patch of [
    { from: { id: 43 } }, { from: { id: 42, is_bot: true } },
    { message: { ...msg, chat: { id: 43, type: 'private' } } },
    { message: { ...msg, chat: { id: 42, type: 'supergroup' } } },
    { message: { ...msg, message_id: msg.message_id + 1 } },
    { message: { ...msg, message_thread_id: 101 } }, { message: undefined },
  ]) await f.click(data, patch);
  await f.click(data.replace(f.state().nonce, 'xxxxxxxx'));
  await f.click(data.replace(':1:', ':2:'));
  await f.click(data.replace(':allow', ':always'));
  await f.click(data.replace(':allow', ':o0'));
  assert.equal(f.store.pending('gateway:g').length, 0);
  assert.equal(f.state().version, 1);
  await f.click(data);
  assert.deepEqual(f.store.job(`answer:${token}`).payload.answer, { decision: 'allowed-once' });
});

test('approval fails closed offline, refresh reactivates only pending, reject is fixed decision', async t => {
  const f = await fixture(t);
  f.snapshot([approval()]); await f.deliver();
  assert.deepEqual(f.card().reply_markup.inline_keyboard.flat().map(b => b.text), ['Разрешить один раз', 'Отклонить']);
  assert.match(f.card().text, /bash[\s\S]*Run command\?[\s\S]*echo safe/);
  const data = f.button('Разрешить один раз');
  f.time(11_001);
  await f.click(data);
  assert.match(f.calls.at(-1).payload.text, /Шлюз недоступен/);
  assert.equal(f.store.pending('gateway:g').length, 0);
  f.snapshot([approval()], 'g', 1); // replay does not renew the heartbeat
  await f.click(data);
  assert.equal(f.store.pending('gateway:g').length, 0);
  f.snapshot([approval()]);
  await f.click(f.button('Отклонить'));
  assert.deepEqual(f.store.job(`answer:${token}`).payload.answer, { decision: 'rejected' });
  f.snapshot([approval()]);
  await f.click(data);
  assert.equal(f.state().status, 'answered');
});

test('authoritative disappearance clears keyboard and forbids resurrection/scope migration', async t => {
  const f = await fixture(t);
  f.snapshot([request()]); await f.deliver();
  const data = f.button('A');
  f.snapshot([]); await f.deliver();
  assert.equal(f.state().status, 'expired');
  assert.equal(f.calls.at(-1).method, 'editMessageReplyMarkup');
  f.snapshot([request()]); await f.deliver();
  await f.click(data);
  assert.equal(f.store.pending('gateway:g').length, 0);
  assert.equal(f.state().status, 'expired');
  assert.throws(() => f.snapshot([request()], 'other'), /scope/);
  assert.throws(() => f.snapshot([request(undefined, { sessionId: 'other' })]), /scope/);
  assert.throws(() => f.snapshot([request([question('changed')])]), /content/);
});

test('snapshot atomic validation, stale revisions and independent gateway namespaces', async t => {
  const f = await fixture(t);
  assert.throws(() => f.snapshot([request(), request()], 'g', 1), /Duplicate/);
  assert.equal(f.state(), null);
  assert.throws(() => f.snapshot([request(), { ...request(), token: 'bad' }], 'g', 1), /Invalid/);
  assert.equal(f.state(), null);
  const key = sessionKey('other', 's');
  f.store.set(`session:${key}`, { key, gatewayId: 'other', sessionId: 's', topic: 200 });
  f.snapshot([request()], 'g', 1);
  f.snapshot([request(undefined, { token: second })], 'other', 1);
  f.snapshot([], 'g', 1);
  assert.equal(f.state().status, 'pending');
  f.snapshot([], 'g', 2);
  assert.equal(f.state().status, 'expired');
  assert.equal(f.state(second).status, 'pending');
});

test('text single/multi custom contract, dedup, scope, ambiguity and open questions', async t => {
  const f = await fixture(t);
  f.snapshot([request([question('single'), question('multi', { multiSelect: true })])]); await f.deliver();
  assert.equal(await f.text('/help'), false);
  assert.equal(await f.text('foreign', { from: { id: 99 } }), false);
  assert.equal(await f.text('foreign', { message_thread_id: 101 }), false);
  assert.equal(await f.text('custom single', { message_id: 500 }), true); await f.deliver();
  assert.equal(await f.text('custom single', { message_id: 500 }), true);
  assert.equal(f.state().index, 1);
  await f.click(f.button('A')); await f.deliver();
  assert.equal(await f.text('extra'), true);
  assert.deepEqual(f.store.job(`answer:${token}`).payload.answer.answers, [
    { id: 'single', selected: [], custom: 'custom single' }, { id: 'multi', selected: ['A'], custom: 'extra' },
  ]);
  const f2 = await fixture(t);
  f2.snapshot([request([question('open', { options: [] })]), request([question('other', { options: [] })], { token: second })]);
  await f2.deliver();
  assert.equal(await f2.text('ambiguous'), false);
  assert.equal(f2.store.pending('gateway:g').length, 0);
});

test('expired answer is canceled before gateway delivery; terminal callbacks have no effect', async t => {
  const f = await fixture(t);
  f.snapshot([request()]); await f.deliver();
  await f.click(f.button('A'));
  f.snapshot([]);
  assert.equal(f.store.job(`answer:${token}`).status, 'failed');
  assert.equal(f.store.pending('gateway:g').length, 0);
});

test('all long approval details and question conditions are sent before actionable card', async t => {
  const f = await fixture(t);
  const details = `${'опасные условия '.repeat(1000)}END OF CONDITIONS`;
  f.snapshot([approval({ details })]); await f.deliver();
  const sends = f.calls.filter(c => c.method === 'sendMessage');
  assert.ok(sends.length > 2);
  assert.ok(sends.slice(0, -1).every(c => !c.payload.reply_markup));
  const combined = sends.map(c => c.payload.text.replace('Подробности выше.\n\n', '')).join('');
  assert.equal(combined, `Подтверждение инструмента\n\nbash\n\nRun command?\n\n${details}`);
  assert.ok(sends.every(c => c.payload.text.length <= 4096));
  assert.ok(sends.at(-1).payload.reply_markup.inline_keyboard.flat().some(b => b.text === 'Разрешить один раз'));
  const f2 = await fixture(t);
  const condition = 'Условие '.repeat(900);
  f2.snapshot([request([question('long', { question: condition, options: [{ label: 'A', description: condition }], detail: 'PLAN DETAIL', intent: { kind: 'plan-review', approve: 'A' } })])]);
  await f2.deliver();
  const text = f2.calls.filter(c => c.method === 'sendMessage').map(c => c.payload.text).join('');
  assert.ok(text.includes('PLAN DETAIL'));
  assert.ok(text.includes(condition));
});

test('question detail metadata is delivered in full before question action buttons', async t => {
  const f = await fixture(t);
  const detail = 'Complete plan scope '.repeat(600) + 'FINAL CONDITION';
  f.snapshot([request([question('plan', { detail, intent: { kind: 'plan-review', approve: 'A' } })])]);
  await f.deliver();
  const sends = f.calls.filter(c => c.method === 'sendMessage');
  assert.ok(sends.length > 1);
  assert.ok(sends.slice(0, -1).every(c => !c.payload.reply_markup));
  const complete = sends.map(c => c.payload.text.replace('Подробности выше.\n\n', '')).join('');
  assert.ok(complete.includes(detail));
  assert.ok(sends.at(-1).payload.reply_markup.inline_keyboard.length > 0);
});

test('approval question intent offers only choices and forbids skip/custom text', async t => {
  const f = await fixture(t);
  const q = question('approval', { detail: 'Exact approval scope', intent: { kind: 'approval', approve: 'A', reject: 'B' } });
  f.snapshot([request([q])]); await f.deliver();
  assert.deepEqual(f.card().reply_markup.inline_keyboard.flat().map(b => b.text), ['A', 'B']);
  assert.ok(!f.card().text.includes('ответ текстом'));
  const data = f.button('A');
  await f.click(data.replace(/:o0$/, ':skip'));
  await f.click(data.replace(/:o0$/, ':done'));
  assert.equal(await f.text('approve'), true);
  assert.equal(f.store.pending('gateway:g').length, 0);
  assert.equal(f.state().version, 1);
  await f.click(data);
  assert.deepEqual(f.store.job(`answer:${token}`).payload.answer.answers, [{ id: 'approval', selected: ['A'] }]);
});

test('failure delivering full context cannot publish an approval button', async t => {
  const f = await fixture(t);
  f.snapshot([approval({ details: 'x'.repeat(9000) })]);
  f.handlers.set('sendMessage', res => res.end(JSON.stringify({ ok: false, error_code: 400 })));
  await f.deliver();
  assert.equal(f.state().messageId, undefined);
  assert.ok(f.calls.every(c => !c.payload.reply_markup));
  assert.equal(f.store.pending('gateway:g').length, 0);
});

test('invalid send receipt is uncertain; retry saved receipt never duplicates a card', async t => {
  const f = await fixture(t);
  f.snapshot([request()]);
  f.handlers.set('sendMessage', res => res.end(JSON.stringify({ ok: true, result: true })));
  await f.deliver();
  assert.equal(f.store.job(`interaction:${token}:1`).status, 'uncertain');
  assert.equal(f.state().messageId, undefined);
  const f2 = await fixture(t);
  f2.snapshot([request()]); await f2.deliver();
  const saved = f2.state();
  const { messageId, renderedVersion, ...interrupted } = saved;
  f2.store.set(`interaction:${token}`, interrupted);
  f2.store.status(`interaction:${token}:1`, 'pending');
  await f2.deliver();
  assert.equal(f2.state().messageId, messageId);
  assert.equal(f2.calls.filter(c => c.method === 'sendMessage').length, 1);
});

test('expiration after receipt/state crash gap still clears the exact orphaned card', async t => {
  const f = await fixture(t);
  f.snapshot([request()]); await f.deliver();
  const { messageId, renderedVersion, ...interrupted } = f.state();
  f.store.set(`interaction:${token}`, interrupted);
  f.snapshot([]); await f.deliver();
  assert.equal(f.state().messageId, messageId);
  assert.equal(f.calls.at(-1).method, 'editMessageReplyMarkup');
  assert.equal(f.calls.at(-1).payload.message_id, messageId);
  assert.equal(f.calls.filter(c => c.method === 'sendMessage').length, 1);
});

test('snapshot expiration during in-flight send saves exact receipt then clears late keyboard', async t => {
  const f = await fixture(t);
  f.snapshot([request()]);
  f.handlers.set('sendMessage', res => {
    f.snapshot([]);
    res.end(JSON.stringify({ ok: true, result: { message_id: 9876 } }));
  });
  await f.deliver();
  assert.equal(f.state().status, 'expired');
  assert.equal(f.state().messageId, 9876);
  assert.equal(f.calls.at(-1).method, 'editMessageReplyMarkup');
  assert.equal(f.calls.at(-1).payload.message_id, 9876);
  assert.equal(f.store.pending('gateway:g').length, 0);
});

test('topic replacement during full-context send cannot publish a button in stale topic', async t => {
  const f = await fixture(t);
  f.snapshot([approval({ details: 'x'.repeat(5000) })]);
  f.handlers.set('sendMessage', res => {
    const row = f.relay.session(f.key);
    f.store.set(`session:${f.key}`, { ...row, topic: 200 });
    res.end(JSON.stringify({ ok: true, result: { message_id: 111 } }));
  });
  await f.deliver();
  assert.equal(f.state().messageId, undefined);
  assert.ok(f.calls.every(c => !c.payload.reply_markup));
});

test('archived/deleted/replaced topic cannot answer even with exact old card', async t => {
  const f = await fixture(t);
  f.snapshot([approval()]); await f.deliver();
  const data = f.button('Разрешить один раз');
  const row = f.relay.session(f.key);
  for (const change of [{ archived: true }, { deleted: true }, { topic: 200 }]) {
    f.store.set(`session:${f.key}`, { ...row, ...change });
    await f.click(data);
    assert.equal(f.store.pending('gateway:g').length, 0);
  }
});
