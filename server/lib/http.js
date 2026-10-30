// A small router over node:http, and the pieces every route shares: CORS
// like Supabase's (any origin, since the key and the row policies are what
// decide), body reading with a cap, and one error shape per service.
import { log } from './log.js';

export class HttpError extends Error {
  constructor(status, body, headers) {
    super(typeof body === 'string' ? body : (body && (body.message || body.msg || body.error)) || 'error');
    this.status = status;
    this.body = body;
    this.headers = headers || {};
  }
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, prefer, range, accept, accept-profile, content-profile, x-upsert, x-client-info, x-tenant-id, cache-control, tus-resumable, upload-length, upload-offset, upload-metadata, x-http-method-override, x-pental-setup, x-supabase-api-version, x-region, x-user-agent, if-match, if-none-match, if-modified-since, x-requested-with',
  'Access-Control-Expose-Headers': 'content-range, content-length, content-type, location, upload-offset, upload-length, tus-resumable, tus-version, tus-max-size, tus-extension, etag, last-modified, x-error, x-pental-schema',
  'Access-Control-Max-Age': '86400',
};

export function applyCors(res) {
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.setHeader(k, v);
}

// A body over the limit is answered 413 rather than cut off: the rest is
// drained unread (a caller then sees why, not a reset connection), and the
// connection is closed once the answer has gone.
export function readBody(req, { limit = 10 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const declared = parseInt(req.headers['content-length'], 10);
    const tooBig = () => new HttpError(413, { code: 'PGRST413', message: 'Payload too large', details: `The limit is ${Math.round(limit / 1048576)} MB`, hint: null }, { Connection: 'close' });
    if (Number.isFinite(declared) && declared > limit) { req.resume(); reject(tooBig()); return; }
    const chunks = [];
    let size = 0;
    let over = false;
    req.on('data', (c) => {
      if (over) return;
      size += c.length;
      if (size > limit) { over = true; chunks.length = 0; reject(tooBig()); return; }
      chunks.push(c);
    });
    req.on('end', () => { if (!over) resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}

export async function readJson(req, opts) {
  const buf = await readBody(req, opts);
  if (!buf.length) return null;
  try { return JSON.parse(buf.toString('utf8')); }
  catch { throw new HttpError(400, { code: 'PGRST102', message: 'Empty or invalid json', details: null, hint: null }); }
}

export function sendJson(res, status, body, headers) {
  const text = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...(headers || {}) });
  res.end(text);
}

export function sendText(res, status, text, headers) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...(headers || {}) });
  res.end(text);
}

// The bearer token and the api key, as supabase-js sends them: the key in
// `apikey` (or the query string for a websocket), the session in
// `Authorization: Bearer`. A request with the key alone runs as the key.
export function credentialsOf(req, url) {
  const h = req.headers;
  const bearer = /^Bearer\s+(.+)$/i.exec(String(h.authorization || '').trim());
  const apikey = String(h.apikey || url.searchParams.get('apikey') || '').trim();
  return { bearer: bearer ? bearer[1].trim() : '', apikey };
}

export function parsePrefer(req) {
  const out = {};
  for (const part of String(req.headers.prefer || '').split(',')) {
    const [k, v] = part.trim().split('=');
    if (k) out[k.trim()] = v === undefined ? true : v.trim();
  }
  return out;
}

// 1.10.0: a part with a % that does not begin an escape ("50%.pdf", or
// `/rest/v1/%E0%A4%A`) is taken as written. decodeURIComponent threw on it
// outside any handler, and an unhandled rejection stops Node: one request
// could take the gateway down.
export function decodePart(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

// Match "/rest/v1/:table" style patterns. Returns params or null.
export function matchPath(pattern, pathname) {
  const p = pattern.split('/');
  const q = pathname.split('/');
  const params = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith('*')) { params[p[i].slice(1)] = q.slice(i).map(decodePart).join('/'); return params; }
    if (i >= q.length) return null;
    if (p[i].startsWith(':')) { params[p[i].slice(1)] = decodePart(q[i]); continue; }
    if (p[i] !== q[i]) return null;
  }
  return q.length === p.length ? params : null;
}

