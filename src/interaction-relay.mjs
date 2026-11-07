import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { sessionKey } from './store.mjs';
import { splitText } from './telegram.mjs';

const TOKEN = /^[A-Za-z0-9_-]{16,24}$/;
const positive = value => Number.isSafeInteger(value) && value > 0;
const stateKey = token => `interaction:${token}`;
const nonempty = value => typeof value === 'string' && value.length > 0;

function validate(input) {
  if (!input || !TOKEN.test(input.token) || !nonempty(input.sessionId)) throw new Error('Invalid interaction');
  const value = JSON.parse(JSON.stringify(input));
  if (value.kind === 'approval') {
    if (!nonempty(value.toolName) || ['reason', 'details'].some(k => value[k] !== undefined && typeof value[k] !== 'string')) {
      throw new Error('Invalid approval');
    }
  } else if (value.kind === 'question') {
    if (!Array.isArray(value.questions) || !value.questions.length) throw new Error('Invalid questions');
    const ids = new Set();
    for (const q of value.questions) {
      if (!nonempty(q.id) || ids.has(q.id) || !nonempty(q.question)
        || (q.header !== undefined && typeof q.header !== 'string')
        || (q.detail !== undefined && typeof q.detail !== 'string')
        || (q.multiSelect !== undefined && typeof q.multiSelect !== 'boolean')
        || (q.intent?.kind === 'approval' && q.multiSelect)) throw new Error('Invalid question');
      ids.add(q.id);
      q.options ??= [];
      if (!Array.isArray(q.options)) throw new Error('Invalid options');
      const labels = new Set();
      for (const option of q.options) {
        if (!nonempty(option.label) || labels.has(option.label)
          || (option.description !== undefined && typeof option.description !== 'string')) throw new Error('Invalid option');
        labels.add(option.label);
      }
    }
  } else throw new Error('Invalid interaction kind');
  return value;
}

/** No network inside reconcile: call it in the enclosing Relay.exchange transaction. */
export class InteractionRelay {
  constructor(relay) { this.relay = relay; this.store = relay.store; }

  queue(state, suffix = '') {
    this.store.enqueue(`interaction:${state.token}:${state.version}${suffix}`, 'telegram', {
      op: 'interaction', key: state.key, token: state.token,
    });
  }

  reconcile(gatewayId, interactions, revision) {
    if (!nonempty(gatewayId) || !positive(revision) || !Array.isArray(interactions)) throw new Error('Invalid interaction snapshot');
    const heartbeatKey = `interaction-gateway:${gatewayId}`;
    const previous = this.store.get(heartbeatKey);
    if (previous && revision <= previous.revision) return;
    const seen = new Set();
    // Validate the entire snapshot before writing, even outside an enclosing transaction.
    const values = interactions.map(validate);
    for (const value of values) {
      if (seen.has(value.token)) throw new Error('Duplicate interaction token');
      seen.add(value.token);
      const old = this.store.get(stateKey(value.token));
      if (old && (old.gatewayId !== gatewayId || old.sessionId !== value.sessionId
        || !isDeepStrictEqual(old.request, value))) throw new Error('Interaction token scope or content changed');
      if (!this.relay.session(sessionKey(gatewayId, value.sessionId))) throw new Error('Interaction session missing');
    }
    for (const request of values) {
      if (this.store.get(stateKey(request.token))) continue; // terminal tokens are never resurrected
      const state = { token: request.token, gatewayId, sessionId: request.sessionId,
        key: sessionKey(gatewayId, request.sessionId), request, status: 'pending',
        nonce: randomBytes(6).toString('base64url'), version: 1, index: 0, page: 0, selected: [], answers: [] };
      this.store.set(stateKey(state.token), state);
      this.queue(state);
    }
    for (const [, state] of this.store.entries('interaction:')) {
      if (state.gatewayId !== gatewayId || seen.has(state.token) || state.status === 'expired') continue;
      state.status = 'expired';
      state.version++;
      this.store.set(stateKey(state.token), state);
      this.queue(state);
      // Do not deliver an answer still queued after a native GUI answer removed the token.
      const answer = this.store.job(`answer:${state.token}`);
      if (answer?.status === 'pending') this.store.status(answer.id, 'failed', 'interaction-expired');
    }
    this.store.set(heartbeatKey, { revision, at: this.relay.now() });
  }

  active(state, row) {
    return state?.status === 'pending' && row && !row.archived && !row.deleted && positive(row.topic)
      && row.key === state.key && row.gatewayId === state.gatewayId && row.sessionId === state.sessionId
      && (!state.topic || state.topic === row.topic);
  }

