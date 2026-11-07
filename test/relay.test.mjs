import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, sessionKey } from '../src/store.mjs';
import { Telegram, splitText } from '../src/telegram.mjs';
import { Relay } from '../src/relay.mjs';
import { RelayClient, createRelayServer, validateTransport } from '../src/server.mjs';
import { Gateway } from '../src/gateway.mjs';
import { GatewayInteractions } from '../src/interaction-gateway.mjs';

async function fakeTelegram(t) {
  const calls = [];
  let id = 100;
  const replies = new Map();
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const method = req.url.split('/').at(-1);
    const raw = Buffer.concat(chunks);
    const multipart = req.headers['content-type']?.startsWith('multipart/form-data');
    const payload = multipart ? raw.toString() : JSON.parse(raw.toString() || '{}');
    calls.push({ method, payload });
    const handler = replies.get(method);
    if (handler) return handler(req, res, payload);
    let result = true;
    if (method === 'createForumTopic') result = { message_thread_id: ++id, name: payload.name };
    if (method.startsWith('send') && method !== 'sendChatAction') result = { message_id: ++id, chat: { id: payload.chat_id }, date: 1 };
    if (method === 'editMessageText') result = { message_id: payload.message_id };
    if (method === 'getMe') result = { id: 50, is_bot: true, has_topics_enabled: true };
    if (method === 'getWebhookInfo') result = { url: '' };
    if (method === 'getUpdates') result = [];
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, result }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const telegram = new Telegram({ token: 'TEST_TOKEN', baseUrl: `http://127.0.0.1:${server.address().port}` });
  return { telegram, calls, replies };
}
const session = (sessionId = 'a', extra = {}) => ({ sessionId, title: 'Conversation', archived: false, running: false, ...extra });
const exchange = (relay, revision, sessions = [session()], extra = {}, gateway = 'local') => relay.exchange(gateway, { revision, sessions, ...extra });
const message = (topic, extra = {}) => ({ update_id: 1, message: { message_id: 10, message_thread_id: topic,
  chat: { id: 42, type: 'private' }, from: { id: 42 }, text: 'hello', ...extra } });
async function fixture(t, path, notifications) {
  const fake = await fakeTelegram(t);
  const store = new Store(path);
  t.after(() => store.close());
  const relay = new Relay({ store, telegram: fake.telegram, ownerId: 42, notifications, logger: { warn() {} } });
  return { ...fake, store, relay, row: () => relay.session(sessionKey('local', 'a')) };
}

test('real HTTP polling persists updates and offset; eyes follow durable enqueue', async t => {
  const { relay, store, replies, row, calls } = await fixture(t);
  await relay.verifyBot();
  exchange(relay, 1);
  await relay.deliver();
  replies.set('getUpdates', (_req, res) => res.end(JSON.stringify({ ok: true, result: [message(row().topic)] })));
  await relay.poll();
  assert.equal(store.get('telegram:offset'), 2);
  assert.equal(store.pending('incoming').length, 1);
  assert.equal(calls.filter(c => c.method === 'setMessageReaction').length, 0);
  await relay.receive();
  assert.equal(store.pending('gateway:local').length, 1);
  await relay.deliver();
  assert.deepEqual(calls.find(c => c.method === 'setMessageReaction').payload.reaction, [{ type: 'emoji', emoji: '👀' }]);
  relay.ingest([message(row().topic)]);
  assert.equal(store.pending('incoming').length, 0);
});

test('typing starts on accepted input without waiting for running inventory or timer, but not offline', async t => {
  const { relay, row, telegram, store } = await fixture(t);
  let now = 100; relay.now = () => now;
  exchange(relay, 1); await relay.deliver();
  const actions = [];
  const call = telegram.call.bind(telegram);
  telegram.call = (method, payload, ...args) => {
    if (method !== 'sendChatAction') return call(method, payload, ...args);
    actions.push(payload);
    return Promise.reject(new Error('ephemeral failure'));
  };
  relay.ingest([message(row().topic)]);
  await relay.receive();
  assert.deepEqual(actions, [{ chat_id: 42, message_thread_id: row().topic, action: 'typing' }]);
  assert.equal(store.pending('gateway:local').length, 1);
  now += 11_000;
  relay.ingest([{ ...message(row().topic), update_id: 2 }]);
  await relay.receive();
  assert.equal(actions.length, 1);
  assert.equal(store.pending('gateway:local').length, 2);
});

