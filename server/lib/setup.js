// WHAT THE SERVER DOES TO ITS DATABASE BEFORE IT SERVES.
//
// 1. The foundations (sql/bootstrap.sql: sign-in tables, files, the vault,
//    live changes), as the Pental gateway lays them.
// 2. The reporting schema (db/schema.sql, Pental's own tenant schema, and
//    db/overlay.sql, what is different here), applied when this server
//    carries a newer one than the database has, in one transaction.
// 3. Once, on a new database: the instance's identity and its own signing
//    keys. Pental's schema accepts operations signed by two Ed25519 keys; on
//    Pental those are Pental's. Here they are made by this server and kept
//    sealed in this database's vault, so the only party that can sign for
//    this database is this server, and nobody at Pental can.
// 4. The first administrator, made from the first-run page with the setup
//    token, and nobody else while there is none.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { runSql, bootstrap, schemaVersion } from './bootstrap.js';
import { hasTransactionControl } from './sqlscan.js';
import { log } from './log.js';

export const SCHEMA_KEY = 'reporter_schema';
const VERSION_RE = /INSERT\s+INTO\s+public\._pental_schema_version[\s\S]{0,120}?VALUES\s*\(\s*1\s*,\s*(\d+)/i;
const OVERLAY_RE = /^--\s*reporter-overlay:\s*(\d+)/m;

export function bundledSchema(dbDir) {
  const schemaPath = path.join(dbDir, 'schema.sql');
  const overlayPath = path.join(dbDir, 'overlay.sql');
  const schema = fs.readFileSync(schemaPath, 'utf8');
  const overlay = fs.existsSync(overlayPath) ? fs.readFileSync(overlayPath, 'utf8') : '';
  const m = VERSION_RE.exec(schema);
  const o = OVERLAY_RE.exec(overlay);
  const version = m ? parseInt(m[1], 10) : 0;
  const overlayVersion = o ? parseInt(o[1], 10) : 0;
  const sha = crypto.createHash('sha256').update(schema).update('\n--overlay--\n').update(overlay).digest('hex');
  return { schema, overlay, version, overlayVersion, id: `${version}.${overlayVersion}.${sha.slice(0, 16)}` };
}

async function meta(db, key) {
  const r = await db.query('SELECT value FROM pental.meta WHERE key = $1', [key]);
  return r.rows[0] ? r.rows[0].value : null;
}
async function setMeta(db, key, value) {
  await db.query('INSERT INTO pental.meta (key, value, updated_at) VALUES ($1, $2, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()', [key, String(value)]);
}
async function sealed(db, name) {
  const r = await db.query('SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = $1', [name]);
  return r.rows[0] ? r.rows[0].decrypted_secret : null;
}
async function seal(db, name, value, description) {
  const r = await db.query('SELECT id FROM vault.secrets WHERE name = $1', [name]);
  if (r.rows.length) await db.query('SELECT vault.update_secret($1, $2)', [r.rows[0].id, value]);
  else await db.query('SELECT vault.create_secret($1, $2, $3)', [value, name, description]);
}

// Applies the bundled schema when the database is behind it. Returns
// { applied, version, id } or throws with what PostgreSQL said.
export async function ensureSchema(db, dbDir) {
  const b = bundledSchema(dbDir);
  if (!b.version) throw new Error('db/schema.sql stamps no version; the server cannot tell what it is applying');
  const have = await meta(db, SCHEMA_KEY);
  if (have === b.id) return { applied: false, version: b.version, id: b.id };
  const current = await schemaVersion(db);
  if (current > b.version) {
    // A database a newer Pental Report set up: never taken back.
    log.warn('the database is on a newer schema than this server carries; nothing applied', { database: current, bundled: b.version });
    return { applied: false, version: current, id: have };
  }
  const sql = b.schema + '\n\n-- ─── Pental Report overlay ───\n' + b.overlay;
  if (hasTransactionControl(sql)) throw new Error('the bundled SQL opens or ends a transaction of its own');
  const t0 = Date.now();
  const client = await db.pool.connect();
  try {
    await client.query('SET statement_timeout = 0');
    await runSql(client, sql);
    await client.query('RESET statement_timeout');
  } finally {
    client.release();
  }
  await setMeta(db, 'schema_version', b.version);
  await setMeta(db, SCHEMA_KEY, b.id);
  await bootstrap(db);
  log.info('schema applied', { version: b.version, overlay: b.overlayVersion, ms: Date.now() - t0 });
  return { applied: true, version: b.version, id: b.id };
}

// ── The instance: its tenant id and its own signing keys ──────────────────
const rawPublic = (key) => key.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');

export async function ensureInstance(db) {
  let tenantId = await meta(db, 'reporter_tenant_id');
  if (!tenantId) { tenantId = crypto.randomUUID(); await setMeta(db, 'reporter_tenant_id', tenantId); }
  let provisioned = await meta(db, 'reporter_provisioned');
  if (!provisioned) {
    // A new database: Pental's own provisioning, as a firm's database is
    // provisioned, with keys only this server holds.
    const clean = (await db.query("SELECT public.rpc_bulk_clean('') AS r")).rows[0].r;
    if (!clean || !clean.install_token) throw new Error('provisioning failed: ' + JSON.stringify(clean).slice(0, 300));
    const A = crypto.generateKeyPairSync('ed25519');
    const B = crypto.generateKeyPairSync('ed25519');
    const put = (await db.query('SELECT public.rpc_install_pental_keys($1, $2, $3) AS r', [clean.install_token, rawPublic(A.publicKey), rawPublic(B.publicKey)])).rows[0].r;
    if (put && put.error) throw new Error('installing this server\'s keys failed: ' + put.error);
    const done = (await db.query('SELECT public.rpc_provisioning_complete($1) AS r', [clean.install_token])).rows[0].r;
    if (!done || done.success !== true) throw new Error('provisioning did not complete: ' + JSON.stringify(done).slice(0, 300));
    await seal(db, 'reporter_key_a', A.privateKey.export({ type: 'pkcs8', format: 'pem' }), 'Pental Report: signing key A (this server only)');
    await seal(db, 'reporter_key_b', B.privateKey.export({ type: 'pkcs8', format: 'pem' }), 'Pental Report: signing key B (this server only)');
    if (clean.provision_secret) await seal(db, 'reporter_provision_secret', clean.provision_secret, 'Pental Report: provisioning secret');
    // The one settings row, with password sign-in on (there is no emailed
    // code here unless mail is set up) and the name it starts with.
    await db.asOwner(async (c) => {
      const n = (await c.query('SELECT count(*)::int AS n FROM public.settings')).rows[0].n;
      if (!n) {
        await c.query("INSERT INTO public.settings (company_name, portal_title, login_title, password_login_enabled, sso_google_enabled, sso_microsoft_enabled) VALUES ('Your firm', 'Pental Report', 'REPORTING', true, false, false)");
      } else {
        await c.query('UPDATE public.settings SET password_login_enabled = true, sso_google_enabled = false, sso_microsoft_enabled = false');
      }
    });
    await setMeta(db, 'reporter_provisioned', new Date().toISOString());
    provisioned = true;
    log.info('instance provisioned', { tenantId });
  }
  const keyA = await sealed(db, 'reporter_key_a');
  const keyB = await sealed(db, 'reporter_key_b');
  const provisionSecret = await sealed(db, 'reporter_provision_secret');
  if (!keyA || !keyB) throw new Error('this server\'s signing keys are missing from the vault (was VAULT_KEY changed?)');
  const A = crypto.createPrivateKey(keyA), B = crypto.createPrivateKey(keyB);
  return {
    tenantId,
    provisionSecret: provisionSecret || '',
    // A signed operation for this database, as Pental's own signer makes one
    // for a firm's: tenant|op|nonce|exp, signed by both keys.
    envelope(op) {
      const nonce = crypto.randomBytes(32).toString('hex');
      const exp = Math.floor(Date.now() / 1000) + 60;
      const c = `${tenantId}|${op}|${nonce}|${exp}`;
      return { tenant_id: tenantId, op, nonce, exp,
        sig_a: crypto.sign(null, Buffer.from(c), A).toString('base64'),
        sig_b: crypto.sign(null, Buffer.from(c), B).toString('base64') };
    },
  };
}

// ── The first administrator ───────────────────────────────────────────────
export async function needsFirstAdmin(db) {
  const r = await db.query("SELECT count(*)::int AS n FROM public.profiles WHERE role = 'admin' AND COALESCE(active, true)");
  return r.rows[0].n === 0;
}

// { ok } or { ok: false, error }. Made as rpc_bootstrap_admin makes one, by the
// owner, with the password set and Pental's first-run wizard marked done.
export async function makeFirstAdmin(db, { email, name, password, company }) {
  const e = String(email || '').trim();
  const n = String(name || '').trim();
  const pw = String(password || '');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) || e.length > 254) return { ok: false, error: 'Enter a valid email address.' };
  if (!n || n.length > 120) return { ok: false, error: 'Enter your name.' };
  try {
    // asOwner is one transaction: the lock, the check and every insert
    // commit together or not at all.
    return await db.asOwner(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtext('reporter_first_admin'))");
      const has = (await c.query('SELECT count(*)::int AS n FROM public.profiles')).rows[0].n;
      if (has) return { ok: false, error: 'Pental Report already has an administrator here. Sign in instead.', exists: true };
      if (company && String(company).trim()) await c.query('UPDATE public.settings SET company_name = $1', [String(company).trim().slice(0, 160)]);
      const pol = (await c.query('SELECT public.rpc_password_policy($1, $2) AS r', [pw, e])).rows[0].r;
      if (pol && pol.ok === false) {
        const err = new Error((pol.reasons || ['That password is not allowed.']).join(' '));
        err.policy = true;
        throw err;
      }
      const uid = crypto.randomUUID();
      const lower = e.toLowerCase();
      await c.query(`INSERT INTO auth.users (id, instance_id, email, encrypted_password, email_confirmed_at, aud, role,
          raw_app_meta_data, raw_user_meta_data, created_at, updated_at, confirmation_token, email_change, email_change_token_new,
          recovery_token, phone_change, phone_change_token, reauthentication_token, is_sso_user, is_anonymous)
        VALUES ($1::uuid, '00000000-0000-0000-0000-000000000000', $2::text, extensions.crypt(gen_random_uuid()::text, extensions.gen_salt('bf')),
          now(), 'authenticated', 'authenticated', jsonb_build_object('provider', 'email', 'providers', ARRAY['email']),
          jsonb_build_object('name', $3::text), now(), now(), encode(extensions.gen_random_bytes(32), 'hex'), '', '', '', '', '', '', false, false)`,
      [uid, lower, n]);
      await c.query(`INSERT INTO auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
        VALUES (gen_random_uuid(), $1::uuid, $2::text, jsonb_build_object('sub', $1::uuid::text, 'email', $2::text, 'email_verified', true), 'email', now(), now(), now())`, [uid, lower]);
      await c.query("SELECT set_config('pental.bypass_protect', 'true', true)");
      await c.query("INSERT INTO public.profiles (id, auth_user_id, email, name, role, onboarding_completed_at) VALUES ($1::uuid, $1::uuid, $2::text, $3::text, 'admin', now())", [uid, e, n]);
      await c.query('INSERT INTO public.user_credentials (profile_id, password_hash) VALUES ($1, public._pw_hash($2))', [uid, pw]);
      await c.query("SELECT set_config('pental.bypass_protect', 'false', true)");
      return { ok: true, user_id: uid };
    });
  } catch (err) {
    if (err && err.policy) return { ok: false, error: err.message };
    log.error('first administrator not made', { error: err && err.message });
    return { ok: false, error: 'The administrator could not be made: ' + (err && err.message) };
  }
}
