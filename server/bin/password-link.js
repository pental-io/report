#!/usr/bin/env node
// A LINK TO CHOOSE A NEW PASSWORD, FOR SOMEBODY NOBODY ELSE CAN SEND ONE TO.
//
// Pental Report sends no email. An administrator makes a password link for a
// colleague from Team; when the person locked out is the only administrator,
// whoever runs the server makes one here:
//
//   docker compose exec report node server/bin/password-link.js you@yourfirm.com
//
// The link works once, for an hour. Their second factor stays as it is.
//
// SPDX-License-Identifier: AGPL-3.0-only
import crypto from 'node:crypto';
import { emailArg, ownerDb, personByEmail } from './_db.js';

const email = emailArg('password-link.js');
const origin = String(process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '') || 'http://localhost:8080';
const db = await ownerDb();
try {
  const { person, error } = await personByEmail(db, email);
  if (error) { console.error(error); process.exitCode = 1; }
  else {
    // As the server makes one for an administrator (lib/api.js, passwordLink).
    const token = crypto.randomBytes(32).toString('base64url');
    await db.query('BEGIN');
    await db.query('UPDATE public.password_setup_tokens SET used_at = now() WHERE profile_id = $1 AND used_at IS NULL', [person.id]);
    await db.query(`INSERT INTO public.password_setup_tokens (profile_id, token_hash, purpose, expires_at, issued_here)
      VALUES ($1, encode(extensions.digest(convert_to($2, 'UTF8'), 'sha256'), 'hex'), 'reset', now() + interval '1 hour', true)`, [person.id, token]);
    await db.query('COMMIT');
    console.log(`A link for ${person.name || email} to choose a new password. It works once, for an hour:\n\n  ${origin}/#pw_token=${token}\n`);
  }
} finally {
  await db.end();
}