test('two gateways with identical session id have distinct topics and queues', async t => {
  const { relay, calls } = await fixture(t);
  exchange(relay, 1);
  exchange(relay, 1, [session()], {}, 'server');
  await relay.deliver();
  const local = relay.session(sessionKey('local', 'a'));
  const remote = relay.session(sessionKey('server', 'a'));
  assert.notEqual(local.topic, remote.topic);
  relay.ingest([message(local.topic), { ...message(remote.topic), update_id: 2 }]);
  await relay.receive();
  assert.equal(exchange(relay, 2).commands.length, 1);
  assert.equal(exchange(relay, 2, [session()], {}, 'server').commands.length, 1);
  assert.equal(calls.filter(c => c.method === 'createForumTopic').length, 2);
});

test('blank Host sessions create no Telegram topics until their first conversation', async t => {
  const { relay, row, calls } = await fixture(t);
  exchange(relay, 1, [session('a', { blank: true })]);
  await relay.deliver();
  assert.equal(row().topic, undefined);
  assert.equal(calls.filter(c => c.method === 'createForumTopic').length, 0);
  exchange(relay, 2, [session('a', { blank: false })]);
  await relay.deliver();
  const topic = row().topic;
  assert.ok(topic);
  exchange(relay, 3, [session('a', { blank: true })]);
  await relay.deliver();
  assert.equal(row().topic, topic);
  assert.equal(calls.filter(c => c.method === 'createForumTopic').length, 1);
  assert.equal(calls.filter(c => c.method === 'deleteForumTopic').length, 0);
});

test('first message after a blank inventory cut still creates its topic before delivery', async t => {
  const { relay, row, calls } = await fixture(t);
  exchange(relay, 1, [session('a', { blank: true })]); await relay.deliver();
  exchange(relay, 2, [session('a', { blank: true })], {
    events: [{ id: 'a:1', sessionId: 'a', seq: 1, type: 'assistant/message', content: [{ type: 'text', text: 'First message' }] }],
  });
  await relay.deliver();
  assert.ok(row().topic);
  assert.deepEqual(calls.filter(c => c.method === 'sendMessage').map(c => c.payload.text), ['First message']);
});

test('archive removes topic; restore makes a new empty topic; authoritative deletion removes it', async t => {
  const { relay, row, calls } = await fixture(t);
  exchange(relay, 1); await relay.deliver();
  const first = row().topic;
  exchange(relay, 2, [session('a', { archived: true })]); await relay.deliver();
  assert.equal(row().topic, null);
  exchange(relay, 3); await relay.deliver();
  assert.notEqual(row().topic, first);
  const restored = row().topic;
  exchange(relay, 4, []); await relay.deliver();
  assert.equal(row().deleted, true);
  assert.deepEqual(calls.filter(c => c.method === 'deleteForumTopic').map(c => c.payload.message_thread_id), [first, restored]);
  assert.equal(calls.filter(c => c.method === 'sendMessage').length, 0);
});

test('rapid archive + restore is not coalesced into keeping the old topic', async t => {
  const { relay, row } = await fixture(t);
  exchange(relay, 1); await relay.deliver(); const first = row().topic;
  exchange(relay, 2, [session('a', { archived: true })]);
  exchange(relay, 3);
  await relay.deliver();
  assert.notEqual(row().topic, first);
});

test('stale inventories and disconnects cannot delete sessions; typing expires offline', async t => {
  const { relay, row, calls } = await fixture(t);
  let now = 100; relay.now = () => now;
  exchange(relay, 2, [session('a', { running: true })]); await relay.deliver();
  exchange(relay, 1, []); assert.equal(row().deleted, false);
  await relay.typing(); now += 11_000; await relay.typing();
  assert.equal(calls.filter(c => c.method === 'sendChatAction').length, 1);
  assert.equal(calls.filter(c => c.method === 'deleteForumTopic').length, 0);
});

