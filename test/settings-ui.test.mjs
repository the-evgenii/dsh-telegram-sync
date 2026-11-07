import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { Context } from '@deepseek-ai/cordis';
import TypertRegistry from '@deepseek-ai/dsh-typert-registry';
import { Config } from '../src/config.mjs';
import { PluginSettingsController, installSettingsRemote } from '../src/plugin-settings.mjs';

function loadClient(react) {
  let module;
  runInNewContext(readFileSync(new URL('../src/client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load: spec => { module = spec.factory(name => { assert.equal(name, 'react'); return react; }); } } },
  });
  return module;
}

test('settings client registers a real native section and preserves blank redacted secrets', () => {
  const module = loadClient({});
  const specs = [];
  module.apply({ slots: { inject: (_name, callback) => callback(), register: spec => { specs.push(spec); } } });
  assert.equal(specs[0].name, 'settings.section');
  assert.equal(specs[0].id, 'telegram-sync');
  const ops = module.buildMutations({ ownerId: 42, botToken: '', gatewayToken: '', gatewayEnabled: false, relayUrl: 'https://relay.example' });
  assert.deepEqual(JSON.parse(JSON.stringify(ops)), [
    { op: 'set', path: ['settings', 'ownerId'], value: 42 },
    { op: 'set', path: ['settings', 'gatewayEnabled'], value: false },
    { op: 'set', path: ['settings', 'relayUrl'], value: 'https://relay.example' },
  ]);
});

test('settings page renders owner, bot, server and both machine credentials without revealing stored secrets', () => {
  let component;
  const elements = [];
  const react = {
    createElement: (type, props, ...children) => { const result = { type, props: props ?? {}, children }; elements.push(result); return result; },
    useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
    useState: initial => [initial, () => {}], useEffect: () => {},
  };
  const module = loadClient(react);
  const form = { getSnapshot: () => ({ writable: true, revision: 1, value: { settings: { gatewayEnabled: false, silentMessages: false } } }), subscribe() {} };
  module.apply({ slots: { inject: (_name, callback) => callback(), register: (_spec, panel) => { component = panel; } },
    configForms: { get: id => { assert.equal(id, 'telegram-conversation-sync'); return form; } } });
  const child = component();
  child.type(child.props);
  const inputs = elements.filter(e => e.type === 'input');
  for (const name of ['ownerId', 'botToken', 'relayUrl', 'relayAdminToken', 'gatewayToken', 'macGatewayToken', 'vpsGatewayToken', 'newSessionCwd']) {
    assert.ok(inputs.some(e => e.props.name === name), name);
  }
  assert.equal(inputs.find(e => e.props.name === 'gatewayId').props.value, '');
  assert.equal(inputs.find(e => e.props.name === 'gatewayEnabled').props.checked, false);
  assert.equal(inputs.find(e => e.props.name === 'silentMessages').props.checked, false);
  assert.equal(inputs.find(e => e.props.name === 'botToken').props.type, 'password');
});

test('Config declares one volatile form with redacted secret roles', () => {
  const schema = Config.toJSON();
  const settings = schema.refs[schema.refs[schema.uid].dict.settings];
  assert.equal(settings.meta.volatile, true);
  assert.equal(schema.refs[settings.dict.botToken].meta.role, 'secret');
  assert.equal(schema.refs[settings.dict.relayAdminToken].meta.role, 'secret');
});

test('settings controller keeps unconfigured UI active, upgrades legacy fields and reconnects only on transport changes', async t => {
  let draft = {};
  let starts = 0, stops = 0;
  const config = { relayUrl: 'http://127.0.0.1:8791', gatewayId: 'local', gatewayToken: 'test-only-gateway-'.repeat(3), settings: { get: () => draft } };
  const controller = new PluginSettingsController({ ctx: {}, config, startGateway: connection => {
    starts++;
    assert.equal(connection.statePath, undefined);
    assert.equal(connection.newSessionCwd, undefined);
    return { state: 2, dispose: async () => { stops++; } };
  } });
  t.after(() => controller.stop());
  assert.equal((await controller.apply()).gatewayRunning, true);
  assert.equal(starts, 1);
  draft = { ownerId: 42 };
  await controller.apply();
  assert.equal(starts, 1);
  assert.ok(!JSON.stringify(controller.status()).includes(config.gatewayToken));
  draft = { gatewayEnabled: false };
  assert.equal((await controller.apply()).gatewayRunning, false);
  assert.equal(stops, 1);
  const empty = new PluginSettingsController({ ctx: {}, config: {}, startGateway: () => { throw new Error('Must not start'); } });
  t.after(() => empty.stop());
  assert.equal((await empty.apply()).error, null);
});

test('native child-fiber lifecycle starts and stops a transport while settings remain active', { timeout: 2000 }, async () => {
  const ctx = new Context();
  let controller;
  let started = 0, stopped = 0;
  const parent = ctx.plugin({ name: 'test-settings-host', async apply(owner) {
    controller = new PluginSettingsController({ ctx: owner,
      config: { relayUrl: 'http://127.0.0.1:8791', gatewayId: 'local', gatewayToken: 'test-only-key-'.repeat(3) },
      startGateway: () => owner.plugin({ name: 'test-transport', apply(child) { started++; child.effect(() => () => { stopped++; }); } }),
    });
    owner.effect(() => () => controller.stop());
    await controller.apply();
  } });
  while (parent.inertia) await parent.inertia;
  assert.equal(parent.state, 2);
  assert.equal(controller.status().gatewayRunning, true);
  assert.equal(started, 1);
  await parent.dispose();
  assert.equal(stopped, 1);
});

test('manual RPC descriptors register with the installed native Typert registry', () => {
  const ctx = new Context();
  new TypertRegistry(ctx);
  assert.doesNotThrow(() => installSettingsRemote(ctx, { status: () => ({ gatewayRunning: false }) }));
});

test('custom settings RPC refuses every non-owner and calls outside an invocation', async () => {
  const ctx = new Context();
  let registration;
  ctx.provide('typert', { register: value => { registration = value; } });
  const controller = { status: () => ({ gatewayRunning: false }), apply: async () => ({ gatewayRunning: false }) };
  const service = installSettingsRemote(ctx, controller);
  assert.equal(registration.invocations.length, 3);
  await assert.rejects(() => service.status(), /owner-only/);
  const guest = ctx.extend({ invocation: { peer: { principal: { kind: 'guest' } } } }).get('telegramSyncSettings');
  await assert.rejects(() => guest.apply(), /owner-only/);
  const owner = ctx.extend({ invocation: { peer: { principal: { kind: 'owner' } } } }).get('telegramSyncSettings');
  assert.deepEqual(await owner.status(), { gatewayRunning: false });
});
