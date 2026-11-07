import { createHash } from 'node:crypto';
import { sessionKey, boundedBatch } from './store.mjs';
import { inboundContent, splitText } from './telegram.mjs';
import { InteractionRelay } from './interaction-relay.mjs';
import { formatMarkdown } from './markdown.mjs';
import { mentionsOwner, terminalNotification } from './notifications.mjs';
import { CreationMenu } from './creation-menu.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const positiveId = n => Number.isSafeInteger(n) && n > 0;

export class Relay {
  constructor({ store, telegram, ownerId, notifications = {}, gatewayIds = [], now = Date.now, logger = console }) {
    if (!positiveId(ownerId)) throw new Error('A numeric Telegram ownerId is required');
    Object.assign(this, { store, telegram, ownerId, now, logger });
    this.notifications = { silentMessages: notifications.silentMessages === true,
      completion: notifications.completion === true, mentions: notifications.mentions === true,
      questions: notifications.questions !== false };
    this.ownerUsername = this.store.get('owner:username');
    this.running = new Map();
    this.interactions = new InteractionRelay(this);
    this.creation = new CreationMenu(this, gatewayIds);
    this.store.recover('telegram');
  }
  session(key) { return this.store.get(`session:${key}`); }
  address(row) { return { chat_id: this.ownerId, message_thread_id: row.topic }; }
  async verifyBot() {
    const [bot, webhook] = await Promise.all([
      this.telegram.call('getMe'), this.telegram.call('getWebhookInfo'),
    ]);
    if (!bot.has_topics_enabled) throw new Error('Enable private-chat topic mode in BotFather first');
    if (webhook.url) throw new Error('Bot already uses a webhook; do not start a second update consumer');
    if (this.notifications.mentions) {
      try {
        const chat = await this.telegram.call('getChat', { chat_id: this.ownerId });
        this.ownerUsername = typeof chat.username === 'string' ? chat.username : null;
        this.store.set('owner:username', this.ownerUsername);
      } catch { this.logger.warn?.('Owner username refresh unavailable; cached identity retained'); }
    }
  }
  silent(payload = {}, allowMention = true) {
    return this.notifications.silentMessages && !(allowMention && this.notifications.mentions
      && mentionsOwner(payload, this.ownerId, this.ownerUsername));
  }
  /** All gateway payloads arrive from the authenticated, gateway-scoped HTTP endpoint. */
  exchange(gatewayId, { revision, sessions, events = [], acknowledgements = [], interactions = [], capabilities = [] }) {
    if (!positiveId(revision) || !Array.isArray(sessions) || !Array.isArray(events) || !Array.isArray(acknowledgements) || !Array.isArray(interactions) || !Array.isArray(capabilities) || capabilities.some(value => typeof value !== 'string')) {
      throw new Error('Invalid exchange');
    }
    const accepted = [];
    const lastAnswers = new Map(), finalAnswers = new Set();
    for (const event of events) {
      if (event?.type === 'assistant/message' && Array.isArray(event.content) && event.content.some(block =>
        (block.type === 'text' && block.text?.trim()) || ['file', 'image'].includes(block.type))) {
        lastAnswers.set(event.sessionId, event);
      } else if (event?.type === 'turn/end') {
        if (event.reason === 'completed' && lastAnswers.has(event.sessionId)) finalAnswers.add(lastAnswers.get(event.sessionId));
        lastAnswers.delete(event.sessionId);
      } else if (event?.type === 'user/message') lastAnswers.delete(event.sessionId);
    }
    this.store.transaction(() => {
      const previous = this.store.get(`gateway:${gatewayId}`, { revision: 0 });
      if (revision > previous.revision) {
        const present = new Set();
        for (const s of sessions) {
          if (typeof s.sessionId !== 'string' || !s.sessionId || typeof s.title !== 'string'
            || typeof s.archived !== 'boolean' || typeof s.running !== 'boolean') throw new Error('Invalid session');
          const key = sessionKey(gatewayId, s.sessionId);
          if (present.has(key)) throw new Error('Duplicate session');
          present.add(key);
          const old = this.session(key);
          const row = { ...old, key, gatewayId, sessionId: s.sessionId, title: s.title, blank: s.blank === true, archived: s.archived, deleted: false,
            epoch: (old?.epoch ?? 0) + (old && (old.archived !== s.archived || old.deleted) ? 1 : 0) };
          this.store.set(`session:${key}`, row);
          if (!old || old.title !== row.title || old.blank !== row.blank || old.archived !== row.archived || old.deleted) {
            this.store.enqueue(`lifecycle:${gatewayId}:${revision}:${digest(key)}`, 'telegram', {
              op: 'lifecycle', key, archived: row.archived, deleted: false, title: row.title,
            });
          }
          // Heartbeat is transient: after a disconnect it expires instead of leaving "typing" on forever.
          this.running.set(key, { running: s.running && !s.archived, until: this.now() + 10_000 });
        }
        // A successful full authoritative inventory is different from a socket loss or a session dispose.
        for (const [, old] of this.store.entries('session:')) {
          if (old.gatewayId !== gatewayId || present.has(old.key) || old.deleted) continue;
          this.store.set(`session:${old.key}`, { ...old, deleted: true, epoch: old.epoch + 1 });
          this.running.delete(old.key);
          this.store.enqueue(`lifecycle:${gatewayId}:${revision}:${digest(old.key)}`, 'telegram', {
            op: 'lifecycle', key: old.key, archived: old.archived, deleted: true, title: old.title,
          });
        }
        this.store.set(`gateway:${gatewayId}`, { revision, capabilities });
      }
      for (const event of events) {
        const artifact = event.type === 'artifact' && event.kind === 'artifact' && /^artifact:[a-f0-9-]{36}$/.test(event.id ?? '');
        if (typeof event.sessionId !== 'string' || typeof event.id !== 'string'
          || (!artifact && (!Number.isSafeInteger(event.seq) || event.seq < 0))) throw new Error('Invalid event');
        const key = sessionKey(gatewayId, event.sessionId);
        const row = this.session(key);
        if (!row) throw new Error('Event has no session');
        // Inventory may have been read just before the first prompt arrived.
        if (row.blank && ['user/message', 'assistant/message', 'artifact'].includes(event.type)
          && event.content?.some(block => (block.type === 'text' && block.text?.trim()) || ['file', 'image'].includes(block.type))) {
          this.store.set(`session:${key}`, { ...row, blank: false });
          this.store.enqueue(`lifecycle:content:${digest(key)}:${event.id}`, 'telegram', {
            op: 'lifecycle', key, archived: row.archived, deleted: row.deleted, title: row.title,
          });
        }
        const id = artifact ? `event:${digest(key)}:${event.id}` : `event:${digest(key)}:${event.seq}`;
        this.store.enqueue(id, 'telegram', { op: 'message', key,
          event: { ...event, finalReply: finalAnswers.has(event) }, epoch: this.session(key).epoch });
        accepted.push(event.id);
      }
      if (revision > previous.revision) this.interactions.reconcile(gatewayId, interactions, revision);
      for (const ack of acknowledgements) {
        const job = this.store.job(ack.id);
        if (!job || job.lane !== `gateway:${gatewayId}` || !['done', 'failed'].includes(ack.status)) continue;
        this.store.status(job.id, ack.status, ack.status === 'failed' ? 'gateway-rejected' : null);
        if (job.payload.kind === 'session-create') {
          this.creation.acknowledge(job.payload, ack);
          continue;
        }
        if (ack.status === 'failed') this.store.enqueue(`failure:${job.id}`, 'telegram', {
          op: 'notice', key: job.payload.key, text: 'Harness не принял сообщение. Подробности — в журнале шлюза.',
        });
      }
    });
    this.creation.reconcile();
    const commands = [];
    for (const { id, payload } of this.store.pending(`gateway:${gatewayId}`, this.now(), 20)) {
      if (payload.kind === 'session-create') {
        if (this.store.get(`gateway:${gatewayId}`)?.capabilities?.includes('session-create-v1')) commands.push({ id, ...payload });
        continue;
      }
      const row = this.session(payload.key);
      if (!row || row.archived || row.deleted) this.store.status(id, 'failed', 'session-inactive');
      else commands.push({ id, ...payload });
    }
    return { accepted, commands: boundedBatch(commands) };
  }
  /** Save both update and offset before acknowledging it to Telegram on the next poll. */
  ingest(updates) {
    this.store.transaction(() => {
      let offset = this.store.get('telegram:offset', 0);
      for (const update of updates) {
        if (!Number.isSafeInteger(update.update_id) || update.update_id < 0) throw new Error('Invalid update');
        if (update.update_id < offset) continue;
        this.store.enqueue(`update:${update.update_id}`, 'incoming', update);
        offset = Math.max(offset, update.update_id + 1);
      }
      this.store.set('telegram:offset', offset);
    });
  }
  async poll(signal) {
    const updates = await this.telegram.call('getUpdates', {
      offset: this.store.get('telegram:offset', 0), timeout: 25,
      allowed_updates: ['message', 'edited_message', 'callback_query'],
    }, null, signal);
    this.ingest(updates);
  }
  async receive() {
    for (const job of this.store.pending('incoming', this.now(), 20)) {
      const update = job.payload;
      if (update.callback_query) {
        if (!await this.creation.callback(update)) await this.interactions.callback(update);
        this.store.status(job.id, 'done'); continue;
      }
      const message = update.message ?? update.edited_message;
      if (!message || message.from?.id !== this.ownerId || message.from?.is_bot
        || message.chat?.type !== 'private' || message.chat.id !== this.ownerId) {
        this.store.status(job.id, 'done'); continue;
      }
      const row = this.store.entries('session:').map(([, r]) => r).find(r => r.topic === message.message_thread_id && !r.deleted && !r.archived);
      const navigation = this.creation.message(update, row);
      if (navigation) { this.store.status(job.id, navigation); continue; }
      if (!row) { this.store.status(job.id, 'done'); continue; }
      if (!update.edited_message && await this.interactions.text(message)) {
        this.store.status(job.id, 'done'); continue;
      }
      const { text, files } = inboundContent(message);
      if (!text.trim() && files.length === 0) { this.store.status(job.id, 'done'); continue; }
      // Start immediately, without waiting for the next running inventory or typing timer.
      // A fresh heartbeat is required: queued input on an offline machine is not activity.
      if (this.running.get(row.key)?.until > this.now()) {
        void this.telegram.call('sendChatAction', { ...this.address(row), action: 'typing' }, null,
          AbortSignal.timeout(1500)).catch(() => {});
      }
      try {
        const content = [];
        if (text) content.push({ type: 'text', text });
        for (const file of files) {
          const bytes = await this.telegram.download(file.fileId);
          content.push({ type: file.image ? 'image' : 'file', data: bytes.toString('base64'), name: file.name, mediaType: file.mediaType });
        }
        const requestId = `tg-sync:${this.ownerId}:${message.message_id}`;
        this.store.transaction(() => {
          const current = this.session(row.key);
          if (current.archived || current.deleted || current.epoch !== row.epoch || current.topic !== row.topic) {
            this.store.status(job.id, 'done'); return;
          }
          this.store.enqueue(`input:${update.update_id}`, `gateway:${row.gatewayId}`, {
            key: row.key, sessionId: row.sessionId, requestId,
            edit: Boolean(update.edited_message), correctionId: `tg-sync:edit:${update.update_id}`, content,
          });
          this.store.enqueue(`reaction:${update.update_id}`, 'telegram', { op: 'reaction', key: row.key, messageId: message.message_id });
          this.store.status(job.id, 'done');
        });
      } catch (error) {
        if (error.retryAfter || error.uncertain || error.code === 'download-failed') {
          this.store.status(job.id, 'pending', 'download-retry', this.now() + (error.retryAfter || 5) * 1000);
        }
        else {
          this.store.transaction(() => {
            this.store.status(job.id, 'failed', 'attachment-download-failed');
            this.store.enqueue(`failure:${job.id}`, 'telegram', { op: 'notice', key: row.key,
              text: 'Вложение не удалось получить из Telegram. Сообщение не передано в Harness; отправьте его повторно.' });
          });
        }
      }
    }
  }
  async deliver() {
    for (let count = 0; count < 100; count++) {
      const job = this.store.nextTelegram(this.now());
      if (!job) break;
      const row = this.session(job.payload.key);
      if (!row && job.payload.op !== 'navigation') { this.store.status(job.id, 'failed', 'session-missing'); continue; }
      // A failed/uncertain topic creation is a hard barrier, not a reason to create another topic.
      if (job.payload.op !== 'navigation' && job.payload.op !== 'lifecycle' && !row.topic && !row.deleted && !row.archived) {
        this.store.status(job.id, 'failed', 'topic-missing'); continue;
      }
      this.store.status(job.id, 'sending');
      try {
        await this.perform(job, row);
        this.store.status(job.id, 'done');
      } catch (error) {
        const uncertain = error.uncertain === true;
        this.store.status(job.id, uncertain ? 'uncertain' : error.retryAfter ? 'pending' : 'failed',
          uncertain ? 'send-result-unknown' : String(error.code ?? 'delivery-failed'),
          error.retryAfter ? this.now() + error.retryAfter * 1000 : 0);
        this.logger.warn?.(`telegram-sync: ${uncertain ? 'uncertain' : 'failed'} delivery ${job.id}`);
      }
    }
  }
  async receipt(jobId, step, send) {
    const key = `receipt:${jobId}:${step}`;
    const saved = this.store.get(key);
    if (saved) return saved;
    const result = await send();
    if (!positiveId(result?.message_id)) {
      const error = new Error('Invalid Telegram send receipt'); error.uncertain = true; throw error;
    }
    this.store.set(key, result);
    return result;
  }
  async perform(job, row) {
    const { op } = job.payload;
    if (op === 'navigation') return this.creation.perform(job);
    if (op === 'lifecycle') {
      if (job.payload.archived || job.payload.deleted) {
        if (row.topic) {
          await this.telegram.call('deleteForumTopic', this.address(row));
          this.store.set(`session:${row.key}`, { ...this.session(row.key), topic: null, renderedTitle: null });
        }
        return;
      }
      if (row.archived || row.deleted || (row.blank && !row.topic)) return;
      const title = job.payload.title || row.sessionId;
      const name = Array.from(row.plainTitle ? title : `[${row.gatewayId}] ${title}`).slice(0, 128).join('');
      // User-created Telegram topics already exist; only bind them after durable Host ACK.
      if (!row.topic && this.creation.destination(row.key)) return;
      if (!row.topic) {
        const topic = await this.telegram.call('createForumTopic', { chat_id: this.ownerId, name });
        if (!positiveId(topic?.message_thread_id)) { const e = new Error('Invalid topic receipt'); e.uncertain = true; throw e; }
        this.store.set(`session:${row.key}`, { ...this.session(row.key), topic: topic.message_thread_id, renderedTitle: name });
      } else if (row.renderedTitle !== name) {
        await this.telegram.call('editForumTopic', { ...this.address(row), name });
        this.store.set(`session:${row.key}`, { ...this.session(row.key), renderedTitle: name });
      }
      this.creation.bound(row.key);
      return;
    }
    if (row.archived || row.deleted || (op === 'message' && job.payload.epoch !== row.epoch)) return;
    if (op === 'interaction') return this.interactions.perform(job, row);
    if (op === 'reaction') {
      await this.telegram.call('setMessageReaction', { chat_id: this.ownerId, message_id: job.payload.messageId,
        reaction: [{ type: 'emoji', emoji: '👀' }] });
      return;
    }
    const event = job.payload.event;
    if (op === 'message' && event.type === 'turn/end') {
      const text = terminalNotification(event.reason);
      // Successful replies carry their own alert; never append a generic success footer.
      if (event.reason !== 'completed' && this.notifications.completion && text) await this.receipt(job.id, 0,
        () => this.telegram.call('sendMessage', { ...this.address(row), text, disable_notification: false }));
      return;
    }
    if (op === 'message' && (!['user/message', 'assistant/message', 'artifact'].includes(event.type)
      || (event.type === 'user/message' && (event.source?.kind !== 'user' || event.source?.form === 'notice' || event.source?.rpcId?.startsWith('tg-sync:'))))) return;
    const content = op === 'notice' ? [{ type: 'text', text: job.payload.text }] : event.content;
    if (!Array.isArray(content)) throw new Error('Invalid content');
    let step = 0;
    const role = event?.type === 'user/message' ? 'Вы: ' : '';
    const mirrorKey = seq => `mirror:${digest(row.key)}:${row.epoch}:${seq}`;
    const replaced = event?.surfaceOp?.op === 'replace' ? event.surfaceOp : null;
    const previous = replaced && replaced.startSeq === replaced.endSeq
      ? this.store.get(mirrorKey(replaced.startSeq)) : null;
    const renderText = text => event?.type === 'assistant/message'
      ? formatMarkdown(text) : splitText(text).map(text => ({ text }));
    const singleText = content.length === 1 && content[0].type === 'text' ? renderText(role + content[0].text) : null;
    if (previous?.length === 1 && previous[0].kind === 'text' && singleText?.length === 1) {
      const receipt = await this.receipt(job.id, 0, () => this.telegram.call('editMessageText', {
        chat_id: this.ownerId, message_id: previous[0].message_id, ...singleText[0],
      }));
      const mention = event.type === 'assistant/message' && this.notifications.mentions
        && mentionsOwner(singleText[0], this.ownerId, this.ownerUsername);
      if (mention && !previous[0].notifiedOwner) await this.receipt(job.id, 1,
        () => this.telegram.call('sendMessage', { ...this.address(row),
          text: '🔔 Тебя упомянули в обновлённом ответе Harness.', disable_notification: false }));
      this.store.set(mirrorKey(event.seq), [{ message_id: receipt.message_id, kind: 'text',
        notifiedOwner: Boolean(previous[0].notifiedOwner || mention) }]);
      return;
    }
    const mirrored = [];
    let finalAlertUsed = false;
    const deliverySilent = (payload, allowMention) => {
      if (this.notifications.completion && event?.finalReply && !finalAlertUsed) {
        finalAlertUsed = true;
        return false;
      }
      return this.silent(payload, allowMention);
    };
    if (replaced) {
      const receipt = await this.receipt(job.id, step++, () => this.telegram.call('sendMessage', {
        ...this.address(row), text: 'Исправление сообщения в Harness:', disable_notification: this.silent({}, false),
      }));
      mirrored.push({ message_id: receipt.message_id, kind: 'notice' });
    }
    for (const block of content) {
      if (block.type === 'text') {
        for (const payload of singleText ?? renderText(role + block.text)) {
          const disableNotification = deliverySilent(payload, event?.type === 'assistant/message');
          const receipt = await this.receipt(job.id, step++, () => this.telegram.call('sendMessage', { ...this.address(row), ...payload,
            disable_notification: disableNotification }));
          mirrored.push({ message_id: receipt.message_id, kind: 'text', notifiedOwner: event?.type === 'assistant/message'
            && this.notifications.mentions && mentionsOwner(payload, this.ownerId, this.ownerUsername) });
        }
      } else if (block.data && ['file', 'image'].includes(block.type)) {
        const bytes = Buffer.from(block.data, 'base64');
        const photo = block.type === 'image' && bytes.length <= 10 * 1024 * 1024
          && block.width > 0 && block.height > 0 && block.width + block.height <= 10000
          && Math.max(block.width / block.height, block.height / block.width) <= 20;
        const field = photo ? 'photo' : 'document';
        const disableNotification = deliverySilent({}, false);
        const receipt = await this.receipt(job.id, step++, () => this.telegram.call(photo ? 'sendPhoto' : 'sendDocument',
          { ...this.address(row), disable_notification: disableNotification },
          { field, bytes, name: block.name ?? 'attachment', mediaType: block.mediaType }));
        mirrored.push({ message_id: receipt.message_id, kind: 'media' });
      }
    }
    if (event && event.type !== 'artifact') this.store.set(mirrorKey(event.seq), mirrored);
  }
  async typing() {
    for (const [key, state] of this.running) {
      const row = this.session(key);
      if (!state.running || state.until <= this.now() || !row?.topic || row.archived || row.deleted) continue;
      try { await this.telegram.call('sendChatAction', { ...this.address(row), action: 'typing' }); }
      catch { /* Ephemeral status is best effort and cannot block durable delivery. */ }
    }
  }
}
