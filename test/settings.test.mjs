import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store, sessionKey } from '../src/store.mjs';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { RelayRuntime } from '../src/relay-runtime.mjs';
import { createRelayServer, RelayAdminClient } from '../src/server.mjs';

const adminToken = 'admin-test-credential-'.repeat(3);
const gatewayToken = 'gateway-test-credential-'.repeat(3);
const botToken = '123456789:test-bot-credential-not-real';
const settings = () => ({ ownerId: 42, botToken, gateways: { local: gatewayToken }, exclusiveBotConfirmed: true, notifications: {} });
function fixture(t, initial = {}) {
  const store = new Store(); t.after(() => store.close());
  const calls = [];
  const telegramFactory = token => ({ call: async (method) => {
    calls.push(method);
    if (token === 'invalid-token') throw new Error('private token details');
    if (method === 'getMe') return { id: token === 'another-bot' ? 52 : 50, username: 'testbot', has_topics_enabled: true };
    if (method === 'getWebhookInfo') return { url: '' };
    if (method === 'createForumTopic') return { message_thread_id: 100 };
    return true;
  } });
  const runtime = new RelayRuntime({ store, settings: initial, telegramFactory, runLoops: false, logger: { warn() {} } });
  t.after(() => runtime.stop());
  return { store, runtime, calls };
}

test('unconfigured relay stays idle until valid settings are applied and never polls prematurely', async t => {
  const { runtime, store, calls } = fixture(t);
  await runtime.start();
  assert.equal(runtime.describe().ready, false);
  assert.deepEqual(calls, []);
  await runtime.configure(settings());
  assert.equal(runtime.describe().ready, true);
  assert.equal(runtime.describe().ownerId, 42);
  assert.equal(runtime.describe().botUsername, 'testbot');
  assert.ok(store.get('settings:relay'));
  const publicView = JSON.stringify(runtime.describe());
  assert.ok(!publicView.includes(botToken));
  assert.ok(!publicView.includes(gatewayToken));
});

test('settings preserve blank secret inputs and survive restart', async t => {
  const { runtime, store } = fixture(t);
  await runtime.configure(settings());
  await runtime.configure({ botToken: '', gateways: { local: '' }, notifications: { silentMessages: true } });
  const restarted = new RelayRuntime({ store, settings: {}, runLoops: false, telegramFactory: runtime.telegramFactory });
  t.after(() => restarted.stop());
  await runtime.stop(); await restarted.start();
  assert.equal(restarted.describe().ready, true);
  assert.equal(restarted.describe().notifications.silentMessages, true);
  assert.equal(restarted.gateways.local, gatewayToken);
});

test('unsafe settings fail without changing a running owner, bot or credentials', async t => {
  const { runtime, store } = fixture(t);
  await runtime.configure(settings());
  const key = sessionKey('local', 's');
  store.set(`session:${key}`, { key, gatewayId: 'local', sessionId: 's', topic: 100 });
  await assert.rejects(() => runtime.configure({ ownerId: 99 }), /owner-change/);
  await assert.rejects(() => runtime.configure({ botToken: 'another-bot' }), /bot-change/);
  await assert.rejects(() => runtime.configure({ botToken: 'invalid-token' }), /bot-verification/);
  await assert.rejects(() => runtime.configure({ gateways: { server: gatewayToken } }), /gateway-credentials/);
  await assert.rejects(() => runtime.configure({ ownerId: -1 }), /owner-id/);
  assert.equal(runtime.describe().ownerId, 42);
  assert.equal(runtime.describe().ready, true);
  assert.equal(store.get('settings:relay').botToken, botToken);
});

test('identity transfer is refused when the first topic appears during bot verification', async t => {
  for (const patch of [{ ownerId: 99 }, { botToken: 'another-bot' }]) {
    const { runtime, store } = fixture(t);
    await runtime.configure(settings());
    const oldRelay = runtime.relay;
    oldRelay.exchange('local', { revision: 1, sessions: [{ sessionId: 's', title: 'Test', archived: false, running: false }] });
    let release, entered;
    const gate = new Promise(resolve => { release = resolve; });
    const checking = new Promise(resolve => { entered = resolve; });
    const factory = runtime.telegramFactory;
    runtime.telegramFactory = token => {
      const telegram = factory(token);
      return { call: async method => { if (method === 'getMe') { entered(); await gate; } return telegram.call(method); } };
    };
    const pending = runtime.configure(patch);
    await checking;
    await oldRelay.deliver();
    release();
    await assert.rejects(() => pending, /(?:owner|bot)-change/);
    assert.equal(runtime.describe().ownerId, 42);
    assert.equal(store.get('settings:relay').botToken, botToken);
    assert.equal(store.get(`session:${sessionKey('local', 's')}`).topic, 100);
    assert.equal(runtime.relay, oldRelay);
  }
});

test('failed verification cannot mark an in-flight send uncertain while old relay is still active', async t => {
  const { runtime, store } = fixture(t);
  await runtime.configure(settings());
  store.enqueue('live-send', 'telegram', { op: 'message' });
  store.status('live-send', 'sending');
  await assert.rejects(() => runtime.configure({ botToken: 'invalid-token' }), /bot-verification/);
  assert.equal(store.job('live-send').status, 'sending');
});

test('server bootstrap creates private configuration once without starting a bot or overwriting secrets', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-relay-init-'));
  const path = join(directory, 'relay.json');
  const bin = new URL('../bin/relay.mjs', import.meta.url);
  const result = spawnSync(process.execPath, [bin.pathname, '--init', path], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  const value = readFileSync(path, 'utf8');
  const config = JSON.parse(value);
  assert.equal(config.ownerId, 0);
  assert.equal(config.exclusiveBotConfirmed, false);
  assert.ok(config.adminToken.length >= 32);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const again = spawnSync(process.execPath, [bin.pathname, '--init', path], { encoding: 'utf8' });
  assert.notEqual(again.status, 0);
  assert.equal(readFileSync(path, 'utf8'), value);
});

test('admin HTTP settings require a separate credential and never return secret values', async t => {
  const { runtime } = fixture(t);
  await runtime.start();
  const server = createRelayServer({ relay: runtime, gateways: runtime.gateways, adminToken, settings: runtime });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const unauthorized = await fetch(`${url}/v1/admin/settings`, { headers: { authorization: `Bearer ${gatewayToken}` } });
  assert.equal(unauthorized.status, 401);
  const client = new RelayAdminClient({ url, token: adminToken });
  assert.equal((await client.describe()).ready, false);
  assert.equal((await client.configure(settings())).ready, true);
  const gatewayStatus = await fetch(`${url}/v1/gateways/local/status`, { headers: { authorization: `Bearer ${gatewayToken}` } });
  assert.equal(gatewayStatus.status, 200);
  assert.deepEqual(await gatewayStatus.json(), { ready: true, gatewayId: 'local' });
  const deniedAdmin = await fetch(`${url}/v1/admin/settings`, { headers: { authorization: `Bearer ${gatewayToken}` } });
  assert.equal(deniedAdmin.status, 401);
  const view = await client.describe();
  assert.deepEqual(view.gateways, [{ id: 'local', tokenConfigured: true }]);
  assert.ok(!JSON.stringify(view).includes(botToken));
  assert.ok(!JSON.stringify(view).includes(gatewayToken));
  assert.throws(() => new RelayAdminClient({ url: 'http://example.com', token: adminToken }), /HTTPS/);
});
