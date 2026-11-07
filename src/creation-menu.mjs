import { randomBytes, randomUUID } from 'node:crypto';
import { sessionKey } from './store.mjs';
import { inboundContent } from './telegram.mjs';

const LABELS = { local: 'Mac', server: 'VPS' };
const validId = value => Number.isSafeInteger(value) && value > 0;
const requestKey = token => `creation:request:${token}`;
export const NEW_DIALOG = 'Новый диалог';

/** Owner-only navigation. A selection card is a single durable creation intent. */
export class CreationMenu {
  constructor(relay, gatewayIds = []) {
    this.relay = relay;
    this.store = relay.store;
    this.gatewayIds = gatewayIds.filter(id => Object.hasOwn(LABELS, id));
  }
  keyboard() {
    return { inline_keyboard: [] };
  }
  enqueue(id, action, extra = {}) {
    this.store.enqueue(id, 'telegram', { op: 'navigation', key: `navigation:${this.relay.ownerId}`, action, ...extra });
  }
  owns(message, from = message?.from) {
    return from?.id === this.relay.ownerId && !from.is_bot
      && message?.chat?.type === 'private' && message.chat.id === this.relay.ownerId;
  }
  anyBinding(topic) {
    return validId(topic) && this.store.entries('session:').some(([, row]) => row.topic === topic);
  }
  openSelection(updateId, topic, { existingTopic = null, title = 'Новый диалог', hold = false, home = false } = {}) {
    return this.store.transaction(() => {
      const mark = `creation:update:${updateId}`;
      const saved = this.store.get(mark);
      if (saved) return saved === 'held' ? 'held' : 'done';
      const result = hold ? 'held' : 'done';
      this.store.set(mark, result);
      if (home) { this.enqueue(`creation:home-update:${updateId}`, 'home', { topic }); return result; }
      const scope = `creation:selection:${this.relay.ownerId}:${topic ?? 'general'}`;
      const previous = this.store.get(scope);
      let state = previous && this.store.get(requestKey(previous));
      const pinned = existingTopic && state?.existingTopic === existingTopic
        && ['queued', 'created', 'uncertain', 'ready'].includes(state.status);
      const previousSend = state && this.store.job(state.selectorJobId);
      const unknownCard = previousSend && ['uncertain', 'failed'].includes(previousSend.status)
        && !this.store.get(`receipt:creation:card:${state.token}:0`);
      if (!pinned && (!state || state.status !== 'choosing' || state.expiresAt <= this.relay.now() || unknownCard)) {
        const token = randomBytes(12).toString('base64url');
        state = { token, selectorJobId: `creation:selector:${updateId}`, ownerId: this.relay.ownerId,
          topic, existingTopic, title, status: 'choosing', messageId: null,
          heldIds: existingTopic && state?.existingTopic === existingTopic ? state.heldIds ?? [] : [],
          expiresAt: this.relay.now() + 30 * 60_000 };
        this.store.set(scope, token);
      }
      if (hold) state = { ...state, heldIds: [...new Set([...(state.heldIds ?? []), `update:${updateId}`])] };
      this.store.set(requestKey(state.token), state);
      this.enqueue(`creation:selector:${updateId}`, 'selection', { token: state.token });
      return result;
    });
  }
  message(update, row) {
    const message = update.message;
    if (!this.gatewayIds.length || !this.owns(message)) return false;
    const topic = message.message_thread_id ?? null;
    const serviceName = message.forum_topic_created?.name;
    if (validId(topic) && typeof serviceName === 'string') this.store.set(`creation:topic-name:${topic}`, serviceName);
    const command = [NEW_DIALOG, '/start', '/new'].includes(message.text?.trim());
    const unbound = !row && validId(topic) && topic !== 1 && !this.anyBinding(topic);
    if (!command && !unbound) return false;
    const content = inboundContent(message);
    const hold = !command && (Boolean(content.text.trim()) || content.files.length > 0);
    if (!command && !hold && !message.forum_topic_created) return false;
    return this.openSelection(update.update_id, topic, {
      existingTopic: unbound ? topic : null,
      title: this.store.get(`creation:topic-name:${topic}`) || 'Новый диалог',
      hold, home: command,
    });
  }
  async callback(update) {
    const query = update.callback_query;
    if (typeof query?.data !== 'string' || !query.data.startsWith('nc:')) return false;
    let text = 'Кнопка устарела. Создай новую тему Telegram и выбери в ней Mac/VPS.';
    if (query.data === 'nc:new') {
      if (this.gatewayIds.length && this.owns(query.message, query.from)) {
        const topic = query.message.message_thread_id ?? null;
        this.openSelection(update.update_id, topic, { home: true });
        text = 'Создай новую тему Telegram и выбери в ней Mac/VPS.';
      }
    } else this.store.transaction(() => {
      const match = /^nc:([A-Za-z0-9_-]{16}):(local|server)$/.exec(query.data);
      if (!match || Buffer.byteLength(query.data) > 64 || !this.owns(query.message, query.from)) return;
      const state = this.store.get(requestKey(match[1]));
      if (!state || state.ownerId !== this.relay.ownerId || state.messageId !== query.message.message_id
        || state.topic !== (query.message.message_thread_id ?? null) || !this.gatewayIds.includes(match[2])) return;
      if (!state.existingTopic) return;
      if (state.status !== 'choosing') { text = 'Этот запрос уже принят.'; return; }
      if (state.expiresAt <= this.relay.now()) return;
      const gatewayId = match[2], sessionId = `session-${randomUUID()}`, key = sessionKey(gatewayId, sessionId);
      this.store.set(requestKey(state.token), { ...state, gatewayId, sessionId, key, status: 'queued' });
      this.store.set(`creation:session:${key}`, state.token);
      this.store.enqueue(`create-session:${state.token}`, `gateway:${gatewayId}`, {
        kind: 'session-create', key, sessionId, token: state.token, title: state.title ?? 'Новый диалог',
      });
      this.enqueue(`creation:queued:${state.token}`, 'selection', { token: state.token });
      text = `Запрос принят: ${LABELS[gatewayId]}.`;
    });
    try { await this.relay.telegram.call('answerCallbackQuery', { callback_query_id: query.id, text }); }
    catch { /* ACK failure cannot undo a durable request. */ }
    return true;
  }
  acknowledge(command, ack) {
    const state = this.store.get(requestKey(command.token));
    if (!state || state.key !== command.key || state.status === 'ready') return;
    const status = ack.status === 'done' ? 'created' : ack.uncertain ? 'uncertain' : 'failed';
    this.store.set(requestKey(state.token), { ...state, status });
    this.enqueue(`creation:ack:${state.token}:${status}`, 'selection', { token: state.token });
  }
  destination(key) {
    const token = this.store.get(`creation:session:${key}`);
    const state = token && this.store.get(requestKey(token));
    return state?.ownerId === this.relay.ownerId && validId(state.existingTopic) ? state : null;
  }
  reconcile() {
    for (const [, state] of this.store.entries('creation:request:')) if (state.status === 'created') this.bound(state.key);
  }
  bound(key) {
    this.store.transaction(() => {
      const token = this.store.get(`creation:session:${key}`);
      const state = token && this.store.get(requestKey(token));
      let row = this.relay.session(key);
      if (!state || state.status !== 'created' || !row || row.archived || row.deleted) return;
      if (state.existingTopic) {
        if (this.store.entries('session:').some(([, other]) => other.key !== key && other.topic === state.existingTopic)) return;
        row = { ...row, topic: state.existingTopic, renderedTitle: row.title, plainTitle: true };
        this.store.set(`session:${key}`, row);
      }
      if (!row.topic) return;
      this.store.set(requestKey(token), { ...state, status: 'ready', epoch: row.epoch,
        boundTopic: row.topic, boundTitle: row.renderedTitle ?? row.title });
      this.enqueue(`creation:ready:${token}`, 'selection', { token });
      for (const id of state.heldIds ?? []) {
        const held = this.store.job(id);
        if (held?.lane === 'incoming' && held.status === 'held') this.store.status(id, 'pending');
      }
    });
  }
  screen(state) {
    if (state.status === 'choosing') return { text: state.existingTopic ? 'Где запускать задачи из этой темы?' : 'Где создать новый диалог?',
      reply_markup: { inline_keyboard: [this.gatewayIds.map(id => ({ text: LABELS[id], callback_data: `nc:${state.token}:${id}` }))] } };
    const device = LABELS[state.gatewayId];
    const messages = {
      queued: `Ожидаю ${device}… Если он выключен, запрос дождётся подключения.`,
      created: `Диалог на ${device} создан. Подготавливаю привязку…`,
      ready: `Подключено к ${device}.`,
      uncertain: `Не удалось подтвердить создание на ${device}. Повторно не создаю: результат нужно проверить в Harness.`,
      failed: `Не удалось создать диалог на ${device}. Настройки и причина — в журнале шлюза.`,
    };
    return { text: messages[state.status], reply_markup: this.keyboard() };
  }
  async perform(job) {
    const { action, token, topic } = job.payload;
    if (action === 'home') {
      const result = await this.relay.receipt(job.id, 0, () => this.relay.telegram.call('sendMessage', {
        chat_id: this.relay.ownerId, ...(topic ? { message_thread_id: topic } : {}),
        text: 'Создай новую тему Telegram и выбери внутри Mac или VPS.',
        reply_markup: this.keyboard(), disable_notification: true,
      }));
      if (!topic) this.store.set(`creation:inline-carrier:${this.relay.ownerId}`, result.message_id);
      return;
    }
    let state = this.store.get(requestKey(token));
    if (!state || state.ownerId !== this.relay.ownerId) return;
    // Old pending welcome jobs must not append a second confirmation after upgrade.
    if (action === 'welcome') return;
    const screen = this.screen(state);
    if (validId(state.messageId)) {
      await this.relay.telegram.call('editMessageText', { chat_id: this.relay.ownerId, message_id: state.messageId, ...screen });
    } else {
      const original = this.store.job(state.selectorJobId);
      if (original?.id !== job.id && ['uncertain', 'failed'].includes(original?.status)
        && !this.store.get(`receipt:creation:card:${token}:0`)) {
        const error = new Error('Original card delivery not confirmed'); error.uncertain = true; throw error;
      }
      const receipt = await this.relay.receipt(`creation:card:${token}`, 0, () => this.relay.telegram.call('sendMessage', {
        chat_id: this.relay.ownerId, ...(state.topic ? { message_thread_id: state.topic } : {}), ...screen, disable_notification: true,
      }));
      state = this.store.get(requestKey(token));
      this.store.set(requestKey(token), { ...state, messageId: receipt.message_id });
    }
  }
}
