// HS256 tokens, the shape supabase-js and the portal already understand.
//
// The publishable key is a token too: role `anon`, no subject, signed with
// the gateway's secret, valid for a hundred years. It is derived, not
// stored, so `bin/keys.js` prints the same one every time for the same
// JWT_SECRET, and rotating the secret rotates it with every sign-in.
import crypto from 'node:crypto';

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (s) => Buffer.from(String(s || ''), 'base64url');

export const ISSUER = 'pental-gateway';
const ANON_IAT = 1700000000;              // fixed, so the key is stable
const ANON_TTL = 100 * 365 * 86400;

export function signJwt(claims, secret) {
  const header = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64u(JSON.stringify(claims));
  const sig = crypto.createHmac('sha256', secret).update(header + '.' + payload).digest();
  return header + '.' + payload + '.' + b64u(sig);
}

// `{ ok, claims }` or `{ ok: false, error }`. Expiry is checked here; the
// caller decides what a token without a role means.
// No leeway by default: the gateway signs and checks on the same clock.
// 1.10.0: a token with no expiry is refused: it would be good for ever.
// Everything this gateway signs carries one (the publishable key's is a
// hundred years).
export function verifyJwt(token, secret, { now = Math.floor(Date.now() / 1000), leeway = 0 } = {}) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return { ok: false, error: 'not a token' };
  let header;
  try { header = JSON.parse(fromB64u(parts[0]).toString('utf8')); } catch { return { ok: false, error: 'bad header' }; }
  if (!header || header.alg !== 'HS256') return { ok: false, error: 'unsupported algorithm' };
  const expect = crypto.createHmac('sha256', secret).update(parts[0] + '.' + parts[1]).digest();
  const given = fromB64u(parts[2]);
  if (given.length !== expect.length || !crypto.timingSafeEqual(given, expect)) return { ok: false, error: 'bad signature' };
  let claims;
  try { claims = JSON.parse(fromB64u(parts[1]).toString('utf8')); } catch { return { ok: false, error: 'bad payload' }; }
  if (!claims || typeof claims !== 'object') return { ok: false, error: 'bad payload' };
  if (typeof claims.exp !== 'number') return { ok: false, error: 'no expiry' };
  if (claims.exp + leeway < now) return { ok: false, error: 'expired', expired: true };
  if (typeof claims.nbf === 'number' && claims.nbf - leeway > now) return { ok: false, error: 'not yet valid' };
  return { ok: true, claims };
}

// 1.10.0: the key a storage link is signed with, derived from the secret,
// so a link can never be presented as a session (it was: an upload link
// carried role "authenticated" and was taken as a bearer for two hours).
export function linkKey(secret) {
  return crypto.createHmac('sha256', String(secret)).update('pental-gateway storage link').digest('base64url');
}

// A storage link: under its own key, or, for one made before 1.10.0 and not
// yet expired, under the secret itself (such a token is refused as a session
// by its `kind`, authz.js).
export function verifyLink(token, secret) {
  const v = verifyJwt(token, linkKey(secret));
  return v.ok ? v : verifyJwt(token, secret);
}

export function anonKey(secret) {
  return signJwt({ iss: ISSUER, ref: 'gateway', role: 'anon', iat: ANON_IAT, exp: ANON_IAT + ANON_TTL }, secret);
}

// Read without verifying: for telling a publishable key from a user token
// in places where the signature is checked next anyway.
export function peekJwt(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  try { return JSON.parse(fromB64u(parts[1]).toString('utf8')); } catch { return null; }
}
