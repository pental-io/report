// ONE POOL, AND EVERY REQUEST INSIDE ITS OWN TRANSACTION.
//
// The gateway connects as the role that owns the schema (the one in
// DATABASE_URL). A request from the portal runs as `anon` or `authenticated`
// instead: SET LOCAL ROLE inside the transaction, with the token's claims in
// the same settings PostgREST uses (request.jwt.claims and friends), so every
// row policy and every auth.uid() in the schema reads exactly as it does on
// Supabase. COMMIT or ROLLBACK ends the role change with the transaction.
//
// The gateway's own work (sign-in, holds on storage rows it has already
// checked, bootstrap) runs as the owner, which the policies do not bind.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { log } from './log.js';
import { HttpError } from './http.js';

const { Pool, types } = pg;
// Timestamps, dates and numerics come back as text: the REST layer hands them
// to JSON as PostgREST does (ISO strings and numbers by the column's own
// json cast), never as JavaScript Dates.
for (const oid of [1082, 1114, 1184, 1186, 1700, 20]) types.setTypeParser(oid, (v) => v);

// A connection string may name no host at all when it reaches the database
// through a Unix socket (`postgres://user:pw@/db?host=/cloudsql/...`, Cloud
// Run's Cloud SQL connection); the URL parser needs one, so a placeholder
// stands in and the socket in `host=` is what is used.
export function parseDatabaseUrl(databaseUrl) {
  const raw = String(databaseUrl || '');
  try { return new URL(raw); } catch (e) {
    const fixed = raw.replace(/^(postgres(?:ql)?:\/\/[^/@]*@)\//i, '$1localhost/');
    if (fixed !== raw) return new URL(fixed);
    throw new Error('DATABASE_URL is not a valid postgres:// address');
  }
}

export function poolOptions(databaseUrl, env = process.env) {
  const u = parseDatabaseUrl(databaseUrl);
  const host = u.hostname;
  const local = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.startsWith('/') || u.searchParams.get('host')?.startsWith('/');
  const mode = String(env.DATABASE_SSL || u.searchParams.get('sslmode') || (local ? 'disable' : 'verify')).toLowerCase();
  const opts = { connectionString: databaseUrl, max: parseInt(env.DB_POOL_MAX, 10) || 12, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000 };
  // A Unix socket (Cloud Run's Cloud SQL connector) is `?host=/cloudsql/...`.
  const sock = u.searchParams.get('host');
  if (sock && sock.startsWith('/')) { opts.host = sock; }
  if (mode === 'disable' || mode === 'off' || mode === 'false') {
    opts.ssl = false;
  } else if (mode === 'require' || mode === 'prefer' || mode === 'allow') {
    // Encrypted, the server not verified. Only for a database whose
    // certificate cannot be checked; the templates never choose this.
    opts.ssl = { rejectUnauthorized: false };
  } else {
    // verify, verify-full, verify-ca: the certificate has to check out
    // against the system store, or against DATABASE_SSL_CA when given (the
    // RDS bundle, a Cloud SQL server certificate).
    const ssl = { rejectUnauthorized: true };
    const caFile = env.DATABASE_SSL_CA || '';
    if (caFile) {
      try { ssl.ca = fs.readFileSync(caFile, 'utf8'); } catch (e) { throw new Error(`DATABASE_SSL_CA could not be read (${caFile}): ${e.message}`); }
    }
    opts.ssl = ssl;
  }
  // Keep the connection string's own sslmode from fighting the choice above.
  u.searchParams.delete('sslmode');
  opts.connectionString = u.toString();
  return opts;
}

// A connection that carries the vault key from its first moment: the
// schema's own functions open sealed secrets with it, whatever role a
// request runs as. Set before the pool hands the connection to anybody.
function clientClass(vaultKey) {
  return class GatewayClient extends pg.Client {
    connect(callback) {
      const prime = () => this.query('SELECT set_config($1, $2, false)', ['app.settings.vault_key', vaultKey]);
      if (typeof callback === 'function') {
        super.connect((err) => { if (err) return callback(err); prime().then(() => callback(null), callback); });
        return undefined;
      }
      return super.connect().then(() => prime()).then(() => undefined);
    }
  };
}

// DATABASE_SSL_CA=rds: Amazon's RDS certificate bundle, fetched once at start
// (the image carries no copy, so a rotated bundle is never stale). Any other
// value is a file path. Returns the environment to read the pool from.
export async function prepareSslCa(env = process.env) {
  const v = String(env.DATABASE_SSL_CA || '').trim();
  if (v.toLowerCase() !== 'rds') return env;
  // The image carries the bundle from its build (Dockerfile), so a gateway
  // with no route to the internet still verifies RDS; fetched only if absent.
  const baked = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'certs', 'rds-global-bundle.pem');
  try { if (/BEGIN CERTIFICATE/.test(fs.readFileSync(baked, 'utf8'))) { log.info('RDS certificate bundle from the image', { file: baked }); return { ...env, DATABASE_SSL_CA: baked }; } } catch { /* not in this image */ }
  const url = 'https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pental-ca-'));
  const file = path.join(dir, 'rds-global-bundle.pem');
  const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error('could not fetch the RDS certificate bundle: HTTP ' + r.status);
  const pem = await r.text();
  if (!/BEGIN CERTIFICATE/.test(pem)) throw new Error('the RDS certificate bundle did not look like PEM');
  fs.writeFileSync(file, pem);
  log.info('RDS certificate bundle fetched', { file });
  return { ...env, DATABASE_SSL_CA: file };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALIVE_MS = 30000;          // a live session is asked about again after this
