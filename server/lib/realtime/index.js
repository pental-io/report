// /realtime/v1/websocket: live changes and presence, in the Phoenix protocol
// realtime-js speaks (message version 1.0.0 as objects, 2.0.0 as arrays).
//
// Changes come from the database over NOTIFY (pental.rt_notify, attached to
// every table in the realtime publication): the table, the operation and the
// primary key, nothing more. For each subscriber the gateway then reads that
// row again in a transaction as that subscriber, so the schema's row
// policies decide who is told, with only the columns their role may select.
// A delete carries only the key, as it does on Supabase. Presence and
// broadcast are kept in memory per topic; nothing about them touches the
// database.
import { WebSocketServer } from 'ws';
import { notASession } from '../authz.js';
import { verifyJwt } from '../jwt.js';
import { log } from '../log.js';
import { clientIp } from '../http.js';

const HEARTBEAT_MS = 60000;
const MAX_BINDINGS = 200;
const MAX_TOPIC = 255;               // characters in a topic name
const MAX_PRESENCE_BYTES = 8192;     // one presence entry, as JSON

function encodeFor(vsn, msg) {
  if (vsn === '2.0.0') return JSON.stringify([msg.join_ref ?? null, msg.ref ?? null, msg.topic, msg.event, msg.payload]);
  return JSON.stringify({ topic: msg.topic, event: msg.event, payload: msg.payload, ref: msg.ref ?? null, join_ref: msg.join_ref ?? null });
}
function decodeFor(vsn, raw) {
  const j = JSON.parse(raw);
  if (Array.isArray(j)) { const [join_ref, ref, topic, event, payload] = j; return { join_ref, ref, topic, event, payload }; }
  return j;
}

// "col=eq.value", the one filter shape postgres_changes takes.
function matchesFilter(filter, record) {
  if (!filter) return true;
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(eq|neq|lt|lte|gt|gte|in)\.(.*)$/s.exec(String(filter));
  if (!m) return false;
  const v = record ? record[m[1]] : undefined;
  const want = m[3];
  const sv = v == null ? null : String(v);
  switch (m[2]) {
    case 'eq': return sv === want;
    case 'neq': return sv !== want;
    case 'in': return want.replace(/^\(|\)$/g, '').split(',').map((x) => x.trim().replace(/^"|"$/g, '')).includes(sv);
    case 'lt': return sv != null && Number(sv) < Number(want);
    case 'lte': return sv != null && Number(sv) <= Number(want);
    case 'gt': return sv != null && Number(sv) > Number(want);
    case 'gte': return sv != null && Number(sv) >= Number(want);
    default: return false;
  }
}

export class Realtime {
  constructor({ db, cfg, authz, schema }) {
    this.db = db; this.cfg = cfg; this.authz = authz; this.schema = schema;
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
    this.sockets = new Set();
    this.topics = new Map();      // topic -> Set(socket)
    this.presence = new Map();    // topic -> Map(key -> [{phx_ref, ...meta}])
    this.columnCache = new Map(); // "role|schema.table" -> [columns]
    this.nextBindingId = 1;
    this.listener = null;
    this._outbox = Promise.resolve();
    this._hb = null;
    this.perClient = new Map();   // client address -> open sockets
  }

  connectionCount() { return this.sockets.size; }

  async start() {
    await this.listen();
    this._hb = setInterval(() => {
      for (const ws of this.sockets) {
        if (ws._alive === false) { ws.terminate(); continue; }
        ws._alive = false;
        try { ws.ping(); } catch { /* closing */ }
      }
    }, HEARTBEAT_MS);
    if (this._hb.unref) this._hb.unref();
  }