  online(state) {
    const heartbeat = this.store.get(`interaction-gateway:${state.gatewayId}`);
    const age = heartbeat ? this.relay.now() - heartbeat.at : Infinity;
    return age >= 0 && age <= 10_000;
  }

  screen(state) {
    const button = (text, action) => {
      const data = `ir:${state.token}:${state.nonce}:${state.version.toString(36)}:${action}`;
      if (Buffer.byteLength(data) > 64) throw new Error('Interaction callback exceeds Telegram limit');
      return { text: Array.from(text).slice(0, 100).join(''), callback_data: data };
    };
    const request = state.request;
    if (request.kind === 'approval') return {
      text: ['Подтверждение инструмента', request.toolName, request.reason, request.details].filter(Boolean).join('\n\n'),
      reply_markup: { inline_keyboard: [[button('Разрешить один раз', 'allow')], [button('Отклонить', 'reject')]] },
    };
    const q = request.questions[state.index];
    const start = state.page * 6;
    const options = q.options.slice(start, start + 6);
    const keyboard = options.map((option, i) => [button(`${state.selected.includes(start + i) ? '✓ ' : ''}${option.label}`, `o${(start + i).toString(36)}`)]);
    const nav = [];
    if (state.page > 0) nav.push(button('←', `p${(state.page - 1).toString(36)}`));
    if (start + 6 < q.options.length) nav.push(button('→', `p${(state.page + 1).toString(36)}`));
    if (nav.length) keyboard.push(nav);
    if (q.multiSelect) keyboard.push([button('Готово', 'done')]);
    if (q.intent?.kind !== 'approval') keyboard.push([button('Пропустить', 'skip')]);
    return {
      text: [`Вопрос ${state.index + 1}/${request.questions.length}`, q.header, q.question, q.detail,
        ...options.map(o => `${o.label}${o.description ? ` — ${o.description}` : ''}`),
        q.intent?.kind === 'approval' ? 'Выберите один из предложенных вариантов.'
          : 'Можно отправить свой ответ текстом в этой теме.'].filter(Boolean).join('\n\n'),
      reply_markup: { inline_keyboard: keyboard },
    };
  }

  async perform(job, row) {
    let state = this.store.get(stateKey(job.payload.token));
    if (!state || state.key !== job.payload.key || row.key !== state.key) return;
    // A process can stop after receipt() commits but before the card state commits.
    const saved = this.store.get(`receipt:interaction:${state.token}:1:card`);
    if (!state.messageId && positive(saved?.message_id)) {
      state = { ...state, messageId: saved.message_id, renderedVersion: 1 };
      this.store.set(stateKey(state.token), state);
    }
    if (state.status !== 'pending' || !this.active(state, row)) {
      if (state.messageId) await this.relay.telegram.call('editMessageReplyMarkup', {
        chat_id: this.relay.ownerId, message_id: state.messageId, reply_markup: { inline_keyboard: [] },
      });
      return;
    }
    const version = state.version;
    if (!state.messageId) {
      state = { ...state, topic: row.topic };
      this.store.set(stateKey(state.token), state);
    }
    const screen = this.screen(state);
    const parts = splitText(screen.text);
    // Every condition is delivered in full BEFORE publishing the approval button.
    for (let i = 0; i < parts.length - 1; i++) {
      await this.relay.receipt(job.id, `context:${version}:${i}`, () => this.relay.telegram.call('sendMessage', {
        ...this.relay.address(row), text: parts[i], disable_notification: this.relay.notifications.silentMessages,
      }));
    }
    const current = this.store.get(stateKey(state.token));
    if (current.version !== version || !this.active(current, this.relay.session(state.key))) { this.queue(current); return; }
    const payload = { text: `${parts.length > 1 ? 'Подробности выше.\n\n' : ''}${parts.at(-1)}`, reply_markup: screen.reply_markup };
    let messageId = state.messageId;
    if (!messageId) {
      const receipt = await this.relay.receipt(job.id, 'card', () => this.relay.telegram.call('sendMessage', {
        ...this.relay.address(row), ...payload, disable_notification: !this.relay.notifications.questions,
      }));
      messageId = receipt.message_id;
    } else {
      await this.relay.telegram.call('editMessageText', { chat_id: this.relay.ownerId, message_id: messageId, ...payload });
    }
    // Reconcile may expire this token while the HTTP send is in flight.
    state = this.store.get(stateKey(state.token));
    this.store.set(stateKey(state.token), { ...state, messageId, topic: row.topic, renderedVersion: version });
    if (state.version !== version || !this.active(state, this.relay.session(state.key))) this.queue(state, `:repair:${version}`);
  }

