import { createServer } from 'node:http';
import { timingSafeEqual, createHash } from 'node:crypto';

const tokenHash = token => createHash('sha256').update(token).digest();
export function validateTransport(url) {
  const parsed = new URL(url);
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('Relay URL must not contain credentials, query or fragment');
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(parsed.hostname))) {
    throw new Error('Remote relay requires HTTPS (HTTP allowed only on loopback)');
  }
  return parsed.href.replace(/\/$/, '');
}
export function createRelayServer({ relay, gateways, adminToken, settings, maxBodyBytes = 128 * 1024 * 1024 }) {
  if (adminToken !== undefined && (typeof adminToken !== 'string' || adminToken.length < 32)) throw new Error('Admin token must be at least 32 characters');
  if (!gateways || (!Object.keys(gateways).length && !(adminToken && settings))) throw new Error('Configure gateway credentials first');
  const tokens = new Set();
  for (const [id, token] of Object.entries(gateways)) {
    if (!/^[a-zA-Z0-9_-]{1,32}$/.test(id) || typeof token !== 'string' || token.length < 32 || tokens.has(token)) {
      throw new Error('Gateway ids must be stable; use distinct tokens of at least 32 characters');
    }
    if (adminToken === token) throw new Error('Admin and gateway tokens must be different');
    tokens.add(token);
  }
  return createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', 'no-store');
    if (req.url === '/v1/admin/settings') {
      const supplied = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
      if (!adminToken || !settings || !timingSafeEqual(tokenHash(supplied), tokenHash(adminToken))) {
        res.writeHead(401); res.end('{"error":"unauthorized"}'); return;
      }
      if (req.method === 'GET') { res.end(JSON.stringify(settings.describe())); return; }
      if (req.method !== 'POST' || req.headers['content-type'] !== 'application/json') {
        res.writeHead(405); res.end('{"error":"method"}'); return;
      }
      try {
        let size = 0;
        const chunks = [];
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 64 * 1024) { res.writeHead(413); res.end('{"error":"too-large"}'); return; }
          chunks.push(chunk);
        }
        const patch = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (Object.values(patch.gateways ?? {}).includes(adminToken)) throw Object.assign(new Error(), { code: 'gateway-credentials' });
        res.end(JSON.stringify(await settings.configure(patch)));
      } catch (error) {
        const allowed = ['invalid-settings', 'gateway-credentials', 'owner-id', 'bot-token', 'exclusive-bot', 'notifications',
          'owner-change-requires-new-relay', 'bot-change-requires-new-relay', 'bot-verification-failed', 'settings-busy'];
        res.writeHead(400); res.end(JSON.stringify({ error: allowed.includes(error.code) ? error.code : 'settings-failed' }));
      }
      return;
    }
    const path = req.url?.match(/^\/v1\/gateways\/([a-zA-Z0-9_-]{1,32})\/(exchange|status)$/);
    const id = path?.[1];
    const expected = id && Object.hasOwn(gateways, id) ? gateways[id] : null;
    const supplied = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
    if (!expected || !timingSafeEqual(tokenHash(supplied), tokenHash(expected))) {
      res.writeHead(401); res.end('{"error":"unauthorized"}'); return;
    }
    if (path?.[2] === 'status') {
      if (req.method !== 'GET') { res.writeHead(405); res.end('{"error":"method"}'); return; }
      res.end(JSON.stringify({ ready: typeof relay.describe === 'function' ? relay.describe().ready : true, gatewayId: id })); return;
    }
    if (req.method !== 'POST' || req.headers['content-type'] !== 'application/json') {
      res.writeHead(405); res.end('{"error":"method"}'); return;
    }
    try {
      let size = 0;
      const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > maxBodyBytes) { res.writeHead(413); res.end('{"error":"too-large"}'); return; }
        chunks.push(chunk);
      }
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const response = relay.exchange(id, payload);
      res.end(JSON.stringify(response));
    } catch {
      res.writeHead(400); res.end('{"error":"invalid-exchange"}');
    }
  });
}

export class RelayAdminClient {
  constructor({ url, token, fetchImpl = fetch }) {
    this.url = `${validateTransport(url)}/v1/admin/settings`;
    if (typeof token !== 'string' || token.length < 32) throw new Error('Invalid admin credential');
    this.token = token;
    this.fetch = fetchImpl;
  }
  async request(patch, signal) {
    let response, result;
    try {
      response = await this.fetch(this.url, { method: patch === undefined ? 'GET' : 'POST', redirect: 'error',
        headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
        body: patch === undefined ? undefined : JSON.stringify(patch),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000),
      });
      result = await response.json();
    } catch { throw new Error('relay-admin-unavailable'); }
    if (!response.ok) {
      const allowed = ['owner-change-requires-new-relay', 'bot-change-requires-new-relay', 'bot-verification-failed',
        'gateway-credentials', 'settings-busy', 'owner-id'];
      throw new Error(response.status === 401 ? 'relay-admin-unauthorized' : allowed.includes(result.error) ? result.error : 'relay-settings-rejected');
    }
    return result;
  }
  describe(signal) { return this.request(undefined, signal); }
  configure(patch, signal) { return this.request(patch, signal); }
}

export class RelayClient {
  constructor({ url, gatewayId, token, fetchImpl = fetch }) {
    this.url = `${validateTransport(url)}/v1/gateways/${encodeURIComponent(gatewayId)}/exchange`;
    this.token = token;
    this.fetch = fetchImpl;
    if (!/^[a-zA-Z0-9_-]{1,32}$/.test(gatewayId) || typeof token !== 'string' || token.length < 32) throw new Error('Invalid gateway credentials');
  }
  async check(signal) {
    try {
      const res = await this.fetch(this.url.replace(/\/exchange$/, '/status'), { redirect: 'error',
        headers: { authorization: `Bearer ${this.token}` },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error();
      return await res.json();
    } catch { throw new Error('gateway-check-failed'); }
  }
  async exchange(payload, signal) {
    let res;
    try {
      res = await this.fetch(this.url, { method: 'POST', redirect: 'error',
        headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error();
      return await res.json();
    } catch { throw new Error('Relay exchange failed'); }
  }
}
