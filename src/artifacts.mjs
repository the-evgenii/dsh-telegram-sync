import { randomUUID } from 'node:crypto';
import { basename, isAbsolute } from 'node:path';

export const ARTIFACT_TOOL = 'telegram_sync_return_file';
export const MAX_ARTIFACT_BYTES = 20 * 1024 * 1024;
const HELD = 'artifacts:held';

function refusal(code, message) {
  return Object.assign(new Error(message), { code });
}

function sessionIdOf(session) {
  return typeof session === 'string' ? session : session?.id ?? session?.sessionId;
}

function requireFile(info, limit) {
  if (!info) throw refusal('artifact-not-found', 'File not found.');
  if (info.type !== 'file') throw refusal('artifact-not-file', 'Only regular files can be returned.');
  if (!Number.isSafeInteger(info.size) || info.size < 0 || info.size > limit) {
    throw refusal('artifact-too-large', `File must not exceed ${limit} bytes.`);
  }
  if (typeof info.version !== 'string' || !info.version) {
    throw refusal('artifact-version-unavailable', 'The filesystem cannot verify a stable file snapshot.');
  }
}

function fileName(path) {
  return [...basename(path).replace(/[\u0000-\u001f\u007f]/g, '').replace(/\p{Cf}/gu, '').trim()]
    .slice(0, 200).join('') || 'result.bin';
}

// File payloads deliberately remain documents: no extension-based image sniffing or conversion.
// This preserves the exact source bytes, including images, and avoids claiming an unverified MIME type.
async function snapshot(ctx, exec, path, limit) {
  if (typeof path !== 'string' || !path.trim() || path.includes('\0') || /^[a-z][a-z+.-]*:\/\//i.test(path)) {
    throw refusal('artifact-invalid-path', 'A non-empty local file path is required.');
  }
  exec.signal.throwIfAborted();
  const cwd = typeof ctx.workingDirectory?.ensure === 'function'
    ? await ctx.workingDirectory.ensure(exec.agent, exec.signal) : exec.agent.session.header?.cwd;
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) {
    throw refusal('artifact-cwd-unavailable', 'The Session working directory is unavailable.');
  }
  const options = { cwd, signal: exec.signal };
  // Resolve and read only through the composed execution-world filesystem. Never use host node:fs.
  const entry = await ctx.fs.lstat(path, { cwd }, exec.signal);
  requireFile(entry, limit); // As with DSH present, reject a symlink in the final path component.
  const target = await ctx.fs.resolve(path, options);
  const before = await ctx.fs.stat(target, exec.signal);
  requireFile(before, limit);
  const raw = await ctx.fs.readBytes(target, exec.signal, limit);
  exec.signal.throwIfAborted();
  if (!(raw instanceof Uint8Array) || raw.byteLength > limit) {
    throw refusal('artifact-too-large', 'The filesystem returned an invalid or oversized file snapshot.');
  }
  // Own the bytes before another operation can mutate a provider-owned buffer.
  const bytes = Buffer.from(raw);
  const fresh = await ctx.fs.resolve(path, options);
  const after = await ctx.fs.stat(fresh, exec.signal);
  const finalEntry = await ctx.fs.lstat(path, { cwd }, exec.signal);
  exec.signal.throwIfAborted();
  if (target.targetKey !== fresh.targetKey || after?.type !== 'file'
    || before.version !== after.version || before.size !== after.size || before.size !== bytes.length
    || entry.version !== finalEntry?.version || finalEntry?.type !== 'file') {
    throw refusal('artifact-changed', 'The file changed while its bytes were being prepared. Retry with the final file.');
  }
  return { type: 'file', name: fileName(target.displayPath), data: bytes.toString('base64') };
}

/**
 * Install the two-phase file tool. A successful authoritative tools/result (and every
 * Code Mode ancestor) creates an outgoing job in held state. Only a completed turn/end
 * makes it pending; cancelled/failed turns discard it. No network operation runs here.
 * Replay each raw history event through observeSessionEvent(sessionOrId, event) to
 * release durable held jobs after a restart; the observer also accepts {sessionId}.
 */