  finish(state, answer) {
    state.status = 'answered';
    this.store.enqueue(`answer:${state.token}`, `gateway:${state.gatewayId}`, {
      kind: 'interaction-answer', key: state.key, sessionId: state.sessionId, token: state.token, answer,
    });
  }

  advance(state, custom, skip = false) {
    const q = state.request.questions[state.index];
    state.answers.push({ id: q.id, selected: skip ? [] : state.selected.map(i => q.options[i].label),
      ...(custom === undefined ? {} : { custom }) });
    state.index++;
    state.page = 0;
    state.selected = [];
    if (state.index === state.request.questions.length) this.finish(state, { answers: state.answers });
  }

  saveProgress(state) {
    state.version++;
    this.store.set(stateKey(state.token), state);
    this.queue(state);
  }

  async callback(update) {
    const query = update?.callback_query;
    if (!query) return false;
    let notice = 'Запрос устарел или недоступен.';
    this.store.transaction(() => {
      const match = typeof query.data === 'string' && /^ir:([A-Za-z0-9_-]{16,24}):([A-Za-z0-9_-]{8}):([0-9a-z]+):(allow|reject|done|skip|[op][0-9a-z]+)$/.exec(query.data);
      if (!match || Buffer.byteLength(query.data) > 64 || query.from?.id !== this.relay.ownerId || query.from?.is_bot) return;
      const state = this.store.get(stateKey(match[1]));
      const row = state && this.relay.session(state.key);
      const message = query.message;
      if (!this.active(state, row) || message?.chat?.type !== 'private' || message.chat.id !== this.relay.ownerId
        || message.message_id !== state.messageId || message.message_thread_id !== state.topic
        || match[2] !== state.nonce || match[3] !== state.version.toString(36) || state.renderedVersion !== state.version) return;
      if (!this.online(state)) { notice = 'Шлюз недоступен. Попробуйте после подключения.'; return; }
      const action = match[4];
      if (state.request.kind === 'approval') {
        if (!['allow', 'reject'].includes(action)) return;
        this.finish(state, { decision: action === 'allow' ? 'allowed-once' : 'rejected' });
      } else {
        const q = state.request.questions[state.index];
        if (q.intent?.kind === 'approval' && ['skip', 'done'].includes(action)) return;
        if (action === 'skip') this.advance(state, undefined, true);
        else if (action === 'done' && q.multiSelect) this.advance(state);
        else if (action[0] === 'p') {
          const page = parseInt(action.slice(1), 36);
          if (!Number.isSafeInteger(page) || page < 0 || page === state.page || page * 6 >= q.options.length) return;
          state.page = page;
        } else if (action[0] === 'o') {
          const index = parseInt(action.slice(1), 36);
          if (!Number.isSafeInteger(index) || !q.options[index] || Math.floor(index / 6) !== state.page) return;
          if (q.multiSelect) state.selected = state.selected.includes(index) ? state.selected.filter(i => i !== index) : [...state.selected, index].sort((a, b) => a - b);
          else { state.selected = [index]; this.advance(state); }
        } else return;
      }
      this.saveProgress(state);
      notice = 'Принято';
    });
    try {
      await this.relay.telegram.call('answerCallbackQuery', { callback_query_id: query.id, text: notice });
    } catch { /* Acknowledgement must never roll back or replay the queued answer. */ }
    return true;
  }

  async text(message) {
    if (message?.from?.id !== this.relay.ownerId || message.from.is_bot || message.chat?.type !== 'private'
      || message.chat.id !== this.relay.ownerId || !positive(message.message_id)
      || typeof message.text !== 'string' || !message.text.trim() || message.text.startsWith('/')) return false;
    let consumed = false;
    this.store.transaction(() => {
      const dedup = `interaction-text:${message.chat.id}:${message.message_id}`;
      if (this.store.get(dedup)) { consumed = true; return; }
      const candidates = this.store.entries('interaction:').map(([, s]) => s).filter(s => {
        const row = this.relay.session(s.key);
        return this.active(s, row) && row.topic === message.message_thread_id && s.request.kind === 'question';
      });
      if (candidates.length !== 1) return;
      const state = candidates[0];
      // An offline question must not accidentally forward the intended answer as a normal prompt.
      consumed = true;
      if (!this.online(state) || !state.messageId || state.renderedVersion !== state.version
        || state.request.questions[state.index].intent?.kind === 'approval') return;
      if (!state.request.questions[state.index].multiSelect) state.selected = [];
      this.advance(state, message.text);
      this.saveProgress(state);
      this.store.set(dedup, true);
    });
    return consumed;
  }
}
