import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, stat, lstat, realpath, symlink, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, isAbsolute } from 'node:path';
import { installArtifacts, ARTIFACT_TOOL, MAX_ARTIFACT_BYTES } from '../src/artifacts.mjs';
import { Store } from '../src/store.mjs';

function metadata(info) {
  return { type: info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'symlink',
    size: Number(info.size), version: `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}` };
}

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'telegram-artifact-test-'));
  const storePath = join(root, 'queue.sqlite');
  const store = new Store(storePath);
  const listeners = new Map();
  const definitions = new Map();
  const boundaries = new Map();
  const calls = [];
  const session = { id: 'session-one', header: { cwd: root } };
  const agent = { session };
  boundaries.set(session, { lastTurn: 7, openTurnStartSeq: 40 });
  const ctx = {
    tools: { register(definition) {
      definitions.set(definition.name, definition);
      return () => definitions.delete(definition.name);
    } },
    agents: { turnBoundaryOf(s) { return boundaries.get(s); } },
    workingDirectory: { async ensure(a, signal) { signal.throwIfAborted(); return a.session.header.cwd; } },
    on(name, listener) {
      const set = listeners.get(name) ?? new Set();
      listeners.set(name, set); set.add(listener);
      return () => set.delete(listener);
    },
    fs: {
      async resolve(path, opts) {
        calls.push(['resolve', path, opts]); opts.signal.throwIfAborted();
        const displayPath = resolve(opts.cwd, path);
        return { displayPath, targetKey: await realpath(displayPath) };
      },
      async stat(target, signal) { signal.throwIfAborted(); return metadata(await stat(target.targetKey, { bigint: true })); },
      async lstat(path, opts, signal) {
        signal.throwIfAborted();
        try { return metadata(await lstat(resolve(opts.cwd, path), { bigint: true })); }
        catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
      },
      async readBytes(target, signal, maxBytes) {
        calls.push(['readBytes', target, signal, maxBytes]); signal.throwIfAborted();
        const data = await readFile(target.targetKey, { signal });
        if (data.length > maxBytes) throw Object.assign(new Error('too large'), { code: 'FS_TOO_LARGE' });
        return data;
      },
    },
  };
  let installation = installArtifacts(ctx, { store, ...options });
  let closed = false;
  t.after(async () => {
    installation.dispose(); if (!closed) store.close();
    assert.ok(isAbsolute(root) && root.startsWith(join(tmpdir(), 'telegram-artifact-test-')));
    await rm(root, { recursive: true, force: true });
  });
  const emit = (name, ...args) => {
    for (const listener of listeners.get(name) ?? []) listener(...args);
  };
  const execution = (extra = {}) => ({ name: ARTIFACT_TOOL, agent, signal: new AbortController().signal,
    callId: 'call-1', token: Symbol('native'), ...extra });
  const end = (reason = 'completed', s = session, turn = 7) => {
    boundaries.get(s).openTurnStartSeq = null;
    emit('session/event', s, { type: 'turn/end', seq: 80, data: { turn, reason } });
  };
  return { root, store, storePath, ctx, calls, session, agent, boundaries, execution, emit, end,
    tool: () => definitions.get(ARTIFACT_TOOL), installation: () => installation,
    reinstall() { installation.dispose(); installation = installArtifacts(ctx, { store, ...options }); return installation; },
    closeStore() { closed = true; store.close(); },
  };
}