const ENDED_MS = 5 * 60 * 1000;  // an ended one is remembered this long

// 1.10.0: ONE CONNECTION LISTENS FOR EVERYTHING.
//
// The schema, live updates and the AI, ticket, mail, Xero and call workers
// each took a connection from the pool for their LISTEN and kept it: seven of
// the twelve, for good, so a busy portal queued for the five left. A listener
// that lost its connection was not given back as broken, and live updates
// listened again on every loss without letting go of the last one. Now one
// connection of its own, outside the pool, listens on every channel; when it
// is lost it is made again after a pause that grows to thirty seconds, listens
// on every channel again, and tells each part (its `resume`), so a worker
// looks for what it may have missed. A heartbeat finds one that has gone
// quiet without saying so (a proxy dropping an idle connection).
const CHANNEL_RE = /^[a-z_][a-z0-9_]*$/;
export class Listener {
  constructor(makeClient) {
    this.makeClient = makeClient;
    this.channels = new Map();   // channel -> Set of (notification) => void
    this.resumers = new Set();
    this.client = null;
    this.pending = null;
    this.stopped = false;
    this.delay = 1000;
    this.retry = null;
    this.beat = null;
    this.lostOnce = false;
  }

  // Calls `fn(notification)` for each NOTIFY on `channel`, and `resume()` when
  // the connection has been made again after a loss. Returns the undo.
  async listen(channel, fn, resume) {
    if (!CHANNEL_RE.test(channel)) throw new Error('bad channel ' + channel);
    let set = this.channels.get(channel);
    const fresh = !set;
    if (fresh) { set = new Set(); this.channels.set(channel, set); }
    set.add(fn);
    if (resume) this.resumers.add(resume);
    if (!this.client) await this.connect();
    // Asked again even where the connection was made meanwhile: a channel
    // added while it was being made may have come after its own LISTENs, and
    // a second LISTEN of a channel changes nothing.
    if (fresh && this.client) { const c = this.client; try { await c.query('LISTEN ' + channel); } catch (e) { this.lost(c, e); } }
    return () => { set.delete(fn); if (resume) this.resumers.delete(resume); };
  }

  get connected() { return !!this.client; }

  connect() {
    if (this.stopped || this.client) return Promise.resolve();
    if (!this.pending) this.pending = this._connect().finally(() => { this.pending = null; });
    return this.pending;
  }

