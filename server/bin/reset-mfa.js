#!/usr/bin/env node
// FOR SOMEBODY WHO HAS LOST THEIR SECOND FACTOR, WITH NOBODY TO RESET IT.
//
// An administrator resets a colleague's second factor from Team. When the
// person locked out is the only administrator, whoever runs the server does
// it here:
//
//   docker compose exec report node server/bin/reset-mfa.js you@yourfirm.com
//
// Their authenticator app and security keys are cleared, as Team's Reset MFA
// clears them, and they set up a new one when they next sign in. Their
// password stays as it is.
//
// SPDX-License-Identifier: AGPL-3.0-only
import { emailArg, ownerDb, personByEmail } from './_db.js';

const email = emailArg('reset-mfa.js');
const db = await ownerDb();
try {
  const { person, error } = await personByEmail(db, email);
  if (error) { console.error(error); process.exitCode = 1; }
  else {
    await db.query('BEGIN');
    // What rpc_admin_reset_mfa does, past the checks that guard the last factor.
    await db.query("SELECT set_config('pental.bypass_protect', 'true', true), set_config('pental.bypass_mfa_protection', 'true', true)");
    await db.query('UPDATE public.profiles SET totp_secret = NULL, totp_attempts = 0, totp_locked_until = NULL WHERE id = $1', [person.id]);
    const keys = person.auth_user_id ? (await db.query('DELETE FROM public.webauthn_credentials WHERE auth_user_id = $1', [person.auth_user_id])).rowCount : 0;
    // 1977: and, as Team's Reset MFA does (_clear_mfa_verified), every session
    // of theirs asked for the second factor again, and their API keys revoked.
    let apiKeys = 0;
    if (person.auth_user_id) {
      apiKeys = (await db.query('SELECT count(*)::int AS n FROM public.api_keys WHERE auth_user_id = $1 AND revoked_at IS NULL', [person.auth_user_id])).rows[0].n;
      await db.query('SELECT public._clear_mfa_verified($1)', [person.auth_user_id]);
    }
    await db.query('COMMIT');
    console.log(`${person.name || email} has no second factor now${keys ? ` (${keys} security key${keys === 1 ? '' : 's'} removed)` : ''}. They set up a new one when they next sign in.`
      + (apiKeys ? ` Their ${apiKeys} API key${apiKeys === 1 ? ' is' : 's are'} revoked.` : ''));
  }
} finally {
  await db.end();
}
