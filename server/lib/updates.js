// KNOWING THERE IS A NEWER PENTAL REPORT, AND UPDATING TO IT.
//
// [stated] Arian: "also there should be a way to let them know an update is
// available, automatically update, or if it has to be manual make it as
// seamless as possible".
//
// This server asks GitHub for the latest release of pental-io/report a minute
// after it starts and twice a day after that. The request carries nothing but
// this server's version (GitHub asks every caller for a User-Agent), and
// UPDATE_CHECK=off in .env stops it. An administrator sees a newer release in
// the app, with what it changes.
//
// The app cannot replace itself: it runs in a container, and only the computer
// running Docker can swap the container for a newer one. So the installer sets
// up a small updater on that computer (update.sh: a systemd timer on Linux, a
// launchd agent on macOS) that asks this server every minute whether to update,
// over the computer's own connection to it, with a token only the two of them
// hold (UPDATE_TOKEN in .env). The answer is the version to install when an
// administrator has pressed Update now, or overnight when updates are
// automatic; the updater then installs it the way the install command does,
// from the release's own tag on GitHub, after a copy of the database, and puts
// the version before it back if the new one does not start.
//
// Where there is no updater (Windows, or a server set up by hand), the app gives
// the one command that updates it.
//
// What is kept, in pental.meta (the server's own table, never served):
//   update_latest   the newest release GitHub named, and when it was asked
//   update_auto     '0' when an administrator turned automatic updates off
//   update_request  an administrator's Update now, until the updater takes it
//   update_agent    when the updater last asked, and on what
//   update_run      the last update: running, done or failed, and from what
//
// SPDX-License-Identifier: AGPL-3.0-only
import crypto from 'node:crypto';
import { HttpError, readBody, readJson, sendJson } from './http.js';
import { log } from './log.js';

export const RELEASES_URL = 'https://api.github.com/repos/pental-io/report/releases/latest';
const DAY_CHECKS_MS = 12 * 60 * 60 * 1000;
const FIRST_CHECK_MS = 60 * 1000;
// The updater asks every minute; a few missed and it is taken as gone (a
// computer asleep, or the updater removed).
const AGENT_LIVE_MS = 5 * 60 * 1000;
// An update that said it started and never said how it ended.
const RUN_STALE_MS = 60 * 60 * 1000;
// Overnight, on the clock of the computer the updater runs on.
const NIGHT_FROM = 1, NIGHT_TO = 6;

