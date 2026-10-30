// WHO IS ASKING. The api key (the publishable key, a token itself) says the
// request may be made at all; the bearer token says as whom. Both are HS256
// tokens under the gateway's secret. The setup token, presented by the firm's
// own administrator, is the one credential that runs as the owner.
import crypto from 'node:crypto';
import { HttpError, credentialsOf } from './http.js';
import { verifyJwt } from './jwt.js';

const ROLES = new Set(['anon', 'authenticated']);

// Why a verified token may not act as a session, or ''. Shared with live
// updates (realtime/index.js).
export function notASession(claims, role) {
  if (claims && claims.kind) return 'JWT is a storage link, not a session';
  if (role === 'authenticated' && !(claims && typeof claims.sub === 'string' && claims.sub)) return 'JWT names no user';
  return '';
}

export class Authz {
  constructor(cfg) { this.cfg = cfg; }

  isSetupToken(token) {
    const a = Buffer.from(String(token || ''));
    const b = Buffer.from(this.cfg.setupToken);
    return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
  }

  // `{ role, claims, token }`, or throws a 401 in PostgREST's shape.
  resolve(req, url, { allowSetupToken = true } = {}) {
    const { bearer, apikey } = credentialsOf(req, url);
    if (!apikey && !bearer) {
      throw new HttpError(401, { message: 'No API key found in request', hint: 'No `apikey` request header or url param was found.' });
    }
    if (apikey && !this.isSetupToken(apikey)) {
      const k = verifyJwt(apikey, this.cfg.jwtSecret);
      if (!k.ok || !k.claims || !k.claims.role || k.claims.kind) throw new HttpError(401, { message: 'Invalid API key', hint: 'Double check your publishable key.' });
    }
    const token = bearer || apikey;
    if (allowSetupToken && this.isSetupToken(token)) return { role: 'owner', claims: { role: 'service_role', iss: 'pental-gateway' }, token, setup: true };
    const v = verifyJwt(token, this.cfg.jwtSecret);
    if (!v.ok) {
      const msg = v.expired ? 'JWT expired' : 'JWSError ' + v.error;
      throw new HttpError(401, { code: 'PGRST301', message: msg, details: null, hint: null });
    }
    const role = String(v.claims.role || '');
    if (!ROLES.has(role)) throw new HttpError(401, { code: 'PGRST301', message: 'JWT role not allowed', details: null, hint: null });
    // 1.10.0: not a storage link (it names its `kind`), and a session names
    // the person it is (its `sub`).
    const why = notASession(v.claims, role);
    if (why) throw new HttpError(401, { code: 'PGRST301', message: why, details: null, hint: null });
    return { role, claims: v.claims, token, setup: false };
  }

  // Optional: a bearer that may be absent (public storage objects).
  resolveOptional(req, url) {
    try { return this.resolve(req, url); } catch (e) { return { role: 'anon', claims: { role: 'anon' }, token: '', setup: false, error: e }; }
  }
}
