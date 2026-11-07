import z from '@deepseek-ai/schemastery';

const secret = () => z.string().role('secret').default('');
const text = () => z.string().default('');

export const Config = z.object({
  // Legacy gateway configuration remains readable during an in-place upgrade.
  relayUrl: text(), gatewayId: text(), gatewayToken: secret(), statePath: text(), newSessionCwd: text(),
  notifyTurns: z.boolean().default(true),
  settings: z.object({
    gatewayEnabled: z.boolean().default(true),
    relayUrl: text(), gatewayId: text(), gatewayToken: secret(), statePath: text(), newSessionCwd: text(),
    manageRelay: z.boolean().default(false), relayAdminToken: secret(),
    ownerId: z.number().min(0).default(0), botToken: secret(), exclusiveBotConfirmed: z.boolean().default(false),
    macGatewayId: z.string().default('local'), macGatewayToken: secret(),
    vpsGatewayId: z.string().default('server'), vpsGatewayToken: secret(),
    silentMessages: z.boolean().default(true), questions: z.boolean().default(true),
    completion: z.boolean().default(true), mentions: z.boolean().default(true),
  }).default({}).volatile(),
});
