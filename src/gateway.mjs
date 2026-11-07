import { boundedBatch } from './store.mjs';
import { isAbsolute, parse, resolve } from 'node:path';
import { terminalNotification } from './notifications.mjs';

const MAX_TRANSFER = 20 * 1024 * 1024;
const emptyMessage = event => ['user/message', 'assistant/message'].includes(event.type)
  && Array.isArray(event.content) && event.content.length === 0;

/** Host adapter uses the installed DSH 0.2.2-rc.1 services; no direct JSONL mutations. */
export class HarnessAdapter {
  constructor(ctx, { newSessionCwd } = {}) {
    this.ctx = ctx;
    this.newSessionCwd = newSessionCwd;
    this.peer = ctx.connection.createPeer({ principal: { kind: 'owner' }, interactions: 'none' });
  }
  invoke(method, request, signal) {
    return this.ctx.typertGateway.invoke({ namespace: 'session', method,
      args: method === 'list' ? { _request: {} } : { request }, peer: this.peer, signal });
  }
  async inventory(signal) {
    // Full Host query prevents a cold session without cwd from looking like a deletion.
    const records = await this.ctx.sessionQuery.listSessions(signal);
    const { items } = await this.invoke('list', {}, signal);
    const summaries = new Map(items.map(item => [item.sessionId, item]));
    const archived = new Set(this.ctx.workspaceRegistry.archivedSessionIds);
    return records.filter(r => r.header.origin === undefined).map(({ header, formatStatus }) => ({
      sessionId: header.id,
      title: summaries.get(header.id)?.projections?.values?.title ?? header.id,
      archived: archived.has(header.id),
      running: this.ctx.agents.get(header.id)?.status === 'running',
      blank: summaries.get(header.id)?.blank === true,
      readable: formatStatus !== 'migration-required',
    }));
  }
  page(sessionId, extra = {}, signal) {
    return this.invoke('events', { address: { kind: 'session', sessionId }, maxMessages: 100, ...extra }, signal);
  }
  async content(blocks, signal) {
    const content = [];
    let transferred = 0;
    for (const block of blocks ?? []) {
      if (block.type === 'text') { content.push({ type: 'text', text: block.text }); continue; }
      if (!['image', 'file'].includes(block.type)) continue;
      const ref = block.attachment;
      if (!ref || ref.bytes > MAX_TRANSFER) throw new Error('Attachment exceeds bridge transfer limit');
      let bytes;
      if (block.type === 'image') bytes = Buffer.from((await this.ctx.attachments.readImage(ref, signal)).data);
      else {
        const chunks = [];
        let size = 0;
        for await (const chunk of this.ctx.attachments.readFileStream(ref, signal)) {
          size += chunk.length;
          if (size > MAX_TRANSFER) throw new Error('Attachment exceeds bridge transfer limit');
          chunks.push(chunk);
        }
        bytes = Buffer.concat(chunks);
      }
      transferred += bytes.length;
      if (transferred > MAX_TRANSFER) throw new Error('Message attachments exceed bridge transfer limit');
      content.push({ type: block.type, data: bytes.toString('base64'), name: ref.name, mediaType: ref.mediaType,
        ...(block.type === 'image' ? { width: ref.width, height: ref.height } : {}) });
    }
    return content;
  }
  async createSession(command, store, signal) {
    const mark = `create:${command.id}`;
    let phase = store.get(mark);
    if (phase?.sessionId && phase.sessionId !== command.sessionId) throw new Error('Creation identity changed');
    if (phase?.status === 'done') return;
    const cwd = phase?.cwd ?? this.newSessionCwd ?? this.ctx.workingDirectory.defaultDirectory;
    if (typeof cwd !== 'string' || !isAbsolute(cwd) || resolve(cwd) === parse(cwd).root) throw new Error('Configure Host defaultDirectory before creating a dialogue');
    if (!phase) {
      phase = { status: 'prepared', sessionId: command.sessionId, cwd, title: command.title };
      store.set(mark, phase);
    }
    let records;
    try { records = await this.ctx.sessionQuery.listSessions(signal); }
    catch {
      const error = new Error('Host inventory unavailable'); error.code = 'CREATE_NOT_READY'; throw error;
    }
    const record = records.find(item => item.header.id === command.sessionId);
    const uncertain = () => { const error = new Error('Creation outcome requires reconciliation'); error.creationUncertain = true; return error; };
    if (record && (phase.status === 'prepared' || record.header.origin !== undefined || record.header.cwd !== cwd
      || new Set(this.ctx.workspaceRegistry.archivedSessionIds).has(command.sessionId))) throw uncertain();
    if (!record && phase.status !== 'prepared') throw uncertain();
    if (!record) {
      phase = { ...phase, status: 'creating' };
      store.set(mark, phase);
      try {
        const result = await this.invoke('create', { sessionId: command.sessionId, cwd }, signal);
        if (result.sessionId !== command.sessionId) {
          store.set(mark, { ...phase, actualId: result.sessionId });
          throw uncertain();
        }
        phase = { ...phase, status: 'created' };
        store.set(mark, phase);
      } catch { throw uncertain(); }
    }
    try {
      const { items } = await this.invoke('list', {}, signal);
      const title = items.find(item => item.sessionId === command.sessionId)?.projections?.values?.title;
      if (!title) {
        if (phase.renameStarted) throw uncertain();
        phase = { ...phase, renameStarted: true };
        store.set(mark, phase);
        await this.invoke('rename', { sessionId: command.sessionId, title: phase.title }, signal);
      } else if (!this.ctx.sessions.get(command.sessionId)) {
        // Resume the exact cold identity without repeating create or overwriting its title.
        await this.invoke('state', { sessionId: command.sessionId }, signal);
      }
      const session = this.ctx.sessions.get(command.sessionId);
      if (!session || !await this.ctx.sessions.flush(session)) throw uncertain();
      store.set(mark, { ...phase, status: 'done' });
    } catch { throw uncertain(); }
  }
  async repairCreationCwd(command, store, signal) {
    const marker = `cwd-repair:${command.id}`;
    if (store.get(marker)?.status === 'done') return;
    const creation = store.get(`create:${command.creationId}`);
    const cwd = this.newSessionCwd;
    if (!creation || creation.status !== 'done' || creation.sessionId !== command.sessionId
      || creation.cwd !== command.expectedOldCwd || typeof cwd !== 'string' || !isAbsolute(cwd)
      || resolve(cwd) === parse(cwd).root) throw new Error('Creation directory repair is not authorized');
    const found = await this.ctx.sessionController.resolveAgent(command.sessionId);
    if ('error' in found) throw found.error;
    const agent = found.agent;
    if (agent.status === 'running') { const error = new Error('Session is running'); error.code = 'CREATE_NOT_READY'; throw error; }
    const current = this.ctx.workingDirectory.get(agent.session);
    if (current !== command.expectedOldCwd && current !== cwd) {
      store.set(marker, { status: 'done', changed: false, cwd: current, sessionId: command.sessionId });
      return;
    }
    if (current !== cwd) {
      let page = await this.page(command.sessionId, {}, signal);
      const throughSeq = page.cursor;
      while (true) {
        if (page.records.some(r => ['turn/start', 'user/message', 'assistant/message'].includes(r.event?.type))) {
          throw new Error('Do not relocate a used conversation automatically');
        }
        const oldest = page.records[0]?.event?.seq;
        if (!page.hasMore || oldest === undefined) break;
        page = await this.page(command.sessionId, { throughSeq, beforeSeq: oldest }, signal);
      }
      await this.ctx.workingDirectory.set(agent, cwd, signal);
    }
    if (!await this.ctx.sessions.flush(agent.session)) throw new Error('Directory repair is not durable');
    store.set(marker, { status: 'done', changed: true, cwd, sessionId: command.sessionId });
  }
  async submit(command, store, signal) {
    if (new Set(this.ctx.workspaceRegistry.archivedSessionIds).has(command.sessionId)) throw new Error('Session is archived');
    let requestId = command.requestId;
    let input = command.content;
    if (command.edit) {
      const mark = `edit:${command.id}`;
      const phase = store.get(mark);
      if (phase === 'done') return;
      if (phase === 'editing') throw new Error('Queue edit outcome unknown; inspect Harness before retry');
      const state = await this.invoke('state', { sessionId: command.sessionId }, signal);
      const queued = state.queue?.find(item => item.rpcId === command.requestId);
      if (queued && input.every(b => b.type === 'text')) {
        store.set(mark, 'editing');
        await this.invoke('updateQueue', { sessionId: command.sessionId, itemId: queued.id,
          action: { kind: 'edit', content: input } }, signal);
        const session = this.ctx.sessions.get(command.sessionId);
        if (session) await this.ctx.sessions.flush(session);
        store.set(mark, 'done');
        return;
      }
      // DSH has no historical message-edit endpoint. Preserve the old record and submit an explicit correction.
      requestId = command.correctionId;
      input = [{ type: 'text', text: 'Исправление ранее отправленного сообщения из Telegram:' }, ...input];
    }
    const content = [];
    for (const block of input) {
      if (block.type !== 'file') { content.push(block); continue; }
      const data = Buffer.from(block.data, 'base64');
      const uploaded = await this.ctx.fileUploads.uploadStream({ sessionId: command.sessionId,
        name: block.name, data: (async function* () { yield data; })(), signal });
      content.push({ type: 'file', receiptId: uploaded.receiptId });
    }
    await this.invoke('prompt', { requestId, sessionId: command.sessionId, mode: 'queue', content }, signal);
    const session = this.ctx.sessions.get(command.sessionId);
    if (session) await this.ctx.sessions.flush(session);
  }
  close() { return this.peer.dispose(); }
}