const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
export function newer(a, b) {
  const pa = String(a || '').split('.').map(Number), pb = String(b || '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
}

function sameSecret(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export class Updates {
  constructor({ cfg, db, api, version, fetchImpl }) {
    this.cfg = cfg; this.db = db; this.api = api; this.version = version;
    this.fetch = fetchImpl || ((...a) => fetch(...a));
    this.state = { latest: null, auto: true, request: null, agent: null, run: null };
    this.timers = [];
    this.lastCheckAsked = 0;
  }

  async meta(key) {
    try {
      const r = await this.db.query('SELECT value FROM pental.meta WHERE key = $1', [key]);
      return r.rows[0] ? r.rows[0].value : null;
    } catch { return null; }
  }
  async setMeta(key, value) {
    if (value === null) { await this.db.query('DELETE FROM pental.meta WHERE key = $1', [key]); return; }
    await this.db.query('INSERT INTO pental.meta (key, value, updated_at) VALUES ($1, $2, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()',
      [key, typeof value === 'string' ? value : JSON.stringify(value)]);
  }
  async load() {
    const json = async (k) => { try { const v = await this.meta(k); return v ? JSON.parse(v) : null; } catch { return null; } };
    this.state.latest = await json('update_latest');
    this.state.auto = (await this.meta('update_auto')) !== '0';
    this.state.request = await json('update_request');
    this.state.agent = await json('update_agent');
    this.state.run = await json('update_run');
    // Running this release is the end of any update to it.
    const run = this.state.run;
    if (run && run.state === 'running' && run.version === this.version) {
      this.state.run = { ...run, state: 'done', at: new Date().toISOString() };
      await this.setMeta('update_run', this.state.run).catch(() => {});
    }
    if (this.state.request && !newer(this.state.request.version, this.version)) {
      this.state.request = null;
      await this.setMeta('update_request', null).catch(() => {});
    }
  }

  async start() {
    await this.load();
    if (!this.cfg.updateCheck) return;
    const first = setTimeout(() => { this.check().catch(() => {}); }, this.cfg.updateFirstCheckMs ?? FIRST_CHECK_MS);
    const every = setInterval(() => { this.check().catch(() => {}); }, DAY_CHECKS_MS);
    first.unref(); every.unref();
    this.timers.push(first, every);
  }
  stop() { for (const t of this.timers) { clearTimeout(t); clearInterval(t); } this.timers = []; }

  // GitHub's latest release: published, not a draft or a pre-release.
  async check() {
    if (!this.cfg.updateCheck) return this.state.latest;
    try {
      const r = await this.fetch(this.cfg.updateUrl || RELEASES_URL, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'pental-report/' + this.version, 'X-GitHub-Api-Version': '2022-11-28' },
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) { log.debug('update check: no answer', { status: r.status }); return this.state.latest; }
      const j = await r.json();
      const v = String(j && j.tag_name || '').replace(/^v/, '');
      if (!VERSION.test(v) || j.draft || j.prerelease) return this.state.latest;
      this.state.latest = {
        version: v, name: String(j.name || v).slice(0, 200),
        url: /^https:\/\/github\.com\//.test(String(j.html_url || '')) ? j.html_url : 'https://github.com/pental-io/report/releases/tag/v' + v,
        notes: String(j.body || '').slice(0, 20000), published_at: j.published_at || null, checked_at: new Date().toISOString(),
      };
      await this.setMeta('update_latest', this.state.latest);
      if (newer(v, this.version)) log.info('a newer Pental Report is out', { version: v, running: this.version });
    } catch (e) {
      log.debug('update check failed', { error: e.message });
    }
    return this.state.latest;
  }

  agentLive() {
    const a = this.state.agent;
    return !!(a && a.seen_at && Date.now() - Date.parse(a.seen_at) < AGENT_LIVE_MS);
  }
  runState() {
    const run = this.state.run;
    if (run && run.state === 'running' && Date.now() - Date.parse(run.at) > RUN_STALE_MS) {
      return { ...run, state: 'failed', message: 'It did not say it had finished, so it is taken as not done. The updater writes what happened to update.log, in the folder Pental Report lives in.' };
    }
    return run;
  }

  // What the updater should do now: a version to install, or nothing.
  decide(hour) {
    const latest = this.state.latest;
    if (!latest || !newer(latest.version, this.version)) return null;
    const run = this.runState();
    if (run && run.state === 'running') return null;
    if (this.state.request) return latest.version;
    if (this.state.auto && Number.isInteger(hour) && hour >= NIGHT_FROM && hour < NIGHT_TO) {
      // Not again by itself a version that did not start here: Update now can.
      if (run && run.state === 'failed' && run.version === latest.version) return null;
      return latest.version;
    }
    return null;
  }

  status() {
    const latest = this.state.latest;
    return {
      current: this.version,
      checks: !!this.cfg.updateCheck,
      latest,
      newer: !!(latest && newer(latest.version, this.version)),
      auto: this.state.auto,
      updater: this.agentLive() ? { os: this.state.agent.os || '', seen_at: this.state.agent.seen_at } : null,
      updaterSeen: this.state.agent ? this.state.agent.seen_at : null,
      request: this.state.request,
      run: this.runState(),
      host: this.cfg.reportHost || '',
      dir: this.cfg.reportDir || '',
      root: !!this.cfg.reportRoot,
    };
  }

  // ── The app: an administrator ───────────────────────────────────────────
  async admin(req) {
    const c = this.api.caller(req);
    const me = await this.api.me(c);
    if (me.role !== 'admin') throw new HttpError(403, { error: 'Only an administrator can see or start updates.' });
    return me;
  }

  async appGet(req, res) {
    await this.admin(req);
    sendJson(res, 200, this.status(), { 'Cache-Control': 'no-store' });
  }

  async appPost(req, res) {
    const me = await this.admin(req);
    const b = (await readJson(req).catch(() => null)) || {};
    if (b.action === 'check') {
      if (!this.cfg.updateCheck) return sendJson(res, 409, { error: 'Update checks are off on this server (UPDATE_CHECK in .env).', ...this.status() });
      // Once a minute at most, however often it is pressed.
      if (Date.now() - this.lastCheckAsked > 60 * 1000) { this.lastCheckAsked = Date.now(); await this.check(); }
      return sendJson(res, 200, this.status());
    }
    if (b.action === 'auto') {
      this.state.auto = b.on !== false;
      await this.setMeta('update_auto', this.state.auto ? '1' : '0');
      log.info('automatic updates ' + (this.state.auto ? 'on' : 'off'), { by: me.email });
      return sendJson(res, 200, this.status());
    }
    if (b.action === 'now') {
      const latest = this.state.latest;
      if (!latest || !newer(latest.version, this.version)) return sendJson(res, 409, { error: 'This server already runs the latest release.', ...this.status() });
      if (!this.agentLive()) return sendJson(res, 409, { error: 'This server has no updater running, so it cannot update itself. Run the install command on it instead.', ...this.status() });
      this.state.request = { version: latest.version, at: new Date().toISOString(), by: me.name || me.email || '' };
      await this.setMeta('update_request', this.state.request);
      log.info('update asked for', { version: latest.version, by: me.email });
      return sendJson(res, 200, this.status());
    }
    if (b.action === 'cancel') {
      this.state.request = null;
      await this.setMeta('update_request', null);
      return sendJson(res, 200, this.status());
    }
    sendJson(res, 400, { error: 'Unknown action' });
  }

  // ── The updater, on the computer this runs on ───────────────────────────
  // Answered only to a request that comes straight to this server (no proxy
  // in front of it: Caddy and Tailscale's both say who they passed it on
  // for) with the updater's token. Anything else is told there is nothing
  // here, as for any other address the server does not have.
  agentOk(req) {
    const token = this.cfg.updateToken;
    if (!token) return false;
    if (req.headers['x-forwarded-for'] || req.headers.forwarded || req.headers['x-real-ip']) return false;
    const given = String(req.headers['x-updater-token'] || '');
    return !!given && sameSecret(given, token);
  }

  async agentGet(req, res, url) {
    if (!this.agentOk(req)) return sendJson(res, 404, { error: 'Not found' });
    const hour = parseInt(url.searchParams.get('hour'), 10);
    const osName = String(url.searchParams.get('os') || '').toLowerCase();
    this.state.agent = { seen_at: new Date().toISOString(), os: osName === 'darwin' ? 'macos' : osName === 'linux' ? 'linux' : osName.slice(0, 20) };
    await this.setMeta('update_agent', this.state.agent).catch(() => {});
    const v = this.decide(Number.isFinite(hour) ? hour : NaN);
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(v ? 'update ' + v + '\n' : '');
  }

  async agentPost(req, res) {
    if (!this.agentOk(req)) return sendJson(res, 404, { error: 'Not found' });
    const raw = (await readBody(req, { limit: 16 * 1024 })).toString('utf8');
    const f = Object.fromEntries(new URLSearchParams(raw));
    const event = String(f.event || '');
    const version = VERSION.test(String(f.version || '')) ? f.version : '';
    const from = VERSION.test(String(f.from || '')) ? f.from : '';
    const message = String(f.message || '').replace(/[^\x20-\x7E]/g, ' ').slice(0, 400);
    if (!['started', 'done', 'failed'].includes(event) || !version) return sendJson(res, 400, { error: 'event and version are needed' });
    const at = new Date().toISOString();
    if (event === 'started') this.state.run = { state: 'running', version, from, at };
    else this.state.run = { state: event, version, from, at, ...(message ? { message } : {}) };
    await this.setMeta('update_run', this.state.run);
    if (event !== 'started') { this.state.request = null; await this.setMeta('update_request', null); }
    log.info('update ' + event, { version, from, message: message || undefined });
    res.writeHead(204); res.end();
  }
}
