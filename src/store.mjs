import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

/** One owning process per database; transactional queue + state, no JSON write races. */
export class Store {
  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
        lane TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
        not_before INTEGER NOT NULL DEFAULT 0, error TEXT
      );
      CREATE INDEX IF NOT EXISTS jobs_pending ON jobs(lane,status,seq);`);
  }
  get(key, fallback = null) {
    const row = this.db.prepare('SELECT value FROM state WHERE key=?').get(key);
    return row ? JSON.parse(row.value) : fallback;
  }
  set(key, value) {
    this.db.prepare('INSERT INTO state VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(key, JSON.stringify(value));
  }
  entries(prefix) {
    return this.db.prepare('SELECT key,value FROM state WHERE substr(key,1,?)=? ORDER BY key')
      .all(prefix.length, prefix).map(r => [r.key, JSON.parse(r.value)]);
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  enqueue(id, lane, payload) {
    return this.db.prepare('INSERT OR IGNORE INTO jobs(id,lane,payload) VALUES (?,?,?)')
      .run(id, lane, JSON.stringify(payload)).changes > 0;
  }
  job(id) {
    const r = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
    return r ? { ...r, payload: JSON.parse(r.payload) } : null;
  }
  pending(lane, now = Date.now(), limit = 100) {
    return this.db.prepare("SELECT * FROM jobs WHERE lane=? AND status='pending' AND not_before<=? ORDER BY seq LIMIT ?")
      .all(lane, now, limit).map(r => ({ ...r, payload: JSON.parse(r.payload) }));
  }
  hasPendingSession(lane, sessionId, exceptIds = []) {
    return Boolean(this.db.prepare(`SELECT 1 FROM jobs WHERE lane=? AND status='pending'
      AND json_extract(payload,'$.sessionId')=?
      AND id NOT IN (SELECT value FROM json_each(?)) LIMIT 1`)
      .get(lane, sessionId, JSON.stringify(exceptIds)));
  }
  nextTelegram(now) {
    const row = this.db.prepare(`SELECT candidate.* FROM jobs AS candidate
      WHERE candidate.lane='telegram' AND candidate.status='pending' AND candidate.not_before<=?
      AND NOT EXISTS (SELECT 1 FROM jobs AS blocker WHERE blocker.lane='telegram'
        AND blocker.seq<candidate.seq AND blocker.status!='done'
        AND (json_extract(blocker.payload,'$.op')='lifecycle'
          OR (json_extract(candidate.payload,'$.op')='interaction' AND json_extract(blocker.payload,'$.op')='message'))
        AND json_extract(blocker.payload,'$.key')=json_extract(candidate.payload,'$.key'))
      ORDER BY candidate.seq LIMIT 1`).get(now);
    return row ? { ...row, payload: JSON.parse(row.payload) } : null;
  }
  status(id, status, error = null, notBefore = 0) {
    this.db.prepare('UPDATE jobs SET status=?,error=?,not_before=? WHERE id=?')
      .run(status, error, notBefore, id);
  }
  /** A Telegram send without its saved receipt must never be blindly replayed. */
  recover(lane) {
    this.db.prepare("UPDATE jobs SET status='uncertain',error='process-interrupted' WHERE lane=? AND status='sending'").run(lane);
  }
  close() { this.db.close(); }
}

export function boundedBatch(items, maxBytes = 32 * 1024 * 1024) {
  let bytes = 0;
  const result = [];
  for (const item of items) {
    bytes += Buffer.byteLength(JSON.stringify(item));
    if (bytes > maxBytes) break;
    result.push(item);
  }
  return result;
}

export function sessionKey(gatewayId, sessionId) {
  return JSON.stringify([gatewayId, sessionId]);
}