  async _connect() {
    const c = this.makeClient();
    c.on('notification', (n) => {
      const set = this.channels.get(n.channel);
      if (!set) return;
      for (const fn of [...set]) { try { fn(n); } catch (e) { log.warn('a listener failed', { channel: n.channel, error: e.message }); } }
    });
    c.on('error', (e) => this.lost(c, e));
    c.on('end', () => this.lost(c, new Error('the connection ended')));
    try {
      await c.connect();
      for (const ch of this.channels.keys()) await c.query('LISTEN ' + ch);
    } catch (e) {
      try { c.removeAllListeners('end'); await c.end(); } catch { /* never opened */ }
      log.warn('could not listen for the database\'s notices; trying again', { error: e.message, in_ms: this.delay });
      this.again();
      return;
    }
    if (this.stopped) { try { await c.end(); } catch { /* gone */ } return; }
    this.client = c;
    this.delay = 1000;
    clearInterval(this.beat);
    this.beat = setInterval(() => {
      const t = setTimeout(() => this.lost(c, new Error('no answer to a heartbeat in 10s')), 10000);
      c.query('SELECT 1').then(() => clearTimeout(t), (e) => { clearTimeout(t); this.lost(c, e); });
    }, 30000);
    if (this.beat.unref) this.beat.unref();
    if (this.lostOnce) {
      log.info('listening again', { channels: [...this.channels.keys()] });
      for (const r of [...this.resumers]) { try { r(); } catch (e) { log.warn('a listener could not resume', { error: e.message }); } }
    }
  }

  lost(c, e) {
    if (this.client !== c) return;   // an old connection, already replaced
    this.client = null;
    this.lostOnce = true;
    clearInterval(this.beat);
    log.warn('the listening connection was lost', { error: e && e.message });
    try { c.removeAllListeners('end'); c.end().catch(() => {}); } catch { /* gone */ }
    this.again();
  }

  again() {
    if (this.stopped || this.retry) return;
    const wait = this.delay;
    this.delay = Math.min(30000, this.delay * 2);
    this.retry = setTimeout(() => { this.retry = null; this.connect(); }, wait);
    if (this.retry.unref) this.retry.unref();
  }

  async close() {
    this.stopped = true;
    clearTimeout(this.retry); this.retry = null;
    clearInterval(this.beat);
    const c = this.client; this.client = null;
    if (this.pending) { try { await this.pending; } catch { /* already said */ } }
    if (c) { try { c.removeAllListeners('end'); c.removeAllListeners('error'); c.on('error', () => {}); await c.end(); } catch { /* gone */ } }
  }
}

export class Db {
  constructor(cfg, env = process.env) {
    this.cfg = cfg;
    const opts = poolOptions(cfg.databaseUrl, env);
    const Client = clientClass(cfg.vaultKey);
    this.pool = new Pool({ ...opts, Client });
    this.pool.on('error', (e) => log.error('pool error', { error: e.message }));
    this.listener = new Listener(() => new Client({ connectionString: opts.connectionString, ssl: opts.ssl, host: opts.host, connectionTimeoutMillis: opts.connectionTimeoutMillis, keepAlive: true, keepAliveInitialDelayMillis: 10000 }));
    // session id -> { alive, at }: whether a signed-in token's session still
    // exists, so "log out everywhere" and a revoked session stop working for
    // data within seconds rather than when the token expires.
    this.sessions = new Map();
    // Sessions the database has said are gone (pental_session_end): an
    // answer read just before the delete committed cannot bring one back.
    this.ended = new Set();
  }

  forgetSessions() { this.sessions.clear(); }

  sessionEnded(id) {
    if (this.ended.size > 50000) this.ended.clear();
    if (this.sessions.size > 50000) this.sessions.clear();
    this.ended.add(id);
    this.sessions.set(id, { alive: false, at: Date.now() });
  }

  _remember(id, alive) {
    if (this.sessions.size > 50000) this.sessions.clear();
    this.sessions.set(id, { alive: alive && !this.ended.has(id), at: Date.now() });
  }

  // Whether a signed-in token's session still exists (cached), for the
  // places that do not run a transaction (realtime presence and broadcast).
  async sessionAlive(claims) {
    const check = this.sessionToCheck({ role: 'authenticated', claims });
    if (!check) return true;
    if (check === 'ended') return false;
    const r = await this.pool.query('SELECT EXISTS (SELECT 1 FROM auth.sessions WHERE id = $1::uuid) AS alive', [check]);
    const alive = !!(r.rows[0] && r.rows[0].alive) && !this.ended.has(check);
    this._remember(check, alive);
    return alive;
  }