test('foreign users, wrong chat, unknown topics and service updates never reach Harness', async t => {
  const { relay, row, store } = await fixture(t);
  exchange(relay, 1); await relay.deliver();
  relay.ingest([
    message(row().topic, { from: { id: 999 } }),
    { ...message(row().topic, { chat: { id: -42, type: 'supergroup' } }), update_id: 2 },
    { ...message(999), update_id: 3 },
    { ...message(row().topic, { text: undefined, forum_topic_edited: { name: 'x' } }), update_id: 4 },
  ]);
  await relay.receive();
  assert.equal(store.pending('gateway:local').length, 0);
});

test('preceding commentary is sent before its approval, including a rate-limited retry', async t => {
  const { relay, calls, replies } = await fixture(t);
  let now = 100; relay.now = () => now;
  exchange(relay, 1); await relay.deliver();
  exchange(relay, 2, [session()], {
    events: [{ id: 'a:1', sessionId: 'a', seq: 1, type: 'assistant/message', content: [{ type: 'text', text: 'Before approval' }] }],
    interactions: [{ token: 'abcdefghijklmnopqrst', sessionId: 'a', kind: 'approval', toolName: 'write', reason: 'Allow test?' }],
  });
  replies.set('sendMessage', (_req, res, payload) => {
    if (payload.text === 'Before approval') return res.end(JSON.stringify({ ok: false, error_code: 429, parameters: { retry_after: 1 } }));
    res.end(JSON.stringify({ ok: true, result: { message_id: 900 } }));
  });
  await relay.deliver();
  assert.equal(calls.filter(c => c.method === 'sendMessage' && c.payload.reply_markup?.inline_keyboard?.length).length, 0);
  replies.delete('sendMessage'); now += 1001;
  await relay.deliver();
  const sent = calls.filter(c => c.method === 'sendMessage').map(c => c.payload.text);
  assert.equal(sent[0], 'Before approval');
  assert.equal(sent[1], 'Before approval');
  assert.match(sent[2], /Подтверждение инструмента/);
});

test('old definitive message failure cannot permanently block a new complete approval card', async t => {
  const { relay, store, calls, replies } = await fixture(t);
  exchange(relay, 1); await relay.deliver();
  replies.set('sendMessage', (_req, res) => res.end(JSON.stringify({ ok: false, error_code: 403 })));
  exchange(relay, 2, [session()], {
    events: [{ id: 'a:1', sessionId: 'a', seq: 1, type: 'assistant/message', content: [{ type: 'text', text: 'Old failed message' }] }],
  });
  await relay.deliver();
  const failed = store.db.prepare("SELECT id FROM jobs WHERE status='failed' AND json_extract(payload,'$.event.seq')=1").get();
  assert.ok(failed);
  replies.delete('sendMessage');
  exchange(relay, 3, [session()], {
    events: [{ id: 'a:2', sessionId: 'a', seq: 2, type: 'assistant/message', content: [{ type: 'text', text: 'Current context' }] }],
    interactions: [{ token: 'abcdefghijklmnopqrst', sessionId: 'a', kind: 'approval', toolName: 'plugin_manager', reason: 'Allow one exact operation?', details: '{"action":"list_bundles"}' }],
  });
  await relay.deliver();
  const sent = calls.filter(c => c.method === 'sendMessage').map(c => c.payload.text);
  assert.equal(sent.filter(text => text === 'Old failed message').length, 1);
  assert.equal(sent[1], 'Current context');
  assert.match(sent[2], /Allow one exact operation/);
  assert.match(sent[2], /list_bundles/);
  assert.equal(store.job(failed.id).status, 'failed');
});

