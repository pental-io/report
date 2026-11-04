// SAYING THAT A COPY OF PENTAL REPORT IS RUNNING, ONCE A DAY.
//
// [stated] Arian: "is there a way to see how many people are using the
// reporting tool besides github like how many did the one click install";
// asked what to count, "Installs and active copies".
//
// Pental counts how many copies of Pental Report run, on what, and at which
// version, so it knows the tool is used and which releases and systems still
// matter. Two minutes after it starts and twice a day after that, this server
// tells pental.io it is running, which pental.io counts once a day. What it
// sends is all there is:
//
//   {"event":"checkin","id":"<this copy's random ID>","version":"0.1.21",
//    "os":"linux","arch":"x64"}
//
// The ID is random, made when the copy was installed (INSTALL_ID in .env, from
// the installer) or else the first time this server ran (pental.meta). The
// system is what the installer said of the computer (REPORT_HOST), and the
// processor is this server's own. Nothing about the firm, its people, its
// clients or its reports is sent, and pental.io keeps no address.
//
// TELEMETRY=off in .env stops it. So does UPDATE_CHECK=off, which stops
// everything this server asks of the internet by itself. A failed check-in is
// not retried and is never shown: a copy with no internet is not a problem.
//
// SPDX-License-Identifier: AGPL-3.0-only
import crypto from 'node:crypto';
import { log } from './log.js';

export const CHECKIN_URL = 'https://pental.io/api/report/ping';
const FIRST_MS = 2 * 60 * 1000;
const EVERY_MS = 12 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;

export const archOf = (a = process.arch) => (a === 'x64' || a === 'arm64' ? a : 'other');

export class Usage {
  constructor({ cfg, db, version, fetchImpl, arch }) {
    this.cfg = cfg; this.db = db; this.version = version;
    this.fetch = fetchImpl || ((...a) => fetch(...a));
    this.arch = archOf(arch);
    this.timers = [];
    this.installId = null;
  }

  on() { return !!(this.cfg.telemetry && this.cfg.updateCheck); }

  // INSTALL_ID from .env, or one this server made and kept.
  async id() {
    if (this.installId) return this.installId;
    if (UUID.test(this.cfg.installId || '')) return (this.installId = this.cfg.installId);
    try {
      const r = await this.db.query("SELECT value FROM pental.meta WHERE key = 'install_id'");
      const v = r.rows[0] ? String(r.rows[0].value) : '';
      if (UUID.test(v)) return (this.installId = v);
      const made = crypto.randomUUID();
      await this.db.query("INSERT INTO pental.meta (key, value, updated_at) VALUES ('install_id', $1, now()) ON CONFLICT (key) DO NOTHING", [made]);
      const again = await this.db.query("SELECT value FROM pental.meta WHERE key = 'install_id'");
      const kept = again.rows[0] ? String(again.rows[0].value) : '';
      return (this.installId = UUID.test(kept) ? kept : made);
    } catch {
      return null;
    }
  }

  // What is sent, and nothing else.
  async body() {
    const id = await this.id();
    if (!id) return null;
    return {
      event: 'checkin',
      id,
      version: VERSION.test(String(this.version || '')) ? this.version : null,
      os: /^(linux|macos|windows)$/.test(this.cfg.reportHost || '') ? this.cfg.reportHost : null,
      arch: this.arch,
    };
  }

  start() {
    if (!this.on()) return;
    const first = setTimeout(() => { this.checkIn().catch(() => {}); }, this.cfg.telemetryFirstMs ?? FIRST_MS);
    const every = setInterval(() => { this.checkIn().catch(() => {}); }, EVERY_MS);
    first.unref(); every.unref();
    this.timers.push(first, every);
  }
  stop() { for (const t of this.timers) { clearTimeout(t); clearInterval(t); } this.timers = []; }

  async checkIn() {
    if (!this.on()) return false;
    const body = await this.body();
    if (!body) return false;
    try {
      const r = await this.fetch(this.cfg.telemetryUrl || CHECKIN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'pental-report/' + (body.version || 'unknown') },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
      return !!(r && r.ok);
    } catch (e) {
      log.debug('check-in not sent', { error: e.message });
      return false;
    }
  }
}
