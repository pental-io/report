#!/usr/bin/env node
// PENTAL REPORTER'S SERVER.
//
// One process beside a PostgreSQL, serving the app and the five things it
// needs from a server:
//
//   /rest/v1      tables and functions, under the schema's row policies
//   /auth/v1      sign-in tokens and sessions
//   /storage/v1   files (evidence, templates, reports), under the same policies
//   /realtime/v1  live changes and who else is looking, over a websocket
//   /api/*        the few server routes the app calls (lib/api.js)
//
// and the AI requests the database hands it (lib/ai.js), so a prompt and the
// AI key go from this server to the provider the firm chose, and nowhere else.
// This is the Pental gateway, which runs Pental's portal on a firm's own
// database, with only the parts reporting needs.
//
// SPDX-License-Identifier: AGPL-3.0-only
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './lib/config.js';
import { log, setLogLevel } from './lib/log.js';
import { Db, prepareSslCa } from './lib/db.js';
import { bootstrap } from './lib/bootstrap.js';
import { Authz } from './lib/authz.js';
import { SchemaCache } from './lib/rest/schema.js';
import { Rest, statusForPgError, pgErrorBody } from './lib/rest/index.js';
import { Auth } from './lib/auth/index.js';
import { Storage } from './lib/storage/index.js';
import { Realtime } from './lib/realtime/index.js';
import { AiWorker } from './lib/ai.js';
import { ensureSchema, ensureInstance } from './lib/setup.js';
import { Api } from './lib/api.js';
import { Web } from './lib/web.js';
import { Router, applyCors, sendJson, handleError, HttpError } from './lib/http.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPORTER_VERSION = JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8')).version;

export async function createServer(env = process.env, { listen = true } = {}) {
  const { cfg, problems } = loadConfig(env);
  setLogLevel(cfg.logLevel);
  if (problems.length) {
    for (const p of problems) log.error('configuration', { problem: p });
    throw new Error('Pental Report cannot start: ' + problems.join('; '));
  }
  cfg.version = REPORTER_VERSION;
  const db = new Db(cfg, await prepareSslCa(env));
  // A database just started beside us may need a moment.
  for (let i = 0; ; i++) {
    try { await db.query('SELECT 1'); break; } catch (e) {
      if (i >= 60) throw e;
      if (i === 0) log.info('waiting for the database', { error: e.message });
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  await bootstrap(db);
  const applied = await ensureSchema(db, cfg.dbDir);
  const instance = await ensureInstance(db);
  log.info('database ready', { schema: applied.version, applied: applied.applied, version: REPORTER_VERSION });

  const schema = new SchemaCache(db);
  await schema.load();
  await schema.listen();
  const authz = new Authz(cfg);
  const rest = new Rest({ db, schema, authz, attest: null, cfg });
  const auth = new Auth({ db, cfg, authz });
  const storage = new Storage({ db, cfg, authz, schema });
  const realtime = new Realtime({ db, cfg, authz, schema });
  await realtime.start();
  const ai = new AiWorker({ db });
  await ai.start();
  const api = new Api({ cfg, db, authz, instance, version: REPORTER_VERSION });
  const web = new Web({ cfg });
  if (!web.ready()) log.warn('the app is not built yet', { webDir: cfg.webDir });

  const router = new Router()
    .add('*', '/rest/v1', (req, res, url) => rest.handle(req, res, url, {}))
    .add('*', '/rest/v1/', (req, res, url) => rest.handle(req, res, url, {}))
    .add('*', '/rest/v1/rpc/:fn', (req, res, url, p) => rest.handle(req, res, url, p))
    .add('*', '/rest/v1/:table', (req, res, url, p) => rest.handle(req, res, url, p))
    .add('*', '/auth/v1/*rest', (req, res, url, p) => auth.handle(req, res, url, p.rest))
    .add('*', '/storage/v1/*rest', (req, res, url, p) => storage.handle(req, res, url, p.rest))
    .add('GET', '/reporter/v1/config', (req, res) => api.config(req, res))
    .add('POST', '/reporter/v1/first-admin', (req, res) => api.firstAdmin(req, res))
    .add('*', '/api/admin', (req, res) => api.admin(req, res))
    .add('*', '/api/utils', (req, res, url) => api.utils(req, res, url))
    .add('GET', '/health', async (req, res) => {
      let ok = true;
      try { await db.query('SELECT 1'); } catch { ok = false; }
      sendJson(res, ok ? 200 : 503, { ok, service: 'pental-report', version: REPORTER_VERSION }, { 'Cache-Control': 'no-store' });
    });

  const server = http.createServer(async (req, res) => {
    let url, found, shape = 'rest';
    try {
      url = new URL(req.url, 'http://reporter');
      const api_ = /^\/(rest|auth|storage|realtime)\/v1(\/|$)/.test(url.pathname);
      if (api_) applyCors(res);
      if (req.method === 'OPTIONS' && api_) { res.writeHead(204); res.end(); return; }
      shape = url.pathname.startsWith('/auth/') ? 'auth' : url.pathname.startsWith('/storage/') ? 'storage' : 'rest';
      found = router.find(req.method.toUpperCase(), url.pathname);
    } catch (e) {
      if (e instanceof HttpError) { handleError(res, e, shape); return; }
      sendJson(res, 400, { code: 'PGRST100', message: 'The address is not valid', details: null, hint: null });
      return;
    }
    if (!found) {
      // Pental's other server routes are not part of Pental Report.
      if (/^\/api\//.test(url.pathname)) { sendJson(res, 404, { error: 'Not part of Pental Report' }); return; }
      if (web.serve(req, res, url)) return;
      sendJson(res, 404, shape === 'rest' ? { code: 'PGRST404', message: 'Not found', details: null, hint: null } : { error: 'not_found', message: 'Not found' });
      return;
    }
    try {
      await found.handler(req, res, url, found.params);
    } catch (e) {
      if (res.headersSent) { res.end(); return; }
      if (e && typeof e.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code) && !(e instanceof HttpError)) {
        sendJson(res, statusForPgError(e.code, e.pentalRole || 'anon'), pgErrorBody(e));
        return;
      }
      handleError(res, e, shape);
    }
  });
  server.on('upgrade', (req, socket, head) => realtime.upgrade(req, socket, head));
  server.keepAliveTimeout = 65000;

  const out = { cfg, db, schema, authz, rest, auth, storage, realtime, ai, api, web, server, instance };
  if (listen) {
    await new Promise((resolve) => server.listen(cfg.port, cfg.host, resolve));
    log.info('listening', { port: cfg.port, host: cfg.host, publicUrl: cfg.publicUrl || '(the address each request arrives at)' });
  }
  out.close = async () => {
    await Promise.allSettled([ai.stop()]);
    await realtime.stop();
    storage.stop();
    await schema.stop();
    await new Promise((r) => { server.close(r); if (server.closeAllConnections) server.closeAllConnections(); });
    await db.close();
  };
  return out;
}

const isMain = process.argv[1] && new URL(import.meta.url).pathname === process.argv[1];
if (isMain) {
  let running = null;
  process.on('unhandledRejection', (e) => {
    log.error('unhandled rejection', { error: e && e.message ? e.message : String(e), stack: e && e.stack ? String(e.stack).split('\n').slice(0, 4).join(' | ') : '' });
  });
  createServer().then((s) => { running = s; }).catch((e) => { log.error('fatal', { error: e.message }); process.exit(1); });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    setTimeout(() => process.exit(0), 9000).unref();
    Promise.allSettled([running ? running.close() : null]).then(() => process.exit(0));
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