  // On the gateway's one listening connection (db.js, Listener, 1.10.0),
  // which makes itself again after a loss; this listened again on every
  // loss as well, without letting go of the last one, so each failover
  // doubled the work and the pool slots it held.
  async listen() {
    try {
      // Changes are read concurrently but sent in the order they were
      // committed (a NOTIFY arrives in commit order): a subscriber never sees
      // a later change before an earlier one because its row took longer to read.
      const onRt = (n) => {
        // 1.10.0: at most 5,000 changes being read at once. A burst (an import
        // of thousands of rows) started a read for every one, all waiting on
        // the pool and held in memory without end. Past that, a change is
        // not sent (a subscriber reloads what it shows on its next load), and
        // it is said once.
        if ((this._pending || 0) >= 5000) {
          if (!this._dropping) { this._dropping = true; log.warn('realtime: 5,000 changes waiting to be read; further changes are not sent until it catches up'); }
          return;
        }
        this._dropping = false;
        this._pending = (this._pending || 0) + 1;
        const work = this.onChange(n.payload).catch((e) => { log.warn('realtime change failed', { error: e.message }); return []; })
          .finally(() => { this._pending--; });
        this._outbox = this._outbox.then(() => work).then((sends) => { for (const f of sends) { try { f(); } catch { /* a socket gone */ } } });
      };
      const a = await this.db.listener.listen('pental_rt', onRt, () => log.warn('realtime listening again: a change made while the connection was down was not sent'));
      const b = await this.db.listener.listen('pental_session_end', (n) => this.sessionEnded(n.payload));
      this.listener = () => { a(); b(); };
      log.info('realtime listening');
    } catch (e) {
      log.error('realtime LISTEN failed', { error: e.message });
    }
  }

  async stop() {
    if (this._hb) clearInterval(this._hb);
    for (const ws of this.sockets) { try { ws.terminate(); } catch { /* gone */ } }
    this.sockets.clear();
    if (this.listener) {
      const u = this.listener; this.listener = null;
      u();
    }
    await new Promise((r) => this.wss.close(r));
  }

  upgrade(req, socket, head) {
    let url;
    try { url = new URL(req.url, 'http://gateway'); } catch { socket.destroy(); return; }
    if (url.pathname !== '/realtime/v1/websocket' && url.pathname !== '/realtime/v1/websocket/') { socket.destroy(); return; }
    const apikey = url.searchParams.get('apikey') || '';
    const k = verifyJwt(apikey, this.cfg.jwtSecret);
    if (!k.ok || !k.claims || !k.claims.role || k.claims.kind) {
      socket.write('HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nInvalid API key');
      socket.destroy();
      return;
    }
    // One address may not take the whole gateway's sockets.
    const ip = clientIp(req, this.cfg.proxyHops);
    if (this.sockets.size >= this.cfg.realtime.maxConnections || (this.perClient.get(ip) || 0) >= this.cfg.realtime.maxPerClient) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const vsn = url.searchParams.get('vsn') === '2.0.0' ? '2.0.0' : '1.0.0';
    this.wss.handleUpgrade(req, socket, head, (ws) => { ws._ip = ip; this.onConnection(ws, vsn, apikey); });
  }