test('snapshots real file bytes; only successful tool result + completed turn releases outgoing', async t => {
  const f = await fixture(t);
  const path = join(f.root, 'answer.txt');
  await writeFile(path, 'original bytes');
  const exec = f.execution();
  const value = await f.tool().execute({ path: 'answer.txt' }, exec);
  const id = `artifact:${value.artifactId}`;
  assert.equal(f.store.job(id), null, 'execute must not persist outgoing');
  f.emit('tools/result', exec, { isError: false, value });
  assert.equal(f.store.job(id).status, 'held');
  assert.equal(f.store.pending('outgoing').length, 0);
  await writeFile(path, 'later version, not the registered file');
  f.end({ kind: 'completed' });
  const [job] = f.store.pending('outgoing');
  assert.equal(job.payload.type, 'artifact'); assert.equal(job.payload.kind, 'artifact');
  assert.equal(job.payload.seq, null); assert.equal(job.payload.callId, 'call-1');
  assert.equal(job.payload.sessionId, 'session-one'); assert.equal(job.payload.turn, 7);
  assert.equal(Buffer.from(job.payload.content[0].data, 'base64').toString(), 'original bytes');
  assert.equal(job.payload.content[0].name, 'answer.txt');
  assert.equal(job.payload.content[0].type, 'file');
  assert.equal(value.size, 14);
  assert.ok(!JSON.stringify(job.payload).includes(f.root), 'no host path in durable transport');
  assert.equal(f.calls.find(c => c[0] === 'readBytes')[3], MAX_ARTIFACT_BYTES);
  assert.equal(f.calls.find(c => c[0] === 'resolve')[2].cwd, f.root);
  f.emit('tools/result', exec, { isError: false }); f.end();
  assert.equal(f.store.pending('outgoing').length, 1, 'duplicate notifications do not resend');
});

test('stores real image bytes unchanged as a document without guessing media type', async t => {
  const f = await fixture(t);
  const bytes = Buffer.from('89504e470d0a1a0a000102ff', 'hex');
  await writeFile(join(f.root, 'image.png'), bytes);
  const exec = f.execution();
  const value = await f.tool().execute({ path: 'image.png' }, exec);
  f.emit('tools/result', exec, { isError: false }); f.end();
  const block = f.store.job(`artifact:${value.artifactId}`).payload.content[0];
  assert.deepEqual(Buffer.from(block.data, 'base64'), bytes);
  assert.equal(block.mediaType, undefined);
});

test('post-execute rejection or cancellation never persists or delivers the staged file', async t => {
  for (const cause of ['post-execute rejection', 'cancelled']) {
    const f = await fixture(t);
    await writeFile(join(f.root, 'file'), cause);
    const exec = f.execution();
    const value = await f.tool().execute({ path: 'file' }, exec);
    f.emit('tools/result', exec, { isError: true }); f.end();
    assert.equal(f.store.job(`artifact:${value.artifactId}`), null);
  }
});

test('Code Mode waits for every successful ancestor, and errors discard all descendants', async t => {
  for (const failed of [false, true]) {
    const f = await fixture(t);
    await writeFile(join(f.root, 'file'), 'nested');
    const outer = f.execution({ name: 'run_code', token: Symbol('outer'), callId: 'outer' });
    const parent = f.execution({ name: 'nested_code', token: Symbol('parent'), parent: outer.token, callId: 'parent' });
    const child = f.execution({ parent: parent.token, callId: 'child' });
    const value = await f.tool().execute({ path: 'file' }, child);
    const id = `artifact:${value.artifactId}`;
    f.emit('tools/result', child, { isError: false }); assert.equal(f.store.job(id), null);
    f.emit('tools/result', parent, { isError: false }); assert.equal(f.store.job(id), null);
    f.emit('tools/result', outer, { isError: failed });
    assert.equal(f.store.job(id)?.status, failed ? undefined : 'held');
    f.end(); assert.equal(f.store.pending('outgoing').length, failed ? 0 : 1);
  }
});

test('failed child cannot be rescued by successful parent', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'file'), 'child');
  const parent = f.execution({ name: 'run_code' });
  const child = f.execution({ parent: parent.token });
  const value = await f.tool().execute({ path: 'file' }, child);
  f.emit('tools/result', child, { isError: true });
  f.emit('tools/result', parent, { isError: false }); f.end();
  assert.equal(f.store.job(`artifact:${value.artifactId}`), null);
});

test('cancelled, failed and blocked turns fail closed even after successful tool result', async t => {
  for (const reason of ['cancelled', { kind: 'error' }, { kind: 'blocked' }]) {
    const f = await fixture(t);
    await writeFile(join(f.root, 'file'), 'ready');
    const exec = f.execution();
    const value = await f.tool().execute({ path: 'file' }, exec);
    f.emit('tools/result', exec, { isError: false });
    f.end(reason);
    assert.equal(f.store.pending('outgoing').length, 0);
    assert.equal(f.store.job(`artifact:${value.artifactId}`).status, 'failed');
    assert.equal(f.store.job(`artifact:${value.artifactId}`).error, 'artifact-turn-not-completed');
    f.end('completed'); assert.equal(f.store.pending('outgoing').length, 0);
  }
});

