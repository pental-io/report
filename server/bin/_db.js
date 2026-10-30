// The server's own database connection, for the commands in this folder.
// They run where the server runs (`docker compose exec report ...`), so
// they have its DATABASE_URL and VAULT_KEY, and act as the database's owner.
//
// SPDX-License-Identifier: AGPL-3.0-only
import pg from 'pg';
import { poolOptions } from '../lib/db.js';

export function emailArg(command) {
  const email = String(process.argv[2] || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    console.error(`Usage: docker compose exec report node server/bin/${command} person@yourfirm.com`);
    process.exit(2);
  }
  if (!process.env.DATABASE_URL) {
    console.error(`DATABASE_URL is not set. Run this where the server runs:\n  docker compose exec report node server/bin/${command} ${email}`);
    process.exit(2);
  }
  return email;
}

export async function ownerDb() {
  const db = new pg.Client(poolOptions(process.env.DATABASE_URL));
  await db.connect();
  if (process.env.VAULT_KEY) await db.query("SELECT set_config('app.settings.vault_key', $1, false)", [process.env.VAULT_KEY]);
  return db;
}

// The person who signs in with this email, or a reason there is none.
export async function personByEmail(db, email) {
  const r = await db.query('SELECT id, auth_user_id, name, role, active FROM public.profiles WHERE lower(email) = lower($1) ORDER BY created_at LIMIT 1', [email]);
  const p = r.rows[0];
  if (!p) return { error: `Nobody here signs in as ${email}.` };
  if (p.role === 'client') return { error: `${email} is a client account, which Pental Report does not use.` };
  if (p.active === false) return { error: `${email} is deactivated. An administrator turns the account back on from Team first.` };
  return { person: p };
}
