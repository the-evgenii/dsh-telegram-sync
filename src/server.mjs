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
export function createRelayServer({ relay, gateways, maxBodyBytes = 128 * 1024 * 1024 }) {
  if (!gateways || !Object.keys(gateways).length) throw new Error('Configure gateway credentials first');
  const tokens = new Set();
  for (const [id, token] of Object.entries(gateways)) {
    if (!/^[a-zA-Z0-9_-]{1,32}$/.test(id) || typeof token !== 'string' || token.length < 32 || tokens.has(token)) {
      throw new Error('Gateway ids must be stable; use distinct tokens of at least 32 characters');
    }
    tokens.add(token);
  }
  return createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', 'no-store');
    const path = req.url?.match(/^\/v1\/gateways\/([a-zA-Z0-9_-]{1,32})\/exchange$/);
    const id = path?.[1];
    const expected = id && Object.hasOwn(gateways, id) ? gateways[id] : null;
    const supplied = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
    if (!expected || !timingSafeEqual(tokenHash(supplied), tokenHash(expected))) {
      res.writeHead(401); res.end('{"error":"unauthorized"}'); return;
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

export class RelayClient {
  constructor({ url, gatewayId, token, fetchImpl = fetch }) {
    this.url = `${validateTransport(url)}/v1/gateways/${encodeURIComponent(gatewayId)}/exchange`;
    this.token = token;
    this.fetch = fetchImpl;
    if (!/^[a-zA-Z0-9_-]{1,32}$/.test(gatewayId) || typeof token !== 'string' || token.length < 32) throw new Error('Invalid gateway credentials');
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
