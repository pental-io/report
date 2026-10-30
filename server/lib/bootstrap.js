// What the gateway does to the database before it serves: the foundations
// (sql/bootstrap.sql), the attestation secret the schema checks signed
// operations against, and the live-change triggers.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { log } from './log.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const GATEWAY_VERSION = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8')).version;

export function bootstrapSql() {
  return fs.readFileSync(path.join(here, '..', 'sql', 'bootstrap.sql'), 'utf8');
}

// Multi-statement SQL as one round trip, notices collected. The simple
// query protocol runs statements one after another and stops at the first
// error, exactly as psql -f does without ON_ERROR_STOP off.
export async function runSql(client, sql) {
  const notices = [];
  const onNotice = (n) => { if (n && n.message) notices.push(n.message); };
  client.on('notice', onNotice);
  try {
    await client.query(sql);
  } finally {
    client.removeListener('notice', onNotice);
  }
  return notices;
}

export async function bootstrap(db) {
  const notices = await db.asOwner((client) => runSql(client, bootstrapSql()));
  for (const n of notices) log.debug('bootstrap notice', { notice: n });
  await ensureAttestSecret(db);
  const attached = await attachRealtime(db);
  await db.query('INSERT INTO pental.meta (key, value, updated_at) VALUES ($1, $2, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()', ['gateway_version', GATEWAY_VERSION]);
  return { attached };
}

// The secret behind x-pental-attest: shared by the gateway and the schema's
// _verify_pental_auth, kept sealed in the vault under a name the schema's
// clean never touches. Read back on every start; made once.
export async function ensureAttestSecret(db) {
  const r = await db.query("SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'pental_gateway_attest'");
  if (r.rows.length && r.rows[0].decrypted_secret && r.rows[0].decrypted_secret.length >= 32) return r.rows[0].decrypted_secret;
  const secret = crypto.randomBytes(32).toString('hex');
  if (r.rows.length) {
    await db.query("SELECT vault.update_secret((SELECT id FROM vault.secrets WHERE name = 'pental_gateway_attest'), $1)", [secret]);
  } else {
    await db.query("SELECT vault.create_secret($1, 'pental_gateway_attest', 'HMAC key the Pental gateway attests verified signatures with')", [secret]);
  }
  return secret;
}

export async function attachRealtime(db) {
  try {
    const r = await db.query('SELECT pental.rt_attach() AS n');
    return r.rows[0] ? r.rows[0].n : 0;
  } catch (e) {
    log.warn('realtime triggers not attached', { error: e.message });
    return 0;
  }
}

// The schema version the portal schema stamped, or 0 before it is applied.
export async function schemaVersion(db) {
  try {
    const r = await db.query('SELECT version FROM public._pental_schema_version WHERE id = 1');
    return r.rows[0] ? parseInt(r.rows[0].version, 10) || 0 : 0;
  } catch { return 0; }
}