test('outgoing user/assistant messages are deduplicated; internal context and own echo are suppressed', async t => {
  const { relay, calls } = await fixture(t);
  const events = [
    { id: 'a:1', sessionId: 'a', seq: 1, type: 'user/message', source: { kind: 'user' }, content: [{ type: 'text', text: 'web' }] },
    { id: 'a:2', sessionId: 'a', seq: 2, type: 'assistant/message', content: [{ type: 'text', text: 'answer' }] },
    { id: 'a:3', sessionId: 'a', seq: 3, type: 'user/message', source: { kind: 'user', rpcId: 'tg-sync:42:5' }, content: [{ type: 'text', text: 'echo' }] },
    { id: 'a:4', sessionId: 'a', seq: 4, type: 'user/message', source: { kind: 'schedule' }, content: [{ type: 'text', text: 'secret context' }] },
  ];
  exchange(relay, 1, [session()], { events }); await relay.deliver();
  exchange(relay, 2, [session()], { events }); await relay.deliver();
  assert.deepEqual(calls.filter(c => c.method === 'sendMessage').map(c => c.payload.text), ['Вы: web', 'answer']);
});

test('uncertain send never retries and uncertain create blocks dependent messages', async t => {
  const { relay, replies, calls, store } = await fixture(t);
  replies.set('createForumTopic', (req) => req.socket.destroy());
  exchange(relay, 1, [session()], { events: [{ id: 'a:1', sessionId: 'a', seq: 1, type: 'assistant/message', content: [{ type: 'text', text: 'answer' }] }] });
  await relay.deliver(); await relay.deliver();
  assert.equal(calls.filter(c => c.method === 'createForumTopic').length, 1);
  assert.equal(calls.filter(c => c.method === 'sendMessage').length, 0);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM jobs WHERE status='uncertain'").get().n, 1);
});

test('definite deletion failure blocks restore instead of duplicating/replaying business input', async t => {
  const { relay, row, replies, calls } = await fixture(t);
  exchange(relay, 1); await relay.deliver(); const first = row().topic;
  replies.set('deleteForumTopic', (_req, res) => res.end(JSON.stringify({ ok: false, error_code: 403 })));
  exchange(relay, 2, [session('a', { archived: true })]); await relay.deliver();
  exchange(relay, 3); await relay.deliver();
  assert.equal(row().topic, first);
  assert.equal(calls.filter(c => c.method === 'createForumTopic').length, 1);
});

test('rate limiting retains durable task and retries after deadline only', async t => {
  const { relay, replies, calls } = await fixture(t);
  let now = 100; relay.now = () => now;
  replies.set('createForumTopic', (_req, res) => res.end(JSON.stringify({ ok: false, error_code: 429, parameters: { retry_after: 3 } })));
  exchange(relay, 1); await relay.deliver(); await relay.deliver();
  assert.equal(calls.length, 1);
  replies.delete('createForumTopic'); now += 3001; await relay.deliver(); assert.equal(calls.length, 2);
});

test('SQLite queue, offsets and topic mapping survive restart; half-sent tasks become uncertain', async t => {
  const path = join(mkdtempSync(join(tmpdir(), 'dsh-sync-')), 'state.sqlite');
  const fake = await fakeTelegram(t);
  let store = new Store(path);
  let relay = new Relay({ store, telegram: fake.telegram, ownerId: 42 });
  exchange(relay, 1); await relay.deliver(); const topic = relay.session(sessionKey('local', 'a')).topic;
  relay.ingest([message(topic)]); await relay.receive();
  store.enqueue('half-sent', 'telegram', { op: 'notice', key: sessionKey('local', 'a'), text: 'x' });
  store.status('half-sent', 'sending'); store.close();
  store = new Store(path); t.after(() => store.close());
  relay = new Relay({ store, telegram: fake.telegram, ownerId: 42 });
  assert.equal(relay.session(sessionKey('local', 'a')).topic, topic);
  assert.equal(store.get('telegram:offset'), 2);
  assert.equal(store.pending('gateway:local').length, 1);
  assert.equal(store.job('half-sent').status, 'uncertain');
  await relay.deliver();
  assert.equal(fake.calls.filter(c => c.method === 'createForumTopic').length, 1);
});