  sessionToCheck(ctx) {
    const c = ctx.claims || {};
    if (ctx.role !== 'authenticated' || !c.session_id || !UUID_RE.test(String(c.session_id))) return '';
    if (this.ended.has(c.session_id)) return 'ended';
    const hit = this.sessions.get(c.session_id);
    if (hit && Date.now() - hit.at < (hit.alive ? ALIVE_MS : ENDED_MS)) return hit.alive ? '' : 'ended';
    return c.session_id;
  }

  async close() { await this.listener.close(); await this.pool.end(); }

  // Plain query as the owner, outside any request.
  query(text, params) { return this.pool.query(text, params); }

  // A request's transaction. `ctx`: { role, claims, headers, method, path,
  // statementTimeoutMs }. `fn(client)` runs inside; its result is returned
  // after COMMIT. Any throw rolls back and rethrows.
  //
  // The transaction is opened, the session checked and every setting made in
  // ONE round trip: BEGIN, then the settings through set_config (the role
  // too, as PostgREST does it), with each value escaped as a literal by the
  // driver. So a request costs three trips (that, its own query, COMMIT)
  // rather than six.
  async transaction(ctx, fn) {
    const claims = ctx.claims || {};
    const role = ctx.role || 'anon';
    if (role !== 'owner' && !/^[a-z_]+$/.test(role)) throw new Error('bad role');
    const check = this.sessionToCheck({ role, claims });
    if (check === 'ended') throw sessionEnded();
    const client = await this.pool.connect();
    let began = false;
    let broken = false;
    try {
      const timeout = parseInt(ctx.statementTimeoutMs || (role === 'owner' ? this.cfg.ownerStatementTimeoutMs : this.cfg.statementTimeoutMs), 10) || 30000;
      const sets = [
        ['statement_timeout', String(timeout)],
        ['request.jwt.claims', JSON.stringify(claims)],
        ['request.jwt.claim.role', String(claims.role || role)],
        ['request.jwt.claim.sub', claims.sub == null ? '' : String(claims.sub)],
        ['request.jwt.claim.email', claims.email == null ? '' : String(claims.email)],
        ['request.headers', JSON.stringify(ctx.headers || {})],
        // 1.10.0: the address the request came from, as this gateway saw it
        // (rest/index.js, requestIp). A setting, so no caller can make it.
        ['pental.client_ip', String(ctx.clientIp || '')],
        ['request.method', String(ctx.method || '')],
        ['request.path', String(ctx.path || '')],
        ['request.cookies', '{}'],
        // PostgREST's search path: the request's schema, then extensions.
        ['search_path', ctx.searchPath || 'public, extensions'],
      ];
      if (role !== 'owner') sets.push(['role', role]);
      const lit = (v) => client.escapeLiteral(String(v));
      const setSql = 'SELECT ' + sets.map(([k, v]) => `set_config(${lit(k)}, ${lit(v)}, true)`).join(', ');
      const aliveSql = check ? `SELECT EXISTS (SELECT 1 FROM auth.sessions WHERE id = ${lit(check)}::uuid) AS alive; ` : '';
      began = true;
      const pre = await client.query('BEGIN; ' + aliveSql + setSql);
      if (check) {
        const alive = !!(Array.isArray(pre) && pre[1] && pre[1].rows[0] && pre[1].rows[0].alive) && !this.ended.has(check);
        this._remember(check, alive);
        if (!alive) throw sessionEnded();
      }
      const out = await fn(client);
      await client.query('COMMIT');
      began = false;
      return out;
    } catch (e) {
      // 1.10.0: a connection that cannot roll back is gone, and is let go as
      // such rather than handed to the next request.
      if (began) { try { await client.query('ROLLBACK'); } catch { broken = true; } }
      if (e && typeof e === 'object') e.pentalRole = ctx.role || 'anon';
      throw e;
    } finally {
      client.release(broken || undefined);
    }
  }

  // The owner's transaction: the gateway's own work.
  asOwner(fn, extra = {}) { return this.transaction({ role: 'owner', ...extra }, fn); }
}

// A token whose session has been signed out: the answer PostgREST gives an
// expired token, which is what makes supabase-js refresh (and, the session
// being gone, sign the person out).
function sessionEnded() {
  return new HttpError(401, { code: 'PGRST301', message: 'JWT expired', details: 'The session this token belongs to has ended.', hint: null });
}
