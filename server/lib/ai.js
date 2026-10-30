// 1.4.0: THE FIRM'S AI REQUESTS, SENT FROM THE FIRM'S OWN SERVER.
//
// [stated] Arian, on taking client data off Pental's servers: "if pental were
// breached, their data shouldnt be readable. pental employees shouldnt be able
// to read their data", with no extra steps for firms.
//
// The portal asked Pental's relay for every request to a hosted model, and the
// prompt (finding and report text) and the firm's key passed through it. Now
// the portal hands the firm's database the request (rpc_ai_submit), shaped as
// the relay shaped it. On Supabase the database sends it itself, with pg_net.
// A plain Postgres has no way out of its own, so behind a gateway the gateway
// sends it: it takes each waiting request from the database (_ai_claim, which
// adds the firm's key as it hands it over and never keeps it), asks the
// provider, and puts the answer back (_ai_complete) for the person who asked.
//
// Nothing here chooses an address: the database does, from the provider the
// firm saved (Anthropic, OpenAI, Groq) or its own endpoint, which may well be
// on the firm's network, beside this gateway.
//
// The database learns that this worker is here from pental.meta (a key of its
// own, 'ai_worker:<instance>', said every fifteen seconds and taken away when
// it stops), and the portal asks Pental's relay instead while no worker is.
//
// The database refuses an endpoint written as a link-local address (where a
// cloud keeps its instance metadata); a name is resolved here, as each
// connection is made, and a link-local answer is not connected to either. A
// private address is the firm's own network, which a firm's endpoint beside its
// gateway may well be.
import crypto from 'node:crypto';
import dns from 'node:dns';
import net from 'node:net';
import { log } from './log.js';
import { readCapped } from './http.js';
import { GATEWAY_VERSION } from './bootstrap.js';

const CHANNEL = 'pental_ai';
// As many at once as the database hands over in one go.
const MAX_AT_ONCE = 16;
const SWEEP_MS = 5000;
const BEAT_MS = 15000;
const MAX_ANSWER = 8 * 1024 * 1024;

const NEVER = new net.BlockList();
NEVER.addSubnet('169.254.0.0', 16, 'ipv4');
NEVER.addSubnet('0.0.0.0', 8, 'ipv4');
NEVER.addAddress('100.100.100.200', 'ipv4');
NEVER.addSubnet('fe80::', 10, 'ipv6');
NEVER.addAddress('::', 'ipv6');
NEVER.addAddress('fd00:ec2::254', 'ipv6');
NEVER.addAddress('fd20:ce::254', 'ipv6');
NEVER.addSubnet('::a9fe:0', 112, 'ipv6');
NEVER.addSubnet('64:ff9b::a9fe:0', 112, 'ipv6');
NEVER.addSubnet('2002:a9fe::', 32, 'ipv6');

// An address an AI request is never sent to: link-local (where clouds keep
// instance metadata), the metadata services that live elsewhere, and "this"
// network. An IPv4 address written as IPv6 is judged as IPv4.
export function neverConnected(address) {
  const fam = net.isIP(String(address || ''));
  if (!fam) return true;
  return NEVER.check(String(address), fam === 6 ? 'ipv6' : 'ipv4');
}

// The lookup each connection makes: the name's addresses but those, or
// ELINKLOCAL.
export function guardedLookup(hostname, options, cb) {
  if (typeof options === 'function') { cb = options; options = {}; }
  dns.lookup(hostname, { family: (options && options.family) || 0, all: true, verbatim: true }, (err, addrs) => {
    if (err) return cb(err);
    const good = (addrs || []).filter((a) => !neverConnected(a.address));
    if (!good.length) return cb(Object.assign(new Error('the endpoint resolves only to a link-local address'), { code: 'ELINKLOCAL' }));
    if (options && options.all) return cb(null, good);
    cb(null, good[0].address, good[0].family);
  });
}

// A dispatcher for Node's fetch whose every connection makes that lookup: an
// Agent of the class Node's own fetch is built on (as the portal's relay pins
// its connections, api/_public-net.js), or null where there is none to be had.
// 1.5.0: one per lookup (the ticket worker's refuses more, lib/tickets.js).
const _nativeFetch = typeof globalThis.fetch === 'function' ? globalThis.fetch : null;
const _dispatchers = new Map();
export function dispatcherWith(name, lookup) {
  if (!_dispatchers.has(name)) {
    _dispatchers.set(name, (async () => {
      const slot = Symbol.for('undici.globalDispatcher.1');
      if (!globalThis[slot] && _nativeFetch) {
        try { const r = await _nativeFetch('data:,'); if (r && typeof r.arrayBuffer === 'function') await r.arrayBuffer(); } catch { /* nothing to set up */ }
      }
      const Agent = globalThis[slot] && globalThis[slot].constructor;
      if (typeof Agent !== 'function') return null;
      try { return new Agent({ connect: { lookup } }); } catch { return null; }
    })());
  }
  return _dispatchers.get(name);
}
export function guardedDispatcher() {
  return dispatcherWith('ai', guardedLookup);
}