export function installArtifacts(ctx, { store, maxBytes = MAX_ARTIFACT_BYTES, enabled = () => true } = {}) {
  if (!store || !['get', 'set', 'enqueue', 'job', 'status', 'transaction'].every(k => typeof store[k] === 'function')) {
    throw new TypeError('Artifacts require the durable gateway Store.');
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_ARTIFACT_BYTES) {
    throw new RangeError('Artifact limit must be between 1 byte and 20 MiB.');
  }
  if (typeof enabled !== 'function' || typeof ctx?.tools?.register !== 'function'
    || typeof ctx?.on !== 'function' || typeof ctx?.agents?.turnBoundaryOf !== 'function'
    || !['resolve', 'stat', 'lstat', 'readBytes'].every(k => typeof ctx.fs?.[k] === 'function')) {
    throw new TypeError('Artifacts require DSH tools, turn-boundary projection, and the composed binary filesystem.');
  }
  const staged = new Map();
  const ancestors = new Map();
  const disposers = [];
  let disposed = false;

  const open = artifact => {
    const boundary = ctx.agents.turnBoundaryOf(artifact.session);
    return Number.isSafeInteger(boundary?.openTurnStartSeq) && boundary.openTurnStartSeq >= 0
      && boundary.lastTurn === artifact.turn;
  };
  const commit = artifacts => {
    if (disposed) return;
    const active = artifacts.filter(open);
    if (!active.length) return;
    store.transaction(() => {
      const held = store.get(HELD, []);
      for (const artifact of active) {
        const { session, ...payload } = artifact;
        if (!store.enqueue(payload.id, 'outgoing', payload)) continue;
        store.status(payload.id, 'held');
        held.push({ id: payload.id, sessionId: payload.sessionId, turn: payload.turn });
      }
      store.set(HELD, held);
    });
  };
  const defer = (parent, artifacts) => {
    ancestors.set(parent, [...(ancestors.get(parent) ?? []), ...artifacts]);
  };
  const onResult = (exec, result) => {
    if (disposed || !exec) return;
    const own = staged.get(exec);
    staged.delete(exec);
    const children = ancestors.get(exec.token) ?? [];
    ancestors.delete(exec.token);
    const artifacts = own ? [own, ...children] : children;
    // Final DSH result includes post-execute, output-validation and cancellation failures.
    if (!artifacts.length || result?.isError !== false) return;
    if (exec.parent !== undefined) defer(exec.parent, artifacts);
    else commit(artifacts);
  };

  const observeSessionEvent = (sessionOrId, event) => {
    if (disposed || event?.type !== 'turn/end') return;
    const sessionId = sessionIdOf(sessionOrId);
    const turn = event.data?.turn;
    if (typeof sessionId !== 'string' || !Number.isSafeInteger(turn) || turn < 0) return;
    const reason = event.data?.reason;
    const completed = (typeof reason === 'string' ? reason : reason?.kind) === 'completed';
    store.transaction(() => {
      const held = store.get(HELD, []);
      for (const artifact of held) {
        if (artifact.sessionId !== sessionId || artifact.turn !== turn) continue;
        if (store.job(artifact.id)?.status === 'held') {
          store.status(artifact.id, completed ? 'pending' : 'failed', completed ? null : 'artifact-turn-not-completed');
        }
      }
      store.set(HELD, held.filter(artifact => artifact.sessionId !== sessionId || artifact.turn !== turn));
    });
    for (const [exec, artifact] of staged) if (artifact.sessionId === sessionId && artifact.turn === turn) staged.delete(exec);
    for (const [token, artifacts] of ancestors) {
      const remaining = artifacts.filter(a => a.sessionId !== sessionId || a.turn !== turn);
      if (remaining.length) ancestors.set(token, remaining);
      else ancestors.delete(token);
    }
  };

  const definition = {
    name: ARTIFACT_TOOL,
    description: 'Prepare an existing file or generated image for Telegram delivery after this turn completes. Pass its local path. The exact bytes are copied, up to 20 MiB. Success means prepared, not sent or received. Cancelled or failed turns do not deliver their files.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      path: { type: 'string', description: 'Absolute file path, or a path relative to the Session working directory.' },
    }, required: ['path'] },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        artifactId: { type: 'string' }, fileName: { type: 'string' }, size: { type: 'integer' },
      }, required: ['artifactId', 'fileName', 'size'] },
      render: (_args, value) => [{ type: 'text',
        text: `Prepared ${value.fileName} (${value.size} bytes) for Telegram delivery after this turn completes. It has not been sent yet.` }],
    },
    async execute(args, exec) {
      if (disposed) throw refusal('artifact-disposed', 'Telegram file delivery is unavailable.');
      const session = exec?.agent?.session;
      const sessionId = sessionIdOf(session);
      if (!session || typeof sessionId !== 'string' || !sessionId || session.header?.origin !== undefined
        || typeof exec.callId !== 'string' || !exec.callId || typeof exec.signal?.throwIfAborted !== 'function'
        || !enabled(session)) {
        throw refusal('artifact-session-unavailable', 'Telegram file delivery requires an enabled ordinary Agent Session.');
      }
      const boundary = ctx.agents.turnBoundaryOf(session);
      if (!Number.isSafeInteger(boundary?.openTurnStartSeq) || boundary.openTurnStartSeq < 0
        || !Number.isSafeInteger(boundary.lastTurn) || boundary.lastTurn < 0) {
        throw refusal('artifact-no-open-turn', 'Telegram file delivery requires an open turn.');
      }
      const turn = boundary.lastTurn;
      const content = await snapshot(ctx, exec, args?.path, maxBytes);
      exec.signal.throwIfAborted();
      const artifactId = randomUUID();
      const artifact = { id: `artifact:${artifactId}`, artifactId, sessionId, session, turn,
        callId: exec.callId, seq: null, kind: 'artifact', type: 'artifact', content: [content] };
      if (disposed || !open(artifact)) throw refusal('artifact-turn-ended', 'The turn ended before the file was prepared.');
      staged.set(exec, artifact);
      return { artifactId, fileName: content.name, size: Buffer.byteLength(content.data, 'base64') };
    },
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    staged.clear();
    ancestors.clear();
    for (const stop of disposers.splice(0).reverse()) stop?.();
    // Durable held jobs survive disposal for history-based recovery, never automatic release.
  };
  try {
    disposers.push(ctx.tools.register(definition));
    disposers.push(ctx.on('tools/result', onResult, { global: true }));
    disposers.push(ctx.on('session/event', observeSessionEvent, { global: true }));
    disposers.push(ctx.on('session/disposed', session => {
      const sessionId = sessionIdOf(session);
      for (const [exec, artifact] of staged) if (artifact.sessionId === sessionId) staged.delete(exec);
      for (const [token, artifacts] of ancestors) {
        const remaining = artifacts.filter(a => a.sessionId !== sessionId);
        if (remaining.length) ancestors.set(token, remaining);
        else ancestors.delete(token);
      }
    }, { global: true }));
  } catch (error) {
    dispose();
    throw error;
  }
  return Object.freeze({ dispose, observeSessionEvent, maxBytes });
}
