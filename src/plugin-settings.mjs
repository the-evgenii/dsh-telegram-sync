import { createHash } from 'node:crypto';
import { TypertRemoteService, RemoteError } from '@deepseek-ai/dsh-typert-protocol';
import { RelayAdminClient, RelayClient, validateTransport } from './server.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const knownErrors = new Set(['relay-admin-unavailable', 'relay-admin-unauthorized', 'relay-settings-rejected',
  'owner-change-requires-new-relay', 'bot-change-requires-new-relay', 'bot-verification-failed', 'gateway-credentials',
  'settings-busy', 'owner-id', 'gateway-incomplete', 'gateway-start-failed', 'gateway-check-failed', 'admin-incomplete', 'connection-invalid']);

/** Keeps the settings host active even when the transport is not configured. */
export class PluginSettingsController {
  constructor({ ctx, config, startGateway }) {
    Object.assign(this, { ctx, config, startGateway });
    this.tail = Promise.resolve();
    this.fiber = null;
    this.lastConnection = null;
    this.lastApplied = null;
    this.error = null;
    this.remoteView = null;
    this.closed = false;
  }
  values() {
    const settings = this.config.settings?.get?.() ?? this.config.settings ?? {};
    const connection = Object.fromEntries(['relayUrl', 'gatewayId', 'gatewayToken', 'statePath', 'newSessionCwd']
      .map(key => [key, settings[key] || this.config[key] || '']));
    connection.gatewayToken ||= process.env.DSH_TELEGRAM_GATEWAY_TOKEN ?? '';
    for (const key of ['statePath', 'newSessionCwd']) if (!connection[key]) delete connection[key];
    connection.notifyTurns = this.config.notifyTurns !== false;
    return { settings, connection };
  }
  status() {
    const { settings, connection } = this.values();
    return {
      gatewayEnabled: settings.gatewayEnabled !== false,
      gatewayRunning: this.fiber?.state === 2,
      relayUrl: connection.relayUrl, gatewayId: connection.gatewayId,
      statePath: connection.statePath ?? '', newSessionCwd: connection.newSessionCwd ?? '',
      gatewayTokenConfigured: Boolean(connection.gatewayToken),
      adminTokenConfigured: Boolean(settings.relayAdminToken),
      error: this.error, relay: this.remoteView,
    };
  }
  admin(connection, settings) {
    if (!connection.relayUrl || !settings.relayAdminToken) throw new Error('admin-incomplete');
    return new RelayAdminClient({ url: connection.relayUrl, token: settings.relayAdminToken });
  }
  apply() {
    const task = this.tail.then(async () => {
      if (this.closed) return this.status();
      const { settings, connection } = this.values();
      const fingerprint = digest({ settings, connection });
      if (fingerprint === this.lastApplied) return this.status();
      try {
        if (connection.relayUrl) validateTransport(connection.relayUrl);
        if (settings.manageRelay) {
          const gateways = Object.create(null);
          for (const machine of ['mac', 'vps']) {
            const id = settings[`${machine}GatewayId`];
            const token = settings[`${machine}GatewayToken`];
            if (!token) continue;
            if (!/^[a-zA-Z0-9_-]{1,32}$/.test(id) || Object.hasOwn(gateways, id)) throw new Error('gateway-credentials');
            gateways[id] = token;
          }
          const patch = {
            exclusiveBotConfirmed: settings.exclusiveBotConfirmed === true,
            notifications: Object.fromEntries(['silentMessages', 'questions', 'completion', 'mentions'].map(key => [key, settings[key] === true])),
            gateways,
          };
          if (settings.ownerId > 0) patch.ownerId = settings.ownerId;
          if (settings.botToken) patch.botToken = settings.botToken;
          this.remoteView = await this.admin(connection, settings).configure(patch);
        }
        const connectionHash = settings.gatewayEnabled === false ? null : digest(connection);
        if (connectionHash !== this.lastConnection) {
          if (settings.gatewayEnabled !== false && (connection.relayUrl || connection.gatewayId || connection.gatewayToken)
            && !(connection.relayUrl && connection.gatewayId && connection.gatewayToken)) throw new Error('gateway-incomplete');
          if (this.fiber) { await this.fiber.dispose(); this.fiber = null; }
          if (!this.closed && settings.gatewayEnabled !== false && connection.relayUrl && connection.gatewayId && connection.gatewayToken) {
            this.fiber = this.startGateway(connection);
            while (this.fiber.inertia) await this.fiber.inertia;
            if (this.fiber.state !== 2) { await this.fiber.dispose(); this.fiber = null; throw new Error('gateway-start-failed'); }
          }
          this.lastConnection = connectionHash;
        }
        this.lastApplied = fingerprint;
        this.error = null;
      } catch (error) {
        this.error = knownErrors.has(error.message) ? error.message : 'connection-invalid';
      }
      return this.status();
    });
    this.tail = task.catch(() => {});
    return task;
  }
  async check(signal) {
    await this.tail;
    const { settings, connection } = this.values();
    try {
      this.remoteView = settings.relayAdminToken
        ? await this.admin(connection, settings).describe(signal)
        : await new RelayClient({ url: connection.relayUrl, gatewayId: connection.gatewayId, token: connection.gatewayToken }).check(signal);
      this.error = null;
    } catch (error) { this.error = knownErrors.has(error.message) ? error.message : 'connection-invalid'; }
    return this.status();
  }
  async stop() {
    this.closed = true;
    await this.tail;
    if (this.fiber) await this.fiber.dispose();
    this.fiber = null;
  }
}

const requestParser = { parse(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length) throw new Error('Expected an empty settings request');
  return {};
} };
const resultParser = { parse(value) {
  if (!value || typeof value !== 'object' || typeof value.gatewayRunning !== 'boolean') throw new Error('Invalid settings status');
  return value;
} };

export function installSettingsRemote(ctx, controller) {
  class TelegramSyncSettings extends TypertRemoteService {
    constructor(context) { super(context, 'telegramSyncSettings', { namespace: 'telegramSync' }); }
    owner(method) {
      if (this.ctx.invocation?.peer.principal.kind !== 'owner') throw new RemoteError('remote-access/denied', 'Telegram Sync settings are owner-only', {
        action: `telegramSync/${method}`, reason: 'owner-only',
      });
    }
    async status() { this.owner('status'); return controller.status(); }
    async apply() { this.owner('apply'); return controller.apply(); }
    async check(_request, signal) { this.owner('check'); return controller.check(signal); }
  }
  const service = new TelegramSyncSettings(ctx);
  ctx.typert.register({ package: 'dsh-telegram-sync', face: 'host', model: {}, schemas: [],
    invocations: ['status', 'apply', 'check'].map(method => ({
      id: `dsh-telegram-sync#telegramSync/${method}`, service: 'telegramSyncSettings', namespace: 'telegramSync', method,
      invocation: { kind: 'direct' },
      parameters: [{ name: 'request', wire: 'request', source: 'json', codec: { mode: 'strict', typeSymbol: 'dsh-telegram-sync#SettingsRequest', create: () => requestParser } }],
      cancellation: { parameter: 'signal' },
      result: { mode: 'strict', typeSymbol: 'dsh-telegram-sync#SettingsStatus', create: () => resultParser },
    })),
  });
  return service;
}
