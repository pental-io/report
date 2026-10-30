// /rest/v1: tables and functions, the way PostgREST serves them.
//
// Every request is one transaction as the caller's role (see db.js), so the
// portal schema's row policies and functions see exactly what they see on
// Supabase. What comes back is what PostgREST would send: the same status
// codes, Content-Range, single-object handling and error shapes, which the
// portal reads by code (PGRST116, PGRST202, PGRST204, PGRST301, 42703...).
import { HttpError, readBody, sendJson, parsePrefer, clientIp } from '../http.js';
import { parseQuery, rpcArgsFromQuery } from './parse.js';
import { buildSelect, buildInsert, buildUpdate, buildDelete, buildRpc, pickOverload } from './sql.js';
import { log } from '../log.js';

const SINGLE = 'application/vnd.pgrst.object+json';
const MAX_BODY = 20 * 1024 * 1024;
// What the setup token may call over REST: the move's own functions and the
// version check. Everything else it does is on /pental/v1 or /storage/v1.
const SETUP_TOKEN_RPCS = /^(rpc_transfer_[a-z_]+|rpc_get_schema_version)$/;

// PostgREST's status for a Postgres error, by SQLSTATE.
export function statusForPgError(code, role) {
  const c = String(code || '');
  // A function's own answer, as PostgREST gives it: PTnnn is HTTP status nnn
  // (1.7.0: rpc_scan_push refuses a pipeline's post this way, so its step
  // fails rather than passing with its output lost).
  if (/^PT[1-5]\d\d$/.test(c)) return Number(c.slice(2));
  if (c === '42501') return role === 'anon' ? 401 : 403;
  if (c === '42883' || c === '42P01') return 404;
  if (c === '23505' || c === '23503') return 409;
  if (c === '57014') return 503;
  if (c === '53300' || c === '53400') return 503;
  if (/^(08|53|57P)/.test(c)) return 503;
  if (/^(0L|0P|28)/.test(c)) return 403;
  if (c === '25006') return 405;
  if (c === '54000' || c === '54001') return 413;
  if (c === 'P0001') return 400;
  if (/^(22|23|42|2F|3F|20|21|24|P0)/.test(c)) return 400;
  return 500;
}

export function pgErrorBody(e) {
  const code = String(e.code || '');
  if (code === '42883') {
    return { code: 'PGRST202', message: e.message, details: e.detail || null, hint: e.hint || 'Perhaps you meant to call a function with different arguments, or it is not defined yet.' };
  }
  if (code === '42P01') {
    return { code: 'PGRST205', message: e.message, details: e.detail || null, hint: e.hint || null };
  }
  return { code: code || 'PGRST000', message: e.message, details: e.detail || null, hint: e.hint || null };
}

function parseRange(req) {
  const h = String(req.headers.range || '');
  const m = /^(\d+)-(\d*)$/.exec(h.trim());
  if (!m) return null;
  const from = parseInt(m[1], 10);
  const to = m[2] === '' ? null : parseInt(m[2], 10);
  return { offset: from, limit: to == null ? null : Math.max(0, to - from + 1) };
}

function wantsSingle(req) {
  return String(req.headers.accept || '').includes(SINGLE);
}

function singleOrThrow(bodyText, n) {
  if (n === 1) return bodyText.slice(1, -1);
  throw new HttpError(406, {
    code: 'PGRST116',
    details: n === 0 ? 'The result contains 0 rows' : `Results contain ${n} rows, ${SINGLE} requires 1 row`,
    hint: null,
    message: 'JSON object requested, multiple (or no) rows returned',
  });
}

// The headers a request carries into request.headers, lower-cased, minus
// what only the transport cares about and anything that would let a caller
// forge the gateway's own attestation.
export function requestHeaders(req, extra) {
  const out = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const key = k.toLowerCase();
    if (key === 'x-pental-attest' || key === 'host' || key === 'connection' || key === 'content-length' || key === 'transfer-encoding') continue;
    out[key] = Array.isArray(v) ? v.join(', ') : String(v);
  }
  return Object.assign(out, extra || {});
}

// 1.10.0: the address a request came from, as this gateway saw it (behind
// `hops` proxies, the entry the nearest appended, else the socket's). It goes
// to the database as pental.client_ip, a setting no caller can make, for the
// address a proposal is signed from (byo-setup.sql 1841, _request_ip).
export function requestIp(req, hops) {
  try { return String(clientIp(req, hops) || '').trim().slice(0, 64); } catch { return ''; }
}

export class Rest {
  constructor({ db, schema, authz, attest, cfg }) {
    this.db = db; this.schema = schema; this.authz = authz; this.attest = attest; this.cfg = cfg;
  }

  profile(req, method) {
    const h = method === 'GET' || method === 'HEAD' ? req.headers['accept-profile'] : req.headers['content-profile'];
    const s = String(h || 'public').trim();
    if (!['public', 'storage'].includes(s)) throw new HttpError(406, { code: 'PGRST106', message: `The schema must be one of the following: public, storage`, details: null, hint: null });
    return s;
  }

