#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../src/store.mjs';
import { Telegram } from '../src/telegram.mjs';
import { Relay } from '../src/relay.mjs';
import { createRelayServer } from '../src/server.mjs';

const configPath = process.argv[2];
if (!configPath) throw new Error('Usage: dsh-telegram-sync /absolute/path/to/config.json');
const config = JSON.parse(readFileSync(configPath, 'utf8'));
if (config.exclusiveBotConfirmed !== true) throw new Error('Confirm existing consumers of this bot are stopped before setting exclusiveBotConfirmed=true');
const gateways = Object.fromEntries(Object.entries(config.gatewayTokenEnvs ?? {}).map(([id, env]) => [id, process.env[env]]));
const store = new Store(resolve(config.statePath ?? './telegram-sync.sqlite'));
const instance = randomUUID();
function lease() {
  store.transaction(() => {
    const held = store.get('relay:lease');
    if (held?.id !== instance && held?.until > Date.now()) throw new Error('Another relay owns this database');
    store.set('relay:lease', { id: instance, until: Date.now() + 90_000 });
  });
}
lease();
const telegram = new Telegram({ token: process.env[config.botTokenEnv ?? 'TELEGRAM_BOT_TOKEN'] });
const relay = new Relay({ store, telegram, ownerId: config.ownerId, notifications: config.notifications, gatewayIds: Object.keys(gateways) });
await relay.verifyBot();
const server = createRelayServer({ relay, gateways });
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(config.port ?? 8791, config.host ?? '127.0.0.1', resolve);
});
const controller = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => controller.abort());
async function loop(fn, interval) {
  while (!controller.signal.aborted) {
    try { lease(); await fn(); }
    catch { if (!controller.signal.aborted) console.warn('telegram-sync: operation failed; inspect queue status'); }
    try { await delay(interval, undefined, { signal: controller.signal }); } catch { break; }
  }
}
console.log(`telegram-sync: relay listening on ${config.host ?? '127.0.0.1'}:${server.address().port}`);
try {
  await Promise.all([
    loop(() => relay.poll(controller.signal), 1000),
    loop(async () => { await relay.receive(); await relay.deliver(); }, 500),
    loop(() => relay.typing(), 4000),
  ]);
} finally {
  await new Promise(resolve => server.close(resolve));
  store.transaction(() => { if (store.get('relay:lease')?.id === instance) store.set('relay:lease', null); });
  store.close();
}