// What went wrong, in words of the gateway's own: a fetch's own message can
// carry a header's value (a key, a firm's own header), and the person who
// asked is shown this.
function failure(e) {
  const code = String((e && e.cause && e.cause.code) || (e && e.code) || '');
  if (code === 'ELINKLOCAL') return 'the endpoint is a link-local address, which is not connected to';
  if (code === 'ENOGUARD') return 'this gateway cannot check where the endpoint\'s name points, so it does not call it (update the gateway)';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'the endpoint\'s name could not be resolved (' + code + ')';
  if (/^(ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|EPIPE)$/.test(code)) return 'could not reach the endpoint (' + code + ')';
  if (/^(UND_ERR_|ERR_TLS|CERT_|UNABLE_TO|DEPTH_ZERO|SELF_SIGNED|ERR_SSL)/.test(code)) return 'the connection to the endpoint failed (' + code + ')';
  if (e && e.name === 'TypeError' && /redirect/i.test(String(e.message || '') + String((e.cause && e.cause.message) || ''))) return 'the endpoint answered with a redirect, which is not followed';
  return code ? 'could not reach the endpoint (' + code.replace(/[^A-Z0-9_]/gi, '').slice(0, 40) + ')' : 'could not reach the endpoint';
}

export class AiWorker {
  constructor({ db, fetchImpl } = {}) {
    this.db = db;
    this.fetch = fetchImpl || ((...a) => fetch(...a));
    this.ownFetch = !fetchImpl;
    this.key = 'ai_worker:' + crypto.randomBytes(6).toString('hex');
    this.active = 0;
    this.stopped = false;
    this.ready = false;
    this.inflight = new Map();
    this._listener = null;
    this._sweep = null;
    this._beat = null;
    this._draining = false;
    this._again = false;
    this.dispatcher = null;
    // Whether the last attempt to take requests failed: a worker that cannot
    // take them does not say it is there, so the portal asks the relay.
    this.claimFailing = false;
  }

  // Whether the database has the functions this needs (a schema from
  // 2025100306 on); a gateway on an older schema waits for its update.
  async supported() {
    try {
      const r = await this.db.query("SELECT to_regprocedure('public._ai_claim(integer,text)') IS NOT NULL AND to_regprocedure('public._ai_complete(uuid,integer,text,text,text,boolean)') IS NOT NULL AS ok");
      return !!(r.rows[0] && r.rows[0].ok);
    } catch { return false; }
  }

  async start() {
    this.ready = await this.supported();
    if (!this.ready) log.info('AI requests are not sent from here yet: the database has not been updated to a schema that hands them over');
    this.dispatcher = await guardedDispatcher();
    try {
      // 1.10.0: on the gateway's one listening connection (db.js, Listener),
      // and drained again once it is made again after a loss.
      this._listener = await this.db.listener.listen(CHANNEL, () => this.drain(), () => this.drain());
    } catch (e) {
      log.warn('could not LISTEN ' + CHANNEL + '; AI requests are picked up every few seconds instead', { error: e.message });
    }
    await this.beat();
    this._sweep = setInterval(() => { this.tick(); }, SWEEP_MS);
    this._beat = setInterval(() => { this.beat(); }, BEAT_MS);
    if (this._sweep.unref) this._sweep.unref();
    if (this._beat.unref) this._beat.unref();
    this.drain();
  }

  // Every few seconds: what is waiting, and, until the database has the
  // functions this needs (set up or updated since this started), whether it
  // has them now, said at once so the portal stops asking the relay.
  async tick() {
    if (this.stopped) return;
    if (!this.ready) {
      this.ready = await this.supported();
      if (!this.ready) return;
      await this.beat();
    }
    this.drain();
  }

  // Say this worker is here, so the database hands requests over; and take
  // away what a worker that stopped without saying so left behind.
  async beat() {
    if (!this.ready) this.ready = await this.supported();
    if (!this.ready || this.stopped || this.claimFailing) return;
    try {
      await this.db.query('INSERT INTO pental.meta (key, value, updated_at) VALUES ($1, $2, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()', [this.key, GATEWAY_VERSION]);
      await this.db.query("DELETE FROM pental.meta WHERE key LIKE 'ai\\_worker%' AND updated_at < now() - interval '1 hour'");
    } catch (e) { log.warn('AI worker heartbeat failed', { error: e.message }); }
  }