export class Gateway {
  constructor({ adapter, client, store, interactions = null, artifacts = null, notifyTurns = false, logger = console }) {
    Object.assign(this, { adapter, client, store, interactions, artifacts, notifyTurns, logger });
  }
  async collect(sessions, signal) {
    // First connection starts at the current cut for existing sessions, never floods old history.
    let initial = this.store.get('initial:sessions');
    if (initial === null) {
      initial = sessions.map(s => s.sessionId);
      this.store.set('initial:sessions', initial);
    }
    for (const session of sessions) {
      if (!session.readable) continue;
      const key = `cursor:${session.sessionId}`;
      const previous = this.store.get(key);
      try {
        let page = await this.adapter.page(session.sessionId, {}, signal);
        if (previous === null && initial.includes(session.sessionId)) {
          this.store.set(key, page.cursor); continue;
        }
        const cursor = previous ?? -1;
        if (page.cursor < cursor) throw new Error('Session log moved backwards');
        const throughSeq = page.cursor;
        const entries = [];
        while (true) {
          const events = page.records.map(record => {
            if (record.type !== 'event') throw new Error('Unsupported history record');
            return record.event;
          });
          entries.unshift(...events.filter(event => event.seq > cursor));
          const oldest = events[0]?.seq;
          if (!page.hasMore || oldest === undefined || oldest <= cursor) break;
          const next = await this.adapter.page(session.sessionId, { throughSeq, beforeSeq: oldest }, signal);
          if (next.records.length && next.records[0].event.seq >= oldest) throw new Error('History page made no progress');
          page = next;
        }
        for (const event of entries) {
          this.artifacts?.observeSessionEvent({ sessionId: session.sessionId }, event);
          this.interactions?.observeSessionEvent({ sessionId: session.sessionId }, event);
          let normalized;
          if (['user/message', 'assistant/message'].includes(event.type)) {
            const source = event.data.source;
            const ownInput = source?.rpcId?.startsWith('tg-sync:');
            const visibleUser = event.type !== 'user/message' || (source?.kind === 'user' && source?.form !== 'notice' && !ownInput);
            if (visibleUser) normalized = { id: `${session.sessionId}:${event.seq}`, sessionId: session.sessionId,
              seq: event.seq, type: event.type, source,
              surfaceOp: event.surfaceOp,
              content: await this.adapter.content(event.type === 'assistant/message' ? event.data.message.content : event.data.content, signal) };
          }
          const endReason = typeof event.data?.reason === 'string' ? event.data.reason : event.data?.reason?.kind;
          if (this.notifyTurns && event.type === 'turn/end' && terminalNotification(endReason)) {
            normalized = { id: `${session.sessionId}:${event.seq}`, sessionId: session.sessionId,
              seq: event.seq, type: 'turn/end', reason: endReason };
          }
          this.store.transaction(() => {
            if (normalized && !emptyMessage(normalized)) this.store.enqueue(normalized.id, 'outgoing', normalized);
            this.store.set(key, event.seq);
          });
        }
        this.store.set(key, throughSeq);
      } catch {
        this.logger.warn?.(`telegram-sync: history read failed for ${session.sessionId}; cursor retained`);
      }
    }
  }
  async tick(signal) {
    const sessions = await this.adapter.inventory(signal);
    // Capture requests before history: a request arising after its history cut waits for the next tick.
    const requests = this.interactions?.snapshot() ?? [];
    await this.collect(sessions, signal);
    await this.interactions?.refresh(sessions, signal);
    const revision = this.store.get('revision', 0) + 1;
    this.store.set('revision', revision);
    const ids = new Set(sessions.map(s => s.sessionId));
    const ready = this.store.pending('outgoing', Date.now(), 100);
    const discarded = ready.filter(job => emptyMessage(job.payload));
    this.store.transaction(() => {
      for (const job of discarded) this.store.status(job.id, 'done');
    });
    const outgoing = boundedBatch(ready.filter(job => !emptyMessage(job.payload)));
    const events = outgoing.filter(job => ids.has(job.payload.sessionId)).map(job => job.payload);
    const eventIds = events.map(event => event.id);
    const liveTokens = new Set((this.interactions?.snapshot() ?? []).map(request => request.token));
    const interactions = requests.filter(request => liveTokens.has(request.token)
      && (this.store.get(`interaction:announced:${request.token}`)
        || !this.store.hasPendingSession('outgoing', request.sessionId, eventIds)));
    const acknowledgements = this.store.pending('acknowledgements', Date.now(), 100).map(job => job.payload);
    // The relay may commit this snapshot even if its response is lost.
    this.store.transaction(() => {
      for (const request of interactions) this.store.set(`interaction:announced:${request.token}`, true);
    });
    const response = await this.client.exchange({ revision, sessions, events, acknowledgements,
      interactions,
      capabilities: [
        ...(typeof this.adapter.createSession === 'function' ? ['session-create-v1'] : []),
        ...(typeof this.adapter.repairCreationCwd === 'function' ? ['creation-cwd-repair-v1'] : []),
      ] }, signal);
    this.store.transaction(() => {
      for (const id of response.accepted) this.store.status(id, 'done');
      for (const job of outgoing) if (!ids.has(job.payload.sessionId)) this.store.status(job.id, 'done');
      for (const ack of acknowledgements) this.store.status(`ack:${ack.id}`, 'done');
      for (const command of response.commands) this.store.enqueue(command.id, 'commands', command);
    });
    for (const job of this.store.pending('commands', Date.now(), 20)) {
      const command = job.payload;
      let status = 'done', uncertain = false;
      try {
        if (command.kind === 'creation-cwd-repair') {
          await this.adapter.repairCreationCwd(command, this.store, signal);
        } else if (command.kind === 'session-create') {
          if (!this.adapter.createSession) throw new Error('Session creation is unsupported');
          await this.adapter.createSession(command, this.store, signal);
        } else if (command.kind === 'interaction-answer') {
          if (!this.interactions) throw new Error('Interaction service not installed');
          await this.interactions.answer(command, signal);
        } else await this.adapter.submit(command, this.store, signal);
      } catch (error) {
        if (['QUESTION_NOT_READY', 'CREATE_NOT_READY'].includes(error.code)) {
          this.store.status(job.id, 'pending', error.code === 'CREATE_NOT_READY' ? 'create-not-ready' : 'question-not-ready', Date.now() + 2000); continue;
        }
        // Do not execute a failed task on another machine or acknowledge success.
        status = 'failed'; uncertain = error.creationUncertain === true;
        this.logger.warn?.(`telegram-sync: Harness rejected ${job.id}`);
      }
      this.store.transaction(() => {
        this.store.status(job.id, status);
        this.store.enqueue(`ack:${job.id}`, 'acknowledgements', { id: job.id, status, ...(uncertain ? { uncertain: true } : {}) });
      });
    }
    return (response.accepted.length > 0 || discarded.length > 0)
      && this.store.pending('outgoing', Date.now(), 1).length > 0;
  }
}