test('recover durable held snapshot after restart through idempotent history observer', async t => {
  const f = await fixture(t);
  const file = join(f.root, 'file');
  await writeFile(file, 'survives restart');
  const exec = f.execution();
  const value = await f.tool().execute({ path: file }, exec);
  f.emit('tools/result', exec, { isError: false });
  f.installation().dispose(); f.closeStore();
  await rm(file); // Delivery/recovery may no longer read the original source.
  const reopened = new Store(f.storePath);
  const recovered = installArtifacts(f.ctx, { store: reopened });
  try {
    assert.equal(reopened.pending('outgoing').length, 0);
    const end = { type: 'turn/end', seq: 81, data: { turn: 7, reason: { kind: 'completed' } } };
    recovered.observeSessionEvent({ sessionId: f.session.id }, end);
    assert.equal(reopened.pending('outgoing').length, 1);
    const id = `artifact:${value.artifactId}`;
    assert.equal(Buffer.from(reopened.job(id).payload.content[0].data, 'base64').toString(), 'survives restart');
    reopened.status(id, 'done'); recovered.observeSessionEvent(f.session.id, end);
    assert.equal(reopened.job(id).status, 'done');
  } finally { recovered.dispose(); reopened.close(); }
});

test('invalid paths, missing files, directories and final symlinks are rejected without outgoing', async t => {
  const f = await fixture(t);
  const file = join(f.root, 'file'); await writeFile(file, 'regular');
  await symlink(file, join(f.root, 'link'));
  for (const path of ['', '  ', '\0', 'https://example.org/file', 'absent', '.', 'link']) {
    await assert.rejects(f.tool().execute({ path }, f.execution()));
  }
  assert.equal(f.store.pending('outgoing').length, 0);
  assert.equal(f.calls.filter(c => c[0] === 'readBytes').length, 0);
});

test('20 MiB inclusive maximum, zero-byte file, and bounded rejection of larger files', async t => {
  const f = await fixture(t);
  const file = join(f.root, 'large');
  await writeFile(file, Buffer.alloc(MAX_ARTIFACT_BYTES + 1));
  await assert.rejects(f.tool().execute({ path: file }, f.execution()), { code: 'artifact-too-large' });
  assert.equal(f.calls.filter(c => c[0] === 'readBytes').length, 0);
  await writeFile(file, Buffer.alloc(MAX_ARTIFACT_BYTES));
  const exact = f.execution();
  const value = await f.tool().execute({ path: file }, exact);
  assert.equal(value.size, MAX_ARTIFACT_BYTES);
  f.emit('tools/result', exact, { isError: true }); // Do not retain the test's large payload.
  await writeFile(file, '');
  assert.equal((await f.tool().execute({ path: file }, f.execution())).size, 0);
});

test('filesystem read denial and cancellation are propagated, never retried through host fs', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'file'), 'data');
  const original = f.ctx.fs.readBytes;
  const denied = Object.assign(new Error('denied'), { code: 'FS_SANDBOX_DENIED' });
  let reads = 0;
  f.ctx.fs.readBytes = async () => { reads++; throw denied; };
  await assert.rejects(f.tool().execute({ path: 'file' }, f.execution()), e => e === denied);
  assert.equal(reads, 1);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.tool().execute({ path: 'file' }, f.execution({ signal: controller.signal })), { name: 'AbortError' });
  const during = new AbortController();
  f.ctx.fs.readBytes = async (...args) => { const bytes = await original(...args); during.abort(); return bytes; };
  await assert.rejects(f.tool().execute({ path: 'file' }, f.execution({ signal: during.signal })), { name: 'AbortError' });
  assert.equal(f.store.pending('outgoing').length, 0);
});

test('detects same-length content edits, source growth, path swaps and provider partial reads', async t => {
  for (const change of ['same-size', 'growth', 'path', 'partial']) {
    const f = await fixture(t);
    const file = join(f.root, 'file'); await writeFile(file, 'before');
    const original = f.ctx.fs.readBytes;
    f.ctx.fs.readBytes = async (...args) => {
      const bytes = await original(...args);
      if (change === 'same-size') await writeFile(file, 'after!');
      if (change === 'growth') await writeFile(file, 'larger than before');
      if (change === 'path') { await rm(file); await symlink(join(f.root, 'other'), file); }
      return change === 'partial' ? bytes.subarray(0, 2) : bytes;
    };
    await writeFile(join(f.root, 'other'), 'before');
    await assert.rejects(f.tool().execute({ path: 'file' }, f.execution()), { code: 'artifact-changed' });
    assert.equal(f.store.pending('outgoing').length, 0);
  }
});