test('real relay HTTP endpoint scopes tokens to one gateway and client rejects plaintext remote URLs', async t => {
  const { relay } = await fixture(t);
  const token = 'local-'.padEnd(40, 'x'), other = 'server-'.padEnd(40, 'y');
  const server = createRelayServer({ relay, gateways: { local: token, server: other } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const good = new RelayClient({ url, gatewayId: 'local', token });
  await good.exchange({ revision: 1, sessions: [session()] });
  const bad = new RelayClient({ url, gatewayId: 'server', token });
  await assert.rejects(() => bad.exchange({ revision: 1, sessions: [] }), /exchange failed/);
  assert.equal(relay.session(sessionKey('server', 'a')), null);
  assert.throws(() => validateTransport('http://remote.example'), /HTTPS/);
  assert.throws(() => validateTransport('https://name:secret@example.com'), /credentials/);
});

test('voice and image downloads preserve bytes; outgoing files use multipart, not leaked paths', async t => {
  const { relay, row, replies, calls, store } = await fixture(t);
  const bytes = Buffer.from([0, 255, 10, 128]);
  replies.set('getFile', (_req, res) => res.end(JSON.stringify({ ok: true, result: { file_path: 'documents/file.bin', file_size: bytes.length } })));
  replies.set('file.bin', (_req, res) => res.end(bytes));
  exchange(relay, 1); await relay.deliver();
  relay.ingest([message(row().topic, { text: undefined, voice: { file_id: 'voice-id', mime_type: 'audio/ogg' } })]);
  await relay.receive();
  const input = store.pending('gateway:local')[0].payload.content[0];
  assert.equal(input.type, 'file');
  assert.deepEqual(Buffer.from(input.data, 'base64'), bytes);
  exchange(relay, 2, [session()], { events: [{ id: 'a:1', sessionId: 'a', seq: 1, type: 'assistant/message',
    content: [{ type: 'file', name: 'result.bin', data: bytes.toString('base64') }] }] });
  await relay.deliver();
  const uploaded = calls.find(c => c.method === 'sendDocument');
  assert.match(uploaded.payload, /filename="result.bin"/);
  assert.match(uploaded.payload, /name="message_thread_id"/);
  assert(!uploaded.payload.includes('/Users/'));
});

test('temporary file-download failures retain incoming job and do not falsely react with eyes', async t => {
  const { relay, row, replies, store, calls } = await fixture(t);
  exchange(relay, 1); await relay.deliver();
  replies.set('getFile', req => req.socket.destroy());
  relay.ingest([message(row().topic, { text: undefined, document: { file_id: 'id', file_name: 'x' } })]);
  await relay.receive(); await relay.deliver();
  assert.equal(store.job('update:1').status, 'pending');
  assert.equal(store.pending('gateway:local').length, 0);
  assert.equal(calls.filter(c => c.method === 'setMessageReaction').length, 0);
});

test('completion alerts use the actual final answer, never a separate task-completed message', async t => {
  const {relay,calls}=await fixture(t,undefined,{silentMessages:true,completion:true});
  exchange(relay,1,[session()],{events:[
    {id:'a:1',sessionId:'a',seq:1,type:'assistant/message',content:[{type:'text',text:'Проверяю…'}]},
    {id:'a:2',sessionId:'a',seq:2,type:'assistant/message',content:[{type:'text',text:'Итоговый ответ'}]},
    {id:'a:3',sessionId:'a',seq:3,type:'turn/end',reason:'completed'},
  ]});
  await relay.deliver();
  const sends=calls.filter(c=>c.method==='sendMessage').map(c=>c.payload);
  assert.deepEqual(sends.map(p=>p.text),['Проверяю…','Итоговый ответ']);
  assert.deepEqual(sends.map(p=>p.disable_notification),[true,false]);
});

test('late completion never adds an empty footer after an already delivered answer', async t => {
  const {relay,calls}=await fixture(t,undefined,{silentMessages:true,completion:true});
  exchange(relay,1,[session()],{events:[{id:'a:1',sessionId:'a',seq:1,type:'assistant/message',content:[{type:'text',text:'Ответ'}]}]});
  await relay.deliver();
  exchange(relay,2,[session()],{events:[{id:'a:2',sessionId:'a',seq:2,type:'turn/end',reason:'completed'}]});
  await relay.deliver();
  assert.deepEqual(calls.filter(c=>c.method==='sendMessage').map(c=>c.payload.text),['Ответ']);
});

test('only the first chunk of a final answer alerts, not every chunk', async t => {
  const {relay,calls}=await fixture(t,undefined,{silentMessages:true,completion:true});
  exchange(relay,1,[session()],{events:[
    {id:'a:1',sessionId:'a',seq:1,type:'assistant/message',content:[{type:'text',text:'x'.repeat(9000)}]},
    {id:'a:2',sessionId:'a',seq:2,type:'turn/end',reason:'completed'},
  ]});
  await relay.deliver();
  const messages=calls.filter(c=>c.method==='sendMessage').map(c=>c.payload);
  assert.equal(messages.map(p=>p.text).join(''),'x'.repeat(9000));
  assert.deepEqual(messages.map(p=>p.disable_notification),[false,true,true]);
});

test('notification policy silences normal output but alerts for owner mentions and terminal turns', async t => {
  const { relay, calls, replies } = await fixture(t, undefined, { silentMessages: true, completion: true, mentions: true });
  replies.set('getChat', (_req,res) => res.end(JSON.stringify({ok:true,result:{id:42,type:'private',username:'owner_test'}})));
  await relay.verifyBot();
  const events=['обычный ответ','@owner_test, нужен ты','`@owner_test`'].map((text,i)=>({
    id:`a:${i+1}`,sessionId:'a',seq:i+1,type:'assistant/message',content:[{type:'text',text}]}));
  events.push({id:'a:4',sessionId:'a',seq:4,type:'turn/end',reason:'completed'},
    {id:'a:5',sessionId:'a',seq:5,type:'turn/end',reason:'failed'});
  exchange(relay,1,[session()],{events}); await relay.deliver();
  const messages=calls.filter(c=>c.method==='sendMessage').map(c=>c.payload);
  assert.equal(messages.length,4);
  assert.deepEqual(messages.map(p=>p.disable_notification),[true,false,false,false]);
  assert.ok(!messages.some(p=>p.text.includes('Задача в Harness завершена')));
  assert.match(messages[3].text,/ошибк/i);
});

test('quiet policy silences both document and photo uploads', async t => {
  const {relay,calls}=await fixture(t,undefined,{silentMessages:true});
  exchange(relay,1,[session()],{events:[{id:'a:1',sessionId:'a',seq:1,type:'assistant/message',content:[
    {type:'file',name:'test.txt',data:Buffer.from('test').toString('base64')},
    {type:'image',name:'test.jpg',data:'AA==',width:10,height:10},
  ]}]});
  await relay.deliver();
  const uploads=calls.filter(c=>['sendDocument','sendPhoto'].includes(c.method));
  assert.equal(uploads.length,2);
  for(const call of uploads) assert.match(call.payload,/name="disable_notification"\r\n\r\ntrue/);
});

test('mention introduced by an edit emits one separate alert, not one per subsequent edit', async t => {
  const {relay,calls}=await fixture(t,undefined,{silentMessages:true,mentions:true});
  relay.ownerUsername='owner_test';
  const first={id:'a:1',sessionId:'a',seq:1,type:'assistant/message',content:[{type:'text',text:'ordinary'}]};
  exchange(relay,1,[session()],{events:[first]}); await relay.deliver();
  for(const seq of [2,3]) {
    exchange(relay,seq,[session()],{events:[{...first,id:`a:${seq}`,seq,
      surfaceOp:{op:'replace',startSeq:seq-1,endSeq:seq-1},content:[{type:'text',text:`@owner_test, update ${seq}`}]}]});
    await relay.deliver();
  }
  const sends=calls.filter(c=>c.method==='sendMessage');
  assert.equal(sends.length,2);
  assert.equal(sends[0].payload.disable_notification,true);
  assert.equal(sends[1].payload.disable_notification,false);
  assert.match(sends[1].payload.text,/обновлённом/);
});

test('terminal turn events do not add alerts unless enabled', async t => {
  const { relay,calls }=await fixture(t);
  exchange(relay,1,[session()],{events:[{id:'a:1',sessionId:'a',seq:1,type:'turn/end',reason:'completed'}]});
  await relay.deliver();
  assert.equal(calls.filter(c=>c.method==='sendMessage').length,0);
});

test('assistant Markdown renders to Telegram entities on sends and replacements', async t => {
  const { relay, calls } = await fixture(t);
  const first = { id: 'a:1', sessionId: 'a', seq: 1, type: 'assistant/message',
    content: [{ type: 'text', text: '**Жирный текст**\n*Курсив*\n~~Зачёркнутый~~\n\n`код`\n\n```python\nprint("Привет")\n```\n\n[Ссылка](https://telegram.org)' }] };
  exchange(relay, 1, [session()], { events: [first] }); await relay.deliver();
  const sent = calls.find(c => c.method === 'sendMessage').payload;
  assert.ok(!sent.text.includes('**Жирный'));
  assert.deepEqual(new Set(sent.entities.map(e => e.type)), new Set(['bold','italic','strikethrough','code','pre','text_link']));
  assert.equal(sent.entities.find(e => e.type === 'pre').language, 'python');
  exchange(relay, 2, [session()], { events: [{ ...first, id: 'a:2', seq: 2,
    surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 }, content: [{ type: 'text', text: '*Исправлено*' }] }] });
  await relay.deliver();
  const edited = calls.find(c => c.method === 'editMessageText').payload;
  assert.equal(edited.text, 'Исправлено');
  assert.deepEqual(edited.entities, [{ type: 'italic', offset: 0, length: 10 }]);
});

test('single-text Harness replacement edits the exact tracked bot message', async t => {
  const { relay, calls } = await fixture(t);
  const first = { id: 'a:1', sessionId: 'a', seq: 1, type: 'assistant/message', content: [{ type: 'text', text: 'first' }] };
  exchange(relay, 1, [session()], { events: [first] }); await relay.deliver();
  exchange(relay, 2, [session()], { events: [{ ...first, id: 'a:2', seq: 2,
    surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 }, content: [{ type: 'text', text: 'changed' }] }] });
  await relay.deliver();
  assert.equal(calls.filter(c => c.method === 'sendMessage').length, 1);
  const edit = calls.find(c => c.method === 'editMessageText');
  assert.equal(edit.payload.message_id, 102);
  assert.equal(edit.payload.text, 'changed');
});