  onConnection(ws, vsn, apikey) {
    this.perClient.set(ws._ip, (this.perClient.get(ws._ip) || 0) + 1);
    ws._vsn = vsn;
    ws._alive = true;
    ws._channels = new Map();   // topic -> { joinRef, who, bindings, presenceKey, myRef }
    ws._apikeyClaims = verifyJwt(apikey, this.cfg.jwtSecret).claims;
    this.sockets.add(ws);
    ws.on('pong', () => { ws._alive = true; });
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let msg;
      try { msg = decodeFor(vsn, data.toString('utf8')); } catch { return; }
      this.onMessage(ws, msg).catch((e) => log.warn('realtime message failed', { error: e.message }));
    });
    ws.on('close', () => this.onClose(ws));
    ws.on('error', () => { /* close follows */ });
  }

  send(ws, msg) {
    if (ws.readyState !== ws.OPEN) return;
    try { ws.send(encodeFor(ws._vsn, msg)); } catch { /* closing */ }
  }

  reply(ws, msg, status, response) {
    this.send(ws, { topic: msg.topic, event: 'phx_reply', payload: { status, response: response || {} }, ref: msg.ref, join_ref: msg.join_ref });
  }

  // Who a channel runs as: the bearer given at join, else the api key.
  whoFrom(ws, token) {
    if (token) {
      const v = verifyJwt(token, this.cfg.jwtSecret);
      if (!v.ok) return { error: v.expired ? 'Token has expired' : 'Invalid token' };
      const role = String(v.claims.role || 'anon');
      if (role !== 'anon' && role !== 'authenticated') return { error: 'Role not allowed' };
      if (notASession(v.claims, role)) return { error: 'Invalid token' };   // 1.10.0 (authz.js)
      return { role, claims: v.claims };
    }
    return { role: 'anon', claims: ws._apikeyClaims || { role: 'anon' } };
  }

  async onMessage(ws, msg) {
    if (!msg || typeof msg !== 'object') return;
    const { topic, event, payload } = msg;
    if (topic === 'phoenix' && event === 'heartbeat') { this.reply(ws, msg, 'ok', {}); return; }
    if (typeof topic !== 'string') return;
    if (event === 'phx_join') return this.join(ws, msg);
    const ch = ws._channels.get(topic);
    if (!ch) { if (event !== 'phx_leave') this.reply(ws, msg, 'error', { reason: 'not joined' }); else this.reply(ws, msg, 'ok', {}); return; }
    if (event === 'phx_leave') { this.leave(ws, topic); this.reply(ws, msg, 'ok', {}); return; }
    if (event === 'access_token') {
      const who = this.whoFrom(ws, payload && payload.access_token);
      if (!who.error && !(await this.alive(who))) who.error = 'Token has expired';
      if (who.error) { this.kick(ws, topic, ch, who.error); return; }
      ch.who = who;
      return;
    }
    // Every other message is made under the channel's token: past its expiry,
    // or once its session has been signed out, the channel is closed.
    const now = Math.floor(Date.now() / 1000);
    if ((ch.who.claims && typeof ch.who.claims.exp === 'number' && ch.who.claims.exp < now) || !(await this.alive(ch.who))) {
      this.kick(ws, topic, ch, 'Token has expired');
      return;
    }
    // Presence and broadcast are for signed-in people: the publishable key is
    // public, and anybody holding it must not be able to appear in, or speak
    // on, somebody's channel.
    if ((event === 'presence' || event === 'broadcast') && ch.who.role !== 'authenticated') {
      this.reply(ws, msg, 'error', { reason: 'Sign in to use presence and broadcast' });
      return;
    }
    if (event === 'presence') {
      const type = payload && payload.event;
      if (type === 'track') {
        const meta = payload.payload || {};
        if (JSON.stringify(meta).length > MAX_PRESENCE_BYTES) { this.reply(ws, msg, 'error', { reason: 'Presence entry too large' }); return; }
        this.track(ws, topic, meta);
      } else if (type === 'untrack') this.untrack(ws, topic);
      this.reply(ws, msg, 'ok', {});
      return;
    }
    if (event === 'broadcast') {
      const out = { topic, event: 'broadcast', payload, ref: null, join_ref: null };
      for (const other of this.topics.get(topic) || []) {
        if (other === ws && !(ch.config && ch.config.broadcast && ch.config.broadcast.self)) continue;
        this.send(other, out);
      }
      if (ch.config && ch.config.broadcast && ch.config.broadcast.ack) this.reply(ws, msg, 'ok', {});
      return;
    }
  }

  async alive(who) {
    if (!who || who.role !== 'authenticated') return true;
    try { return await this.db.sessionAlive(who.claims); } catch { return true; }
  }

  // A session ended anywhere (signed out, revoked from another device, the
  // account removed): it stops working for data at once, and its channels
  // are closed.
  sessionEnded(id) {
    const sid = String(id || '');
    if (!/^[0-9a-f-]{36}$/i.test(sid)) return;
    this.db.sessionEnded(sid);
    for (const ws of this.sockets) {
      for (const [topic, ch] of Array.from(ws._channels)) {
        if (ch.who && ch.who.claims && ch.who.claims.session_id === sid) this.kick(ws, topic, ch, 'Session ended');
      }
    }
  }

  kick(ws, topic, ch, reason) {
    this.send(ws, { topic, event: 'phx_error', payload: { reason }, ref: null, join_ref: ch.joinRef });
    this.leave(ws, topic);
  }

  async join(ws, msg) {
    const { topic, payload } = msg;
    const cfg = (payload && payload.config) || {};
    if (topic.length > MAX_TOPIC) { this.reply(ws, msg, 'error', { reason: 'Topic name too long' }); return; }
    if (!ws._channels.has(topic) && ws._channels.size >= this.cfg.realtime.maxTopicsPerSocket) { this.reply(ws, msg, 'error', { reason: 'Too many channels on one connection' }); return; }
    const who = this.whoFrom(ws, payload && payload.access_token);
    if (!who.error && !(await this.alive(who))) who.error = 'Token has expired';
    if (who.error) { this.reply(ws, msg, 'error', { reason: who.error }); return; }
    const wanted = Array.isArray(cfg.postgres_changes) ? cfg.postgres_changes.slice(0, MAX_BINDINGS) : [];
    await this.schema.ensure();
    const bindings = [];
    for (const b of wanted) {
      const schema = String(b.schema || 'public');
      const table = String(b.table || '*');
      if (schema !== 'public') { this.reply(ws, msg, 'error', { reason: `schema ${schema} is not published` }); return; }
      if (table !== '*' && !this.schema.table('public', table)) { this.reply(ws, msg, 'error', { reason: `table ${table} does not exist` }); return; }
      bindings.push({ id: this.nextBindingId++, event: String(b.event || '*').toUpperCase(), schema, table, filter: b.filter ? String(b.filter) : undefined });
    }
    if (ws._channels.has(topic)) this.leave(ws, topic);
    ws._channels.set(topic, { joinRef: msg.ref, who, bindings, config: cfg, presenceKey: cfg.presence && cfg.presence.key ? String(cfg.presence.key) : '', myRef: '' });
    if (!this.topics.has(topic)) this.topics.set(topic, new Set());
    this.topics.get(topic).add(ws);
    this.reply(ws, msg, 'ok', { postgres_changes: bindings.map((b) => ({ id: b.id, event: b.event === '*' ? '*' : b.event, schema: b.schema, table: b.table, filter: b.filter })) });
    if (cfg.presence) this.send(ws, { topic, event: 'presence_state', payload: this.presenceState(topic), ref: null, join_ref: null });
  }

  leave(ws, topic) {
    const ch = ws._channels.get(topic);
    if (!ch) return;
    this.untrack(ws, topic);
    ws._channels.delete(topic);
    const set = this.topics.get(topic);
    if (set) { set.delete(ws); if (!set.size) { this.topics.delete(topic); this.presence.delete(topic); } }
  }

  onClose(ws) {
    for (const topic of [...ws._channels.keys()]) this.leave(ws, topic);
    this.sockets.delete(ws);
    const n = (this.perClient.get(ws._ip) || 1) - 1;
    if (n > 0) this.perClient.set(ws._ip, n); else this.perClient.delete(ws._ip);
  }

  // ── presence ─────────────────────────────────────────────────────────────
  presenceState(topic) {
    const out = {};
    for (const [key, metas] of this.presence.get(topic) || []) if (metas.length) out[key] = { metas };
    return out;
  }
  track(ws, topic, meta) {
    const ch = ws._channels.get(topic);
    if (!ch) return;
    const key = ch.presenceKey || (ch.who.claims && ch.who.claims.sub) || 'anon';
    if (!this.presence.has(topic)) this.presence.set(topic, new Map());
    const map = this.presence.get(topic);
    const leaves = {};
    if (ch.myRef) {
      const prev = (map.get(key) || []).filter((m) => m.phx_ref === ch.myRef);
      if (prev.length) leaves[key] = { metas: prev };
      map.set(key, (map.get(key) || []).filter((m) => m.phx_ref !== ch.myRef));
    }
    ch.myRef = 'r' + Math.random().toString(36).slice(2, 12);
    const entry = { ...meta, phx_ref: ch.myRef };
    map.set(key, [...(map.get(key) || []), entry]);
    this.diff(topic, { [key]: { metas: [entry] } }, leaves);
  }
  untrack(ws, topic) {
    const ch = ws._channels.get(topic);
    const map = this.presence.get(topic);
    if (!ch || !ch.myRef || !map) return;
    const key = ch.presenceKey || (ch.who.claims && ch.who.claims.sub) || 'anon';
    const prev = (map.get(key) || []).filter((m) => m.phx_ref === ch.myRef);
    map.set(key, (map.get(key) || []).filter((m) => m.phx_ref !== ch.myRef));
    if (!map.get(key).length) map.delete(key);
    ch.myRef = '';
    if (prev.length) this.diff(topic, {}, { [key]: { metas: prev } });
  }
  diff(topic, joins, leaves) {
    const out = { topic, event: 'presence_diff', payload: { joins, leaves }, ref: null, join_ref: null };
    for (const ws of this.topics.get(topic) || []) this.send(ws, out);
  }

  // ── changes ──────────────────────────────────────────────────────────────
  async columnsFor(role, schema, table) {
    const key = role + '|' + schema + '.' + table;
    const hit = this.columnCache.get(key);
    if (hit && Date.now() - hit.at < 60000) return hit.cols;
    const r = await this.db.query(
      `SELECT a.attname AS name, t.typname AS type
         FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_type t ON t.oid = a.atttypid
        WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
          AND has_column_privilege($3::name, a.attrelid, a.attnum, 'SELECT')
        ORDER BY a.attnum`, [schema, table, role === 'owner' ? 'authenticated' : role]);
    const cols = r.rows.map((x) => ({ name: x.name, type: x.type }));
    this.columnCache.set(key, { cols, at: Date.now() });
    return cols;
  }

  // What one committed change means for each subscriber, as sends to make
  // (the caller makes them in commit order).
  async onChange(raw) {
    const out = [];
    let ev;
    try { ev = JSON.parse(raw); } catch { return out; }
    if (!ev || ev.s !== 'public' || !ev.t || !ev.k) return out;
    const type = ev.op === 'INSERT' ? 'INSERT' : ev.op === 'UPDATE' ? 'UPDATE' : ev.op === 'DELETE' ? 'DELETE' : '';
    if (!type) return out;
    const now = Math.floor(Date.now() / 1000);
    const fetched = new Map();   // sub|role -> record or null
    for (const ws of this.sockets) {
      for (const [topic, ch] of ws._channels) {
        const ids = ch.bindings.filter((b) => (b.table === '*' || b.table === ev.t) && (b.event === '*' || b.event === type)).map((b) => b);
        if (!ids.length) continue;
        if (ch.who.claims && typeof ch.who.claims.exp === 'number' && ch.who.claims.exp < now) {
          const joinRef = ch.joinRef;
          this.leave(ws, topic);
          out.push(() => this.send(ws, { topic, event: 'phx_error', payload: { reason: 'Token has expired' }, ref: null, join_ref: joinRef }));
          continue;
        }
        // A deleted row cannot be read back to ask its policies, so all a
        // delete carries is its key, and that goes only to signed-in people
        // whose session still stands (Supabase sends it to every subscriber
        // of the table, the publishable key's included).
        if (type === 'DELETE' && (ch.who.role !== 'authenticated' || !(await this.alive(ch.who)))) continue;
        const cols = await this.columnsFor(ch.who.role, 'public', ev.t);
        let record = {};
        let visible = true;
        if (type !== 'DELETE') {
          const key = (ch.who.claims && ch.who.claims.sub ? ch.who.claims.sub : '') + '|' + ch.who.role;
          if (!fetched.has(key)) {
            try {
              const pkCols = Object.keys(ev.k);
              const where = pkCols.map((c, i) => `"${c.replace(/"/g, '""')}" = $${i + 1}`).join(' AND ');
              const select = cols.map((c) => `"${c.name.replace(/"/g, '""')}"`).join(', ') || 'NULL AS _none';
              const row = await this.db.transaction({ role: ch.who.role, claims: ch.who.claims, headers: {}, method: 'GET', path: '/realtime/v1' }, async (client) =>
                (await client.query(`SELECT ${select} FROM "public"."${ev.t.replace(/"/g, '""')}" WHERE ${where}`, pkCols.map((c) => ev.k[c]))).rows[0] || null);
              fetched.set(key, row);
            } catch (e) {
              fetched.set(key, null);
              log.debug('realtime row read failed', { table: ev.t, error: e.message });
            }
          }
          record = fetched.get(key);
          visible = !!record;
        }
        if (!visible) continue;
        const matched = ids.filter((b) => matchesFilter(b.filter, type === 'DELETE' ? ev.k : record));
        if (!matched.length) continue;
        const data = {
          schema: 'public', table: ev.t, commit_timestamp: ev.at || new Date().toISOString(), type,
          columns: cols, record: type === 'DELETE' ? {} : record, old_record: type === 'INSERT' ? {} : (ev.ko || ev.k), errors: null,
        };
        const msg = { topic, event: 'postgres_changes', payload: { ids: matched.map((b) => b.id), data }, ref: null, join_ref: null };
        out.push(() => this.send(ws, msg));
      }
    }
    return out;
  }
}
