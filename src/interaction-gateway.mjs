import { randomBytes } from 'node:crypto';

const token = () => randomBytes(15).toString('base64url');
const questionError = (message, code = 'ASK_ABORTED') => Object.assign(new Error(message), { code });

export function validAnswer(questions, answer) {
  if (!Array.isArray(answer?.answers) || answer.answers.length !== questions.length) return false;
  const seen = new Set();
  return questions.every(question => {
    const item = answer.answers.find(item => item?.id === question.id);
    if (!item || seen.has(item.id) || !Array.isArray(item.selected)
      || new Set(item.selected).size !== item.selected.length
      || item.selected.some(label => !question.options?.some(option => option.label === label))
      || (item.custom !== undefined && (typeof item.custom !== 'string' || !item.custom.trim()))
      || (!question.multiSelect && (item.selected.length > 1 || (item.custom !== undefined && item.selected.length)))) return false;
    if (question.intent?.kind === 'approval' && (item.custom !== undefined || item.selected.length !== 1)) return false;
    seen.add(item.id);
    return true;
  });
}

/** A remote answer can settle only this exact live request, never a later tool call. */
export class GatewayInteractions {
  constructor({ ctx, store, adapter, logger = console, now = Date.now }) {
    Object.assign(this, { ctx, store, adapter, logger, now });
    this.pending = new Map();
    this.continued = new Map();
    this.awaiting = new Map();
    this.details = new Map();
    this.disposers = [
      ctx.on('user-questions/request', (request, next) => this.ask('question', request, next), { global: true, prepend: true }),
      ctx.on('approval/request', (request, next) => this.ask('approval', request, next), { global: true, prepend: true }),
      ctx.on('session/event', (session, event) => this.observeSessionEvent(session, event), { global: true }),
    ];
  }
  eligible(agent) {
    return Boolean(agent && this.ctx.agents.get(agent.id) === agent && this.ctx.agents.roots().includes(agent)
      && !new Set(this.ctx.workspaceRegistry.archivedSessionIds).has(agent.session.id));
  }
  observeSessionEvent(session, event) {
    const id = session.id ?? session.sessionId;
    if (event.type === 'tool/call') this.details.set(`${id}:${event.data.callId}`, { name: event.data.name, arguments: event.data.arguments });
    if (event.type === 'turn/end') {
      for (const key of this.details.keys()) if (key.startsWith(`${id}:`)) this.details.delete(key);
    }
  }
  async ask(kind, request, next) {
    if (!this.eligible(request.agent)) return next();
    const outer = request.signal;
    if (outer?.aborted) {
      if (kind === 'approval') return 'cancelled';
      throw questionError('Question cancelled');
    }
    const sessionId = request.agent.session.id;
    const callId = kind === 'question' ? request.wait?.callId : request.callId;
    const identity = callId && `question-token:${sessionId}:${callId}`;
    const savedToken = identity && this.store.get(identity);
    const wire = { token: savedToken ?? token(), sessionId, kind };
    if (kind === 'question') {
      wire.questions = structuredClone(request.questions);
      if (identity) this.store.set(identity, wire.token);
    } else {
      wire.toolName = request.toolName;
      // Auto review supplies LocalizedText; the relay accepts only plain text.
      wire.reason = [request.displayReason, request.displayReason?.ru, request.displayReason?.en, request.reason]
        .find(value => typeof value === 'string') ?? '';
      const detail = this.details.get(`${sessionId}:${callId}`);
      wire.details = detail?.name === request.toolName ? detail.arguments : '';
    }
    const lifetime = new AbortController();
    request.signal = lifetime.signal;
    let resolveRemote, rejectRemote;
    const remote = new Promise((resolve, reject) => { resolveRemote = resolve; rejectRemote = reject; });
    const pending = { wire, request, callId, resolve: resolveRemote, reject: rejectRemote };
    this.pending.set(wire.token, pending);
    const abort = () => {
      if (kind === 'question' && request.wait?.timed && outer.reason?.code === 'ASK_TIMED_OUT') {
        this.awaiting.set(wire.token, { wire, callId, until: this.now() + 15_000 });
      }
      if (kind === 'approval') resolveRemote('cancelled');
      else rejectRemote(questionError('Question cancelled', outer.reason?.code ?? 'ASK_ABORTED'));
      lifetime.abort(outer.reason);
    };
    outer?.addEventListener('abort', abort, { once: true });
    // The original Turn signal is never aborted to retire the losing GUI card.
    const native = Promise.resolve().then(next).then(value => {
      if (kind === 'approval' && !['allowed-once', 'rejected'].includes(value)) return new Promise(() => {});
      return value;
    }, error => {
      if (kind === 'question' && error?.code === 'ASK_TIMED_OUT') {
        if (request.wait?.callId) this.awaiting.set(wire.token, { wire, callId, until: this.now() + 15_000 });
        throw error;
      }
      if (error?.code !== 'NO_PROVIDER' && error?.code !== 'ASK_ABORTED') this.logger.warn?.('telegram-sync: native interaction provider unavailable');
      return new Promise(() => {});
    });
    try { return await Promise.race([native, remote]); }
    finally {
      this.pending.delete(wire.token);
      outer?.removeEventListener('abort', abort);
      lifetime.abort(questionError('Interaction settled'));
      if (request.signal === lifetime.signal) request.signal = outer;
    }
  }
  async refresh(sessions, signal) {
    const available = new Set(sessions.filter(session => !session.archived && session.readable).map(session => session.sessionId));
    const current = new Map([...this.continued].filter(([, entry]) => available.has(entry.wire.sessionId)));
    for (const session of sessions) {
      if (session.archived || !session.readable) continue;
      let projection;
      try { projection = await this.adapter.invoke('projections', { sessionId: session.sessionId }, signal); }
      catch { continue; }
      for (const [id, entry] of current) if (entry.wire.sessionId === session.sessionId) current.delete(id);
      for (const item of projection?.values?.userQuestions?.active ?? []) {
        if (item.state !== 'continued') continue;
        const identity = `question-token:${session.sessionId}:${item.callId}`;
        let id = this.store.get(identity);
        if (!id) { id = token(); this.store.set(identity, id); }
        if (this.pending.has(id)) continue;
        const wire = { token: id, sessionId: session.sessionId, kind: 'question', questions: item.questions };
        current.set(id, { wire, callId: item.callId });
        this.awaiting.delete(id);
      }
    }
    this.continued = current;
    for (const [id, entry] of this.awaiting) if (entry.until <= this.now()) this.awaiting.delete(id);
  }
  snapshot() {
    const entries = [...this.continued.values(), ...this.awaiting.values(), ...this.pending.values()];
    return [...new Map(entries.map(entry => [entry.wire.token, entry.wire])).values()];
  }
  async answer(command, signal) {
    const pending = this.pending.get(command.token);
    const late = this.continued.get(command.token);
    const entry = pending ?? late;
    if (!entry && this.awaiting.has(command.token)) throw questionError('Waiting for durable continued question', 'QUESTION_NOT_READY');
    if (!entry || entry.wire.sessionId !== command.sessionId) throw questionError('Interaction expired', 'INTERACTION_EXPIRED');
    if (entry.wire.kind === 'approval') {
      const decision = command.answer?.decision;
      if (!pending || !this.eligible(pending.request.agent) || !['allowed-once', 'rejected'].includes(decision)) throw questionError('Invalid approval', 'BAD_ANSWER');
      pending.resolve(decision);
      return;
    }
    if (!validAnswer(entry.wire.questions, command.answer)) throw questionError('Invalid answer', 'BAD_ANSWER');
    if (pending) {
      if (!this.eligible(pending.request.agent)) throw questionError('Interaction owner gone', 'INTERACTION_EXPIRED');
      pending.resolve(command.answer);
    } else {
      const accepted = await this.ctx.typertGateway.invoke({ namespace: 'userQuestions', method: 'answer',
        args: { agentId: command.sessionId, callId: late.callId, answer: command.answer }, peer: this.adapter.peer, signal });
      if (!accepted) throw questionError('Question no longer continued', 'INTERACTION_EXPIRED');
      const session = this.ctx.sessions.get(command.sessionId);
      if (session) await this.ctx.sessions.flush(session);
      this.continued.delete(command.token);
    }
  }
  dispose() {
    for (const pending of this.pending.values()) {
      if (pending.wire.kind === 'approval') pending.resolve('cancelled');
      else pending.reject(questionError('Plugin stopped'));
    }
    this.pending.clear();
    this.continued.clear();
    this.awaiting.clear();
    for (const dispose of this.disposers) dispose?.();
  }
}