  // Take what is waiting, up to sixteen at a time.
  async drain() {
    if (this.stopped || !this.ready) return;
    if (this._draining) { this._again = true; return; }
    this._draining = true;
    try {
      do {
        this._again = false;
        const room = MAX_AT_ONCE - this.active;
        if (room <= 0) break;
        let rows = [];
        try {
          rows = (await this.db.query('SELECT * FROM public._ai_claim($1, $2)', [room, this.key])).rows;
          this.claimFailing = false;
        } catch (e) {
          // A database emptied or set up again (Start fresh): asked again at
          // the next sweep.
          if (e && e.code === '42883') this.ready = false;
          else { this.claimFailing = true; log.warn('could not take AI requests', { error: e.message }); }
          break;
        }
        // Taken as this worker was stopping: said to whoever asked, not sent.
        if (this.stopped) {
          for (const row of rows) {
            try { await this.db.query('SELECT public._ai_complete($1, NULL, NULL, NULL, $2, false)', [row.r_id, 'the gateway stopped while sending it']); } catch { /* the database says so when it sees the worker gone */ }
          }
          break;
        }
        for (const row of rows) {
          this.active++;
          const p = this.send(row).finally(() => { this.active--; this.inflight.delete(row.r_id); if (!this.stopped) this.drain(); });
          const entry = this.inflight.get(row.r_id);
          if (entry) entry.done = p;
        }
        if (rows.length === room) this._again = true;
      } while (this._again && !this.stopped);
    } finally {
      this._draining = false;
    }
  }

  async send(row) {
    let status = null;
    let content = null;
    let retryAfter = null;
    let error = null;
    let timedOut = false;
    const started = Date.now();
    const limit = Math.max(1000, row.r_timeout_ms || 280000);
    const ctrl = new AbortController();
    let expired = false;
    const timer = setTimeout(() => { expired = true; ctrl.abort(); }, limit);
    this.inflight.set(row.r_id, { ctrl });
    try {
      let host = '';
      try { host = new URL(row.r_url).hostname.replace(/^\[|\]$/g, ''); } catch { host = ''; }
      if (!host || (net.isIP(host) && neverConnected(host))) throw Object.assign(new Error('refused'), { cause: { code: 'ELINKLOCAL' } });
      // 1.10.0: closed where the name cannot be checked. Without the pinned
      // dispatcher a name is resolved by fetch itself, which would connect to
      // a link-local address (a cloud's metadata service) as readily as any.
      if (!this.dispatcher && this.ownFetch && !net.isIP(host)) throw Object.assign(new Error('refused'), { cause: { code: 'ENOGUARD' } });
      const init = { method: row.r_method === 'GET' ? 'GET' : 'POST', headers: row.r_headers || {}, redirect: 'error', signal: ctrl.signal };
      if (init.method === 'POST') init.body = JSON.stringify(row.r_body == null ? {} : row.r_body);
      if (this.dispatcher) init.dispatcher = this.dispatcher;
      const res = await this.fetch(row.r_url, init);
      status = res.status;
      retryAfter = res.headers && typeof res.headers.get === 'function' ? res.headers.get('retry-after') : null;
      content = await readCapped(res, MAX_ANSWER);   // 1.10.0: no further than the cap
    } catch (e) {
      status = null;
      content = null;
      if (this.stopped && !expired) error = 'the gateway stopped while sending it';
      else if (expired || (e && (e.name === 'TimeoutError' || e.name === 'AbortError'))) { timedOut = true; error = 'no answer within ' + Math.round(limit / 1000) + 's'; }
      else error = failure(e);
    } finally {
      clearTimeout(timer);
    }
    // The address and the key are never logged; the time and the outcome are.
    log.debug('AI request sent', { status, ms: Date.now() - started, timed_out: timedOut });
    try {
      await this.db.query('SELECT public._ai_complete($1, $2, $3, $4, $5, $6)', [row.r_id, status, content, retryAfter, error, timedOut]);
    } catch (e) {
      log.warn('could not put an AI answer back', { error: e.message });
    }
  }

  // Stop taking requests; end what is being sent, said to whoever asked, so
  // nobody waits on an answer that will not come; and say this worker has
  // gone, so the portal asks the relay at once.
  async stop() {
    const wasReady = this.ready && !this.stopped;
    this.stopped = true;
    if (this._sweep) clearInterval(this._sweep);
    if (this._beat) clearInterval(this._beat);
    const sending = [...this.inflight.values()];
    for (const s of sending) { try { s.ctrl.abort(); } catch { /* done already */ } }
    if (sending.length) {
      await Promise.race([Promise.allSettled(sending.map((s) => s.done).filter(Boolean)), new Promise((r) => setTimeout(r, 3000))]);
    }
    // A take in progress finishes (and says what it took was not sent).
    for (let i = 0; this._draining && i < 60; i++) await new Promise((r) => setTimeout(r, 50));
    if (wasReady) {
      try { await this.db.query('DELETE FROM pental.meta WHERE key = $1', [this.key]); } catch { /* it runs out in 45 seconds */ }
    }
    const l = this._listener;
    this._listener = null;
    if (l) l();
  }
}
