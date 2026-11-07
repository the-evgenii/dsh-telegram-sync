#!/usr/bin/env node
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../src/store.mjs';
import { RelayRuntime } from '../src/relay-runtime.mjs';
import { createRelayServer } from '../src/server.mjs';

if (process.argv[2] === '--init') {
  if (!process.argv[3]) throw new Error('Usage: dsh-telegram-sync --init /absolute/private/config.json');
  const path = resolve(process.argv[3]);
  const adminToken = randomBytes(32).toString('base64url');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify({ host: '127.0.0.1', port: 8791, statePath: resolve(dirname(path), 'relay.sqlite'),
    ownerId: 0, exclusiveBotConfirmed: false, adminToken, gatewayTokenEnvs: {} }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log('Конфигурация создана. Запустите relay с этим файлом, затем откройте Harness → Настройки → Telegram Sync.');
  console.log('Ключ администратора (секрет, сохраните для страницы настроек): ' + adminToken);
} else {
  const configPath = process.argv[2];
  if (!configPath) throw new Error('Usage: dsh-telegram-sync /absolute/path/to/config.json (or --init path)');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const store = new Store(resolve(config.statePath ?? './telegram-sync.sqlite'));
  const instance = randomUUID();
  function lease() {
    store.transaction(() => {
      const held = store.get('relay:lease');
      if (held?.id !== instance && held?.until > Date.now()) throw new Error('Another relay owns this database');
      store.set('relay:lease', { id: instance, until: Date.now() + 90_000 });
    });
  }
  const controller = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => controller.abort());
  const adminToken = config.adminToken ?? process.env[config.adminTokenEnv ?? 'DSH_SYNC_ADMIN_TOKEN'];
  const settings = {
    ownerId: config.ownerId ?? 0, botToken: process.env[config.botTokenEnv ?? 'TELEGRAM_BOT_TOKEN'] ?? '',
    gateways: Object.fromEntries(Object.entries(config.gatewayTokenEnvs ?? {}).flatMap(([id, env]) => process.env[env] ? [[id, process.env[env]]] : [])),
    exclusiveBotConfirmed: config.exclusiveBotConfirmed === true, notifications: config.notifications ?? {},
  };
  const runtime = new RelayRuntime({ store, settings, lease });
  let server;
  try {
    lease();
    await runtime.start();
    if (!adminToken && !runtime.describe().ready) throw new Error('Configure the relay or initialize protected settings access first');
    server = createRelayServer({ relay: runtime, gateways: runtime.gateways, adminToken, settings: runtime });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port ?? 8791, config.host ?? '127.0.0.1', resolve);
    });
    console.log(`telegram-sync: relay listening on ${config.host ?? '127.0.0.1'}:${server.address().port}`);
    while (!controller.signal.aborted) {
      lease();
      try { await delay(20_000, undefined, { signal: controller.signal }); } catch { break; }
    }
  } finally {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    await runtime.stop();
    store.transaction(() => { if (store.get('relay:lease')?.id === instance) store.set('relay:lease', null); });
    store.close();
  }
}
