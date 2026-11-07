import { setTimeout as delay } from 'node:timers/promises';
import { Relay } from './relay.mjs';
import { Telegram } from './telegram.mjs';

const validId = id => /^[a-zA-Z0-9_-]{1,32}$/.test(id);
const settingError = code => Object.assign(new Error(code), { code });
const fields = new Set(['ownerId', 'botToken', 'gateways', 'exclusiveBotConfirmed', 'notifications']);
const notificationFields = ['silentMessages', 'completion', 'mentions', 'questions'];

function mergeSettings(previous, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some(key => !fields.has(key))) throw settingError('invalid-settings');
  const next = { ...previous, ...patch, gateways: { ...previous.gateways }, notifications: { ...previous.notifications } };
  if (patch.botToken === '') next.botToken = previous.botToken;
  if (patch.gateways !== undefined) {
    if (!patch.gateways || typeof patch.gateways !== 'object' || Array.isArray(patch.gateways)) throw settingError('gateway-credentials');
    for (const [id, token] of Object.entries(patch.gateways)) {
      if (!validId(id) || typeof token !== 'string') throw settingError('gateway-credentials');
      if (token) Object.defineProperty(next.gateways, id, { value: token, enumerable: true, configurable: true, writable: true });
      else if (!Object.hasOwn(next.gateways, id)) throw settingError('gateway-credentials');
    }
  }
  if (!Number.isSafeInteger(next.ownerId) || next.ownerId < 0) throw settingError('owner-id');
  if (typeof next.botToken !== 'string' || /\s/.test(next.botToken)) throw settingError('bot-token');
  if (typeof next.exclusiveBotConfirmed !== 'boolean') throw settingError('exclusive-bot');
  const tokens = Object.values(next.gateways);
  if (tokens.some(value => typeof value !== 'string' || value.length < 32) || new Set(tokens).size !== tokens.length) throw settingError('gateway-credentials');
  if (patch.notifications !== undefined) {
    if (!patch.notifications || typeof patch.notifications !== 'object' || Array.isArray(patch.notifications)
      || Object.entries(patch.notifications).some(([key, value]) => !notificationFields.includes(key) || typeof value !== 'boolean')) throw settingError('notifications');
    Object.assign(next.notifications, patch.notifications);
  }
  return next;
}

/** Owns relay workers, so applying settings never races an in-flight Telegram send. */
export class RelayRuntime {
  constructor({ store, settings = {}, telegramFactory = token => new Telegram({ token }), runLoops = true, lease = () => {}, logger = console }) {
    Object.assign(this, { store, telegramFactory, runLoops, lease, logger });
    this.settings = mergeSettings({ ownerId: 0, botToken: '', gateways: {}, notifications: {}, exclusiveBotConfirmed: false }, settings);
    this.gateways = Object.assign(Object.create(null), this.settings.gateways);
    this.relay = null;
    this.busy = false;
  }
  async start() {
    await this.configure(this.store.get('settings:relay', {}));
  }
  describe() {
    return {
      ready: this.relay !== null, ownerId: this.settings.ownerId,
      botTokenConfigured: Boolean(this.settings.botToken), botUsername: this.relay?.botUsername ?? null,
      exclusiveBotConfirmed: this.settings.exclusiveBotConfirmed,
      gateways: Object.keys(this.gateways).map(id => ({ id, tokenConfigured: true })),
      notifications: { ...this.settings.notifications },
    };
  }
  async configure(patch) {
    if (this.busy) throw settingError('settings-busy');
    this.busy = true;
    try {
      const next = mergeSettings(this.settings, patch);
      const bound = this.store.entries('session:').some(([, row]) => row.topic);
      if (bound && this.settings.ownerId && next.ownerId !== this.settings.ownerId) throw settingError('owner-change-requires-new-relay');
      let relay = null;
      if (next.ownerId > 0 && next.botToken && next.exclusiveBotConfirmed && Object.keys(next.gateways).length) {
        const telegram = this.telegramFactory(next.botToken);
        relay = new Relay({ store: this.store, telegram, ownerId: next.ownerId, notifications: next.notifications, gatewayIds: Object.keys(next.gateways), logger: this.logger, recover: false });
        try { await relay.verifyBot(); }
        catch { throw settingError('bot-verification-failed'); }
        const oldBot = this.relay?.botId ?? this.store.get('settings:bot-id');
        if (bound && oldBot && relay.botId !== oldBot) throw settingError('bot-change-requires-new-relay');
      }
      await this.stop();
      try {
        // Verification awaited the network: the old worker may have created its first topic meanwhile.
        const boundAfterDrain = this.store.entries('session:').some(([, row]) => row.topic);
        if (boundAfterDrain && this.settings.ownerId && next.ownerId !== this.settings.ownerId) throw settingError('owner-change-requires-new-relay');
        const oldBotAfterDrain = this.relay?.botId ?? this.store.get('settings:bot-id');
        if (boundAfterDrain && oldBotAfterDrain && relay && relay.botId !== oldBotAfterDrain) throw settingError('bot-change-requires-new-relay');
        this.store.recover('telegram');
        this.store.transaction(() => {
          this.store.set('settings:relay', next);
          if (relay) this.store.set('settings:bot-id', relay.botId);
        });
      } catch (error) { this.startWorkers(); throw error; }
      this.settings = next;
      for (const id of Object.keys(this.gateways)) delete this.gateways[id];
      Object.assign(this.gateways, next.gateways);
      this.relay = relay;
      this.startWorkers();
      return this.describe();
    } finally { this.busy = false; }
  }
  exchange(gatewayId, payload) {
    if (!this.relay) throw settingError('relay-not-configured');
    return this.relay.exchange(gatewayId, payload);
  }
  startWorkers() {
    if (!this.relay || !this.runLoops) return;
    const relay = this.relay;
    const controller = new AbortController();
    this.controller = controller;
    const loop = async (fn, interval) => {
      while (!controller.signal.aborted) {
        try { this.lease(); await fn(); }
        catch { if (!controller.signal.aborted) this.logger.warn?.('telegram-sync: operation failed; durable state retained'); }
        try { await delay(interval, undefined, { signal: controller.signal }); } catch { break; }
      }
    };
    this.work = Promise.all([
      loop(() => relay.poll(controller.signal), 1000),
      loop(async () => { await relay.receive(); await relay.deliver(); }, 500),
      loop(() => relay.typing(), 4000),
    ]);
  }
  async stop() {
    this.controller?.abort();
    await this.work;
    this.controller = null;
    this.work = null;
  }
}