export class Router {
  constructor() { this.routes = []; }
  add(method, pattern, handler) { this.routes.push({ method, pattern, handler }); return this; }
  // Returns { handler, params } for the first match, or null.
  find(method, pathname) {
    for (const r of this.routes) {
      if (r.method !== '*' && r.method !== method) continue;
      const params = matchPath(r.pattern, pathname);
      if (params) return { handler: r.handler, params };
    }
    return null;
  }
}

// The address this gateway is being reached at: PUBLIC_URL when set, else
// what the request says (the cloud's proxy forwards the host and scheme).
export function originOf(req, cfg) {
  if (cfg && cfg.publicUrl) return cfg.publicUrl;
  const h = req.headers;
  const host = String((cfg && cfg.trustProxy && h['x-forwarded-host']) || h.host || '').split(',')[0].trim();
  const proto = String((cfg && cfg.trustProxy && h['x-forwarded-proto']) || '').split(',')[0].trim() || (req.socket && req.socket.encrypted ? 'https' : 'http');
  return host ? `${proto}://${host}` : '';
}

// The address the request came from. Behind the cloud's proxy it is the entry
// that proxy appended to X-Forwarded-For (the right-hand end, `hops` from the
// end); anything to the left of it was written by the caller and proves
// nothing, so it is never used.
export function clientIp(req, hops) {
  const n = hops === true ? 1 : (Number(hops) || 0);
  if (n > 0) {
    const list = String(req.headers['x-forwarded-for'] || '').split(',').map((x) => x.trim()).filter(Boolean);
    if (list.length) return list[Math.max(0, list.length - n)];
  }
  return req.socket.remoteAddress || '';
}

export function handleError(res, e, shape = 'rest') {
  if (e instanceof HttpError) {
    const body = typeof e.body === 'string' ? { message: e.body } : e.body;
    sendJson(res, e.status, body, e.headers);
    return;
  }
  // The database refusing a write because it is paused for a move, or has
  // moved: its own words, which say what to do, reach the person.
  if (e && e.code === '55006' && typeof e.message === 'string') {
    if (shape === 'storage') sendJson(res, 400, { statusCode: '423', error: 'Locked', message: e.message });
    else if (shape === 'auth') sendJson(res, 423, { code: 423, error_code: 'database_moving', msg: e.message, error: 'database_moving', error_description: e.message });
    else sendJson(res, 500, { code: '55006', message: e.message, details: null, hint: e.hint || null });
    return;
  }
  log.error('unhandled', { error: e && e.message, stack: e && e.stack && e.stack.split('\n').slice(0, 4).join(' | ') });
  if (shape === 'auth') sendJson(res, 500, { code: 500, error_code: 'unexpected_failure', msg: 'Something went wrong', error: 'unexpected_failure', error_description: 'Something went wrong' });
  else if (shape === 'storage') sendJson(res, 500, { statusCode: '500', error: 'InternalError', message: 'Something went wrong' });
  else sendJson(res, 500, { code: 'PGRST000', message: 'Something went wrong', details: null, hint: null });
}

// An answer, read up to `max` bytes and no further: an address that streams
// without end is cut off, not held in memory. 1.10.0: one copy for every
// worker (the ticket, Xero and call workers each had their own, and the AI
// worker read the whole answer first and cut it after).
export async function readCapped(res, max) {
  // An answer with no stream to read (a stand-in) is read whole and cut.
  if (!res.body || typeof res.body.getReader !== 'function') return typeof res.text === 'function' ? String(await res.text()).slice(0, max) : '';
  const reader = res.body.getReader();
  const parts = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.byteLength >= max) { parts.push(value.subarray(0, max - size)); size = max; break; }
      parts.push(value);
      size += value.byteLength;
    }
  } finally {
    reader.cancel().catch(() => { /* finished, or already ended */ });
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const p of parts) { all.set(p, at); at += p.byteLength; }
  return new TextDecoder('utf-8').decode(all);
}