import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from './store.mjs';
import { RelayClient } from './server.mjs';
import { Gateway, HarnessAdapter } from './gateway.mjs';
import { GatewayInteractions } from './interaction-gateway.mjs';
import { installArtifacts, ARTIFACT_TOOL } from './artifacts.mjs';
import { PluginSettingsController, installSettingsRemote } from './plugin-settings.mjs';
export { Config } from './config.mjs';

export const name = 'telegram-conversation-sync';
const gatewayInject = ['connection', 'typertGateway', 'sessionQuery', 'workspaceRegistry', 'agents', 'sessions', 'attachments', 'fileUploads', 'tools', 'fs', 'workingDirectory', 'systemPrompt', 'userQuestions', 'sessionController'];
export const inject = [...gatewayInject, 'typert', 'settings'];

export async function apply(ctx, config = {}) {
  const controller = new PluginSettingsController({ ctx, config,
    startGateway: connection => ctx.plugin({ name: 'telegram-sync-transport', inject: gatewayInject, apply: gatewayApply }, connection),
  });
  installSettingsRemote(ctx, controller);
  ctx.on('loader/volatile-update', () => { void controller.apply(); });
  ctx.effect(() => () => controller.stop());
  await controller.apply();
}

async function gatewayApply(ctx, config = {}) {
  // No implicit reading of another plugin's bot credentials; token stays on the central relay.
  const token = config.gatewayToken ?? process.env.DSH_TELEGRAM_GATEWAY_TOKEN;
  if (!config.relayUrl || !config.gatewayId || !token) throw new Error('Configure relayUrl, gatewayId and gatewayToken');
  const client = new RelayClient({ url: config.relayUrl, gatewayId: config.gatewayId, token });
  const logger = typeof ctx.logger === 'function' ? ctx.logger(name) : console;
  const path = resolve(config.statePath ?? join(homedir(), '.dsh', 'integrations', 'telegram-sync', `${config.gatewayId}.sqlite`));
  const store = new Store(path);
  const adapter = new HarnessAdapter(ctx, { newSessionCwd: config.newSessionCwd });
  const enabled = session => session.header?.origin === undefined
    && !new Set(ctx.workspaceRegistry.archivedSessionIds).has(session.id);
  const artifacts = installArtifacts(ctx, { store, enabled });
  const interactions = new GatewayInteractions({ ctx, store, adapter, logger });
  ctx.systemPrompt.context({
    name: 'telegram-sync:return-file', order: 115,
    text: assembly => assembly.agent && enabled(assembly.agent.session)
      ? `When the user asks to receive a file or generated image in Telegram, call ${ARTIFACT_TOOL} with its existing local path. The tool prepares exact bytes for delivery after this turn completes. Say prepared or queued, never sent or received. Do not recreate a file solely for delivery.` : '',
  });
  const gateway = new Gateway({ adapter, store, client, interactions, artifacts, logger, notifyTurns: config.notifyTurns !== false });
  const controller = new AbortController();
  const loop = (async () => {
    while (!controller.signal.aborted) {
      try { if (await gateway.tick(controller.signal)) continue; }
      catch { logger.warn?.('Telegram relay unavailable; durable queue retained'); }
      try { await delay(2000, undefined, { signal: controller.signal }); } catch { break; }
    }
  })();
  ctx.effect(() => async () => {
    controller.abort();
    interactions.dispose();
    await loop;
    artifacts.dispose();
    await adapter.close();
    store.close();
  });
}