  async handle(req, res, url, params) {
    const method = req.method.toUpperCase();
    const who = this.authz.resolve(req, url);
    // The setup token is the owner, past every row policy; over REST it only
    // runs the functions a database move and the setup need, never a table.
    if (who.setup && !(params.fn !== undefined && SETUP_TOKEN_RPCS.test(String(params.fn)))) {
      throw new HttpError(401, { code: 'PGRST301', message: 'The setup token is not an API key', details: 'Use the publishable key, or a signed-in session.', hint: null });
    }
    await this.schema.ensure();
    if (params.table === undefined && params.fn === undefined) return this.root(req, res, who);
    const prefer = parsePrefer(req);
    const range = parseRange(req);
    let q;
    try { q = parseQuery(url.searchParams); } catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(400, { code: 'PGRST100', message: e.message, details: null, hint: null }); }
    const single = wantsSingle(req);
    const ctx = { role: who.role, claims: who.claims, headers: requestHeaders(req), clientIp: requestIp(req, this.cfg && this.cfg.proxyHops), method, path: url.pathname };

    const run = async () => {
      if (params.fn !== undefined) return this.rpc(req, res, url, params.fn, who, q, prefer, range, single, ctx, method);
      return this.table(req, res, url, params.table, who, q, prefer, range, single, ctx, method);
    };
    try {
      return await run();
    } catch (e) {
      // A name this cache does not know may be new: reload once and retry.
      // 1.10.0: at most every five seconds. Any key holder could ask for
      // names that do not exist, and each asking read the whole catalogue
      // again; a schema that changed is announced (NOTIFY pgrst) and read at
      // once, and the setup reads it as it finishes.
      if (e && (e.code === '42703' || e.code === '42P01' || e.code === '42883') && !e._retried
          && (this.schema.loading || Date.now() - (this.schema.loadedAt || 0) > 5000)) {
        await this.schema.load();
        e._retried = true;
        try { return await run(); } catch (e2) { throw e2; }
      }
      throw e;
    }
  }

  // GET /rest/v1/ : a small OpenAPI document naming the tables and their
  // columns, which is what tools use it for.
  async root(req, res, who) {
    const paths = {};
    const definitions = {};
    for (const t of this.schema.tables.values()) {
      if (t.schema !== 'public') continue;
      paths['/' + t.name] = { get: { tags: [t.name], summary: t.name } };
      const properties = {};
      for (const c of t.columns.values()) properties[c.name] = { type: c.type, format: c.type };
      definitions[t.name] = { properties, required: t.pk };
    }
    sendJson(res, 200, { swagger: '2.0', info: { title: 'Pental gateway', version: this.cfg.version || '' }, host: (this.cfg.publicUrl || '').replace(/^https?:\/\//, ''), basePath: '/rest/v1', paths, definitions });
  }

  async table(req, res, url, name, who, q, prefer, range, single, ctx, method) {
    const schemaName = this.profile(req, method);
    const table = this.schema.table(schemaName, name);
    if (!table) throw new HttpError(404, { code: 'PGRST205', message: `Could not find the table '${schemaName}.${name}' in the schema cache`, details: null, hint: null });
    const countWanted = prefer.count === 'exact' || prefer.count === 'planned' || prefer.count === 'estimated';

    if (method === 'GET' || method === 'HEAD') {
      const built = buildSelect(q, table, range);
      const out = await this.db.transaction(ctx, async (client) => {
        const r = await client.query(built.sql, built.params);
        let count = null;
        if (countWanted) { const c = await client.query(built.countSql, built.countParams); count = parseInt(c.rows[0].n, 10); }
        return { body: r.rows[0].body, count };
      });
      const n = countRows(out.body);
      const offset = q.offset != null ? q.offset : (range && range.offset != null ? range.offset : 0);
      const headers = { 'Content-Range': contentRange(offset, n, out.count) };
      if (method === 'HEAD') { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', ...headers }); res.end(); return; }
      const text = single ? singleOrThrow(out.body, n) : out.body;
      return sendRaw(res, 200, text, headers);
    }

    if (method === 'POST') {
      const rows = await this.jsonBody(req);
      const list = Array.isArray(rows) ? rows : [rows];
      for (const r of list) if (!r || typeof r !== 'object' || Array.isArray(r)) throw new HttpError(400, { code: 'PGRST102', message: 'Empty or invalid json', details: null, hint: null });
      const built = buildInsert(q, table, list, prefer);
      const out = await this.db.transaction(ctx, async (client) => {
        const r = await client.query(built.sql, built.params);
        return built.wantRows ? { body: r.rows[0].body, n: countRows(r.rows[0].body) } : { body: '', n: r.rowCount || 0 };
      });
      const headers = { 'Content-Range': built.wantRows ? contentRange(0, out.n, null) : '*/*' };
      if (!built.wantRows) { res.writeHead(201, headers); res.end(); return; }
      const text = single ? singleOrThrow(out.body, out.n) : out.body;
      return sendRaw(res, 201, text, headers);
    }

    if (method === 'PATCH') {
      const row = await this.jsonBody(req);
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw new HttpError(400, { code: 'PGRST102', message: 'Empty or invalid json', details: null, hint: null });
      const built = buildUpdate(q, table, row, prefer, range);
      const out = await this.db.transaction(ctx, async (client) => {
        const r = await client.query(built.sql, built.params);
        return built.wantRows ? { body: r.rows[0].body, n: countRows(r.rows[0].body) } : { body: '', n: r.rowCount || 0 };
      });
      const headers = { 'Content-Range': built.wantRows ? contentRange(0, out.n, null) : '*/*' };
      if (!built.wantRows) { res.writeHead(204, headers); res.end(); return; }
      const text = single ? singleOrThrow(out.body, out.n) : out.body;
      return sendRaw(res, 200, text, headers);
    }

    if (method === 'DELETE') {
      const built = buildDelete(q, table, prefer, range);
      const out = await this.db.transaction(ctx, async (client) => {
        const r = await client.query(built.sql, built.params);
        return built.wantRows ? { body: r.rows[0].body, n: countRows(r.rows[0].body) } : { body: '', n: r.rowCount || 0 };
      });
      const headers = { 'Content-Range': built.wantRows ? contentRange(0, out.n, null) : '*/*' };
      if (!built.wantRows) { res.writeHead(204, headers); res.end(); return; }
      const text = single ? singleOrThrow(out.body, out.n) : out.body;
      return sendRaw(res, 200, text, headers);
    }

    throw new HttpError(405, { code: 'PGRST100', message: `Method ${method} is not allowed`, details: null, hint: null });
  }

  async rpc(req, res, url, name, who, q, prefer, range, single, ctx, method) {
    let args;
    if (method === 'POST') {
      const body = await this.jsonBody(req);
      if (body === null) args = {};
      else if (typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, { code: 'PGRST102', message: 'Empty or invalid json', details: null, hint: null });
      else args = body;
    } else if (method === 'GET' || method === 'HEAD') {
      args = rpcArgsFromQuery(url.searchParams);
    } else {
      throw new HttpError(405, { code: 'PGRST100', message: `Method ${method} is not allowed`, details: null, hint: null });
    }
    const overloads = this.schema.overloads('public', name);
    const fn = pickOverload(overloads, args);
    if (!fn) {
      const sig = Object.keys(args).join(', ');
      throw new HttpError(404, {
        code: 'PGRST202',
        message: `Could not find the function public.${name}(${sig}) in the schema cache`,
        details: `Searched for the function public.${name} with parameter${Object.keys(args).length === 1 ? '' : 's'} ${sig || '(none)'} in the schema cache, but no matches were found.`,
        hint: overloads.length ? `Perhaps you meant to call the function public.${name}(${overloads[0].args.map((a) => a.name).join(', ')})` : null,
      });
    }
    // 1803: a signed Pental envelope or a WebAuthn assertion in the
    // arguments is verified here, and the verdict rides on a header only
    // the gateway can write. See attest.js.
    if (this.attest) {
      const attest = await this.attest.forRpc(name, args).catch((e) => { log.warn('attestation failed', { fn: name, error: e.message }); return ''; });
      if (attest) ctx.headers['x-pental-attest'] = attest;
    }
    const built = buildRpc(fn, args, q, range);
    const out = await this.db.transaction(ctx, async (client) => {
      const r = await client.query(built.sql, built.params);
      if (built.kind === 'void') return { body: '', n: 0 };
      if (built.kind === 'scalar') return { body: r.rows[0] ? (r.rows[0].body == null ? 'null' : r.rows[0].body) : 'null', n: 1 };
      return { body: r.rows[0].body, n: countRows(r.rows[0].body) };
    });
    if (method === 'HEAD') { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(); return; }
    if (built.kind === 'void') { res.writeHead(204); res.end(); return; }
    if (built.kind === 'scalar') return sendRaw(res, 200, out.body, {});
    const headers = { 'Content-Range': contentRange(q.offset || 0, out.n, null) };
    const text = single ? singleOrThrow(out.body, out.n) : out.body;
    return sendRaw(res, 200, text, headers);
  }

  // Read once and kept on the request: the retry after a schema reload runs
  // the handler again, and a body already taken from the stream would leave
  // it waiting for bytes that never come.
  async jsonBody(req) {
    if (req._pentalBody === undefined) req._pentalBody = await readBody(req, { limit: MAX_BODY });
    const buf = req._pentalBody;
    if (!buf.length) return null;
    try { return JSON.parse(buf.toString('utf8')); }
    catch { throw new HttpError(400, { code: 'PGRST102', message: 'Empty or invalid json', details: null, hint: null }); }
  }
}

function sendRaw(res, status, text, headers) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...(headers || {}) });
  res.end(text);
}

function contentRange(offset, n, count) {
  const total = count == null ? '*' : String(count);
  if (!n) return `*/${total}`;
  return `${offset}-${offset + n - 1}/${total}`;
}

// How many rows a JSON array text holds, without parsing more than needed.
export function countRows(text) {
  if (!text || text === '[]') return 0;
  try { const v = JSON.parse(text); return Array.isArray(v) ? v.length : 1; } catch { return 0; }
}