test('archive-restore discards old queued messages instead of replaying deleted history', async t => {
  const { relay, calls } = await fixture(t);
  exchange(relay, 1); await relay.deliver();
  exchange(relay, 2, [session()], { events: [{ id: 'a:1', sessionId: 'a', seq: 1, type: 'assistant/message', content: [{ type: 'text', text: 'old' }] }] });
  exchange(relay, 3, [session('a', { archived: true })]);
  exchange(relay, 4); await relay.deliver();
  assert.equal(calls.filter(c => c.method === 'sendMessage').length, 0);
});

test('an archive arriving during topic creation cannot be overwritten by its receipt', async t => {
  const { relay, row, replies, calls } = await fixture(t);
  replies.set('createForumTopic', (_req, res) => {
    exchange(relay, 2, [session('a', { archived: true })]);
    res.end(JSON.stringify({ ok: true, result: { message_thread_id: 777 } }));
  });
  exchange(relay, 1); await relay.deliver();
  assert.equal(row().archived, true);
  assert.equal(row().topic, null);
  assert.equal(calls.find(c => c.method === 'deleteForumTopic').payload.message_thread_id, 777);
});

test('complete HTTP relay → Telegram button → gateway → native question answer path', async t => {
  const { relay, store, calls } = await fixture(t);
  const token = 'gateway-'.padEnd(40, 't');
  const server = createRelayServer({ relay, gateways: { local: token } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const gatewayStore = new Store(); t.after(() => gatewayStore.close());
  const agent = { id: 'a', session: { id: 'a' } };
  const ctx = { on: () => () => {}, agents: { get: () => agent, roots: () => [agent] },
    workspaceRegistry: { archivedSessionIds: [] } };
  const adapter = {
    inventory: async () => [session('a', { readable: true })],
    page: async () => ({ cursor: -1, records: [], hasMore: false }),
    invoke: async () => ({ values: { userQuestions: { active: [] } } }),
  };
  const interactions = new GatewayInteractions({ ctx, store: gatewayStore, adapter });
  t.after(() => interactions.dispose());
  const gateway = new Gateway({ adapter, store: gatewayStore, interactions,
    client: new RelayClient({ url: `http://127.0.0.1:${server.address().port}`, gatewayId: 'local', token }) });
  const pending = interactions.ask('question', { agent, questions: [{ id: 'q', question: 'Choose', options: [{ label: 'Yes' }, { label: 'No' }] }] },
    () => Promise.reject(Object.assign(new Error(), { code: 'NO_PROVIDER' })));
  await gateway.tick(); await relay.deliver();
  const state = store.entries('interaction:')[0][1];
  const card = calls.find(c => c.method === 'sendMessage' && c.payload.reply_markup);
  relay.ingest([{ update_id: 1, callback_query: { id: 'callback1', from: { id: 42 },
    message: { message_id: state.messageId, message_thread_id: state.topic, chat: { id: 42, type: 'private' } },
    data: card.payload.reply_markup.inline_keyboard[0][0].callback_data } }]);
  await relay.receive(); await gateway.tick();
  assert.deepEqual(await pending, { answers: [{ id: 'q', selected: ['Yes'] }] });
  await gateway.tick(); await relay.deliver();
  assert.equal(store.job(`answer:${state.token}`).status, 'done');
  assert(calls.some(c => c.method === 'editMessageReplyMarkup' && c.payload.reply_markup.inline_keyboard.length === 0));
  assert.equal(gatewayStore.pending('commands').length, 0);
});

test('artifact jobs carry stable UUID identity independent of Session seq and send exact files once', async t => {
  const { relay, calls } = await fixture(t);
  const artifact = { id: 'artifact:00000000-0000-4000-8000-000000000001', artifactId: '00000000-0000-4000-8000-000000000001',
    sessionId: 'a', seq: null, kind: 'artifact', type: 'artifact',
    content: [{ type: 'file', name: 'generated.txt', data: Buffer.from('generated result').toString('base64') }] };
  exchange(relay, 1, [session()], { events: [artifact] }); await relay.deliver();
  exchange(relay, 2, [session()], { events: [artifact] }); await relay.deliver();
  const sent = calls.filter(c => c.method === 'sendDocument');
  assert.equal(sent.length, 1);
  assert.match(sent[0].payload, /generated result/);
});

test('clearing an already-cleared keyboard is a successful idempotent no-op', async t => {
  const { telegram, replies, calls } = await fakeTelegram(t);
  replies.set('editMessageReplyMarkup', (_req, res) => res.end(JSON.stringify({
    ok: false, error_code: 400, description: 'Bad Request: message is not modified',
  })));
  assert.equal(await telegram.call('editMessageReplyMarkup', {
    chat_id: 42, message_id: 100, reply_markup: { inline_keyboard: [] },
  }), true);
  assert.equal(calls.length, 1);
  replies.set('editMessageReplyMarkup', (_req, res) => res.end(JSON.stringify({
    ok: false, error_code: 400, description: 'Bad Request: message to edit not found',
  })));
  await assert.rejects(() => telegram.call('editMessageReplyMarkup', {
    chat_id: 42, message_id: 100, reply_markup: { inline_keyboard: [] },
  }), error => error.code === 400);
});

test('UTF-16 chunking preserves non-BMP characters and every code unit', () => {
  const original = 'a'.repeat(3999) + '𐐀' + 'b'.repeat(5000);
  const chunks = splitText(original);
  assert.equal(chunks.join(''), original);
  assert(chunks.every(c => c.length <= 4000));
  assert(!chunks.some(c => /[\uD800-\uDBFF]$/.test(c)));
});