test('relative paths use execution working directory, not host process cwd', async t => {
  const f = await fixture(t);
  const cwd = join(f.root, 'current'); await mkdir(cwd);
  await writeFile(join(cwd, 'result'), 'current working directory');
  f.ctx.workingDirectory.ensure = async () => cwd;
  const exec = f.execution();
  const value = await f.tool().execute({ path: 'result' }, exec);
  f.emit('tools/result', exec, { isError: false }); f.end();
  assert.equal(value.size, 25);
  assert.equal(f.calls[0][2].cwd, cwd);
});

test('session and turn identity isolate artifacts; end/disposal before final result cannot commit', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'file'), 'data');
  const exec = f.execution();
  const value = await f.tool().execute({ path: 'file' }, exec);
  f.installation().observeSessionEvent('other-session', { type: 'turn/end', data: { turn: 7, reason: 'completed' } });
  f.emit('tools/result', exec, { isError: false });
  assert.equal(f.store.job(`artifact:${value.artifactId}`).status, 'held');
  f.installation().observeSessionEvent('session-one', { type: 'turn/end', data: { turn: 6, reason: 'completed' } });
  assert.equal(f.store.job(`artifact:${value.artifactId}`).status, 'held');
  f.end(); assert.equal(f.store.pending('outgoing').length, 1);
  f.boundaries.set(f.session, { lastTurn: 8, openTurnStartSeq: 82 });
  const late = f.execution(); const lateValue = await f.tool().execute({ path: 'file' }, late);
  f.end('completed', f.session, 8); f.emit('tools/result', late, { isError: false });
  assert.equal(f.store.job(`artifact:${lateValue.artifactId}`), null);
  f.boundaries.set(f.session, { lastTurn: 9, openTurnStartSeq: 90 });
  const disposed = f.execution(); const disposedValue = await f.tool().execute({ path: 'file' }, disposed);
  f.emit('session/disposed', f.session); f.emit('tools/result', disposed, { isError: false });
  assert.equal(f.store.job(`artifact:${disposedValue.artifactId}`), null);
});

test('Store publication is transactional and a write failure cannot expose a pending file', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'file'), 'data');
  const exec = f.execution();
  const value = await f.tool().execute({ path: 'file' }, exec);
  const original = f.store.set;
  f.store.set = () => { throw new Error('simulated durable Store write failure'); };
  assert.throws(() => f.emit('tools/result', exec, { isError: false }), /Store write failure/);
  f.store.set = original;
  assert.equal(f.store.job(`artifact:${value.artifactId}`), null);
  assert.equal(f.store.pending('outgoing').length, 0);
});

test('unavailable sessions, ended turns and missing capabilities fail closed', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'file'), 'data');
  await assert.rejects(f.tool().execute({ path: 'file' }, f.execution({ agent: undefined })), { code: 'artifact-session-unavailable' });
  f.session.header.origin = 'subagent';
  await assert.rejects(f.tool().execute({ path: 'file' }, f.execution()), { code: 'artifact-session-unavailable' });
  delete f.session.header.origin;
  f.boundaries.get(f.session).openTurnStartSeq = null;
  await assert.rejects(f.tool().execute({ path: 'file' }, f.execution()), { code: 'artifact-no-open-turn' });
  f.boundaries.set(f.session, undefined);
  await assert.rejects(f.tool().execute({ path: 'file' }, f.execution()), { code: 'artifact-no-open-turn' });
  assert.throws(() => installArtifacts(f.ctx, { store: f.store, maxBytes: MAX_ARTIFACT_BYTES + 1 }), RangeError);
  assert.throws(() => installArtifacts({ ...f.ctx, fs: {} }, { store: f.store }), TypeError);
  f.installation().dispose();
  assert.equal(f.tool(), undefined, 'tool unregisters with installation');
});
