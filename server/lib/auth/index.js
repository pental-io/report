// /auth/v1: sessions for the portal, in the shape supabase-js expects.
//
// The portal keeps its own sign-in logic in the database (email codes,
// password checks, MFA, WebAuthn are all RPCs in the schema) and ends every
// successful sign-in with one call here: a password grant for a single-use
// bridge password the schema just set. So what this has to do is small and
// exact: verify a password against auth.users with bcrypt, mint the access
// token GoTrue would mint (with the schema's custom_access_token_hook
// applied), keep sessions and rotating refresh tokens, and answer /user and
// /logout. Sign-up is off; nobody creates an account here.
//
// Single sign-on (Google, Microsoft) is in oidc.js, when the firm has
// registered an app for it.
import crypto from 'node:crypto';
import { HttpError, readJson, sendJson, credentialsOf, clientIp, originOf } from '../http.js';
import { signJwt, verifyJwt, ISSUER } from '../jwt.js';
import { log } from '../log.js';
import { Oidc } from './oidc.js';

const REUSE_INTERVAL_MS = 10000;
// A bcrypt hash of a value nobody knows, at the cost the schema's bridge
// passwords use (gen_salt('bf'), cost 6). An unknown address, or one with no
// bridge set, is compared against it, so every answer does the same work and
// takes the same time.
const DUMMY_HASH = '$2a$06$pCjxEs4kfRE92tupFBkifO1Tn1pC5wTTm7DgLEr6V6HjwNonZCTI.';
const WINDOW_MS = 5 * 60 * 1000;
const PER_CLIENT = 30;     // attempts from one address in the window
const PER_ACCOUNT = 50;    // failed attempts on one account in the window

export function authError(status, errorCode, msg) {
  return new HttpError(status, { code: status, error_code: errorCode, msg, error: errorCode, error_description: msg });
}

export class Auth {
  constructor({ db, cfg, authz }) {
    this.db = db; this.cfg = cfg; this.authz = authz;
    this.oidc = new Oidc({ auth: this, cfg });
    this.attempts = new Map();   // 'ip:<addr>' | 'acct:<email>' -> [timestamps]
  }

  issuer(req) { return (originOf(req, this.cfg) || 'http://localhost') + '/auth/v1'; }

  async handle(req, res, url, rest) {
    const method = req.method.toUpperCase();
    const path = String(rest || '').replace(/\/+$/, '');
    if (path === 'health' && method === 'GET') return sendJson(res, 200, { version: 'pental-gateway', name: 'Pental gateway auth', description: 'Sessions for the Pental portal on your own database' });
    if (path === 'settings' && method === 'GET') return sendJson(res, 200, this.settings());
    if (path === 'token' && method === 'POST') return this.token(req, res, url);
    if (path === 'user' && method === 'GET') return this.getUser(req, res, url);
    if (path === 'user' && method === 'PUT') return this.putUser(req, res, url);
    if (path === 'logout' && method === 'POST') return this.logout(req, res, url);
    if (path === 'authorize' && method === 'GET') return this.oidc.authorize(req, res, url);
    if (path === 'callback' && (method === 'GET' || method === 'POST')) return this.oidc.callback(req, res, url);
    if (path === 'signup') throw authError(422, 'signup_disabled', 'Sign-ups are not allowed for this instance. Accounts are created by an administrator in the portal.');
    if (['recover', 'otp', 'magiclink', 'verify', 'resend', 'reauthenticate', 'invite'].includes(path)) {
      throw authError(400, 'not_supported', 'The portal sends its own sign-in and reset emails; this route is not used on the Pental gateway.');
    }
    if (path.startsWith('admin/')) throw authError(403, 'not_admin', 'No service-role token exists on the Pental gateway. Administration is done in the portal.');
    if (path === 'factors' || path.startsWith('factors/')) throw authError(400, 'not_supported', 'Multi-factor sign-in is handled by the portal itself.');
    throw authError(404, 'not_found', 'No such route');
  }

  settings() {
    return {
      external: { email: true, phone: false, google: !!this.cfg.sso.google.clientId, azure: !!this.cfg.sso.azure.clientId, anonymous_users: false },
      disable_signup: true, mailer_autoconfirm: true, phone_autoconfirm: false, sms_provider: '', saml_enabled: false,
    };
  }

  // ── tokens ───────────────────────────────────────────────────────────────
  async token(req, res, url) {
    const grant = url.searchParams.get('grant_type') || '';
    const body = (await readJson(req).catch(() => null)) || {};
    if (grant === 'password') return this.passwordGrant(req, res, body);
    if (grant === 'refresh_token') return this.refreshGrant(req, res, body);
    if (grant === 'pkce') throw authError(400, 'not_supported', 'The PKCE flow is not used by the portal.');
    throw authError(400, 'unsupported_grant_type', `Unsupported grant type "${grant}"`);
  }

  // How many recent entries a key has, counting this one when `add`.
  count(key, add) {
    const now = Date.now();
    const list = (this.attempts.get(key) || []).filter((t) => now - t < WINDOW_MS);
    if (add) list.push(now);
    if (list.length) this.attempts.set(key, list); else this.attempts.delete(key);
    // 1.10.0: tidied once a second at most. Past 20,000 callers it went
    // through every one of them on every attempt; and if that many are still
    // inside the window, the oldest are let go so it stays bounded.
    if (this.attempts.size > 20000 && now - (this._tidied || 0) > 1000) {
      this._tidied = now;
      for (const [k, v] of this.attempts) if (!v.some((t) => now - t < WINDOW_MS)) this.attempts.delete(k);
      let over = this.attempts.size - 20000;
      for (const k of this.attempts.keys()) { if (over-- <= 0) break; this.attempts.delete(k); }
    }
    return list.length;
  }

  // THE ONE GRANT THE PORTAL MAKES: its own sign-in (an email code, or a
  // password checked by the schema's rpc_password_login, then MFA) ends by
  // setting a random single-use bridge password in auth.users and signing in
  // with it here at once. So a bridge is spent by the grant that uses it, and
  // nothing else ever sets one (PUT /user refuses passwords): a session can
  // only start from the portal's own checks.
  async passwordGrant(req, res, body) {
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    if (!email || !password) throw authError(400, 'validation_failed', 'email and password are required');
    const ip = clientIp(req, this.cfg.proxyHops);
    // Per client address (the one the cloud's proxy saw, never a header the
    // caller wrote) and per account (failures only, so a real sign-in is
    // never what locks an account).
    if (this.count('ip:' + ip, true) > PER_CLIENT || this.count('acct:' + email, false) >= PER_ACCOUNT) {
      throw authError(429, 'over_request_rate_limit', 'Too many sign-in attempts. Try again in a few minutes.');
    }
    const fail = () => { this.count('acct:' + email, true); return authError(400, 'invalid_credentials', 'Invalid login credentials'); };
    const out = await this.db.asOwner(async (client) => {
      const r = await client.query(
        `SELECT u.* FROM auth.users u WHERE lower(u.email) = $1 AND u.deleted_at IS NULL AND COALESCE(u.is_sso_user, false) = false LIMIT 1 FOR UPDATE`, [email]);
      const user = r.rows[0] || null;
      // One bcrypt comparison whatever the case, at the bridge's own cost.
      const hash = user && user.encrypted_password ? user.encrypted_password : DUMMY_HASH;
      const ok = (await client.query('SELECT extensions.crypt($1, $2) = $2 AS ok', [password, hash])).rows[0].ok === true;
      if (!user || !user.encrypted_password || !ok) return { error: fail() };
      if (user.banned_until && new Date(user.banned_until) > new Date()) return { error: authError(400, 'user_banned', 'User is banned') };
      if (!user.email_confirmed_at) return { error: authError(400, 'email_not_confirmed', 'Email not confirmed') };
      // A person the portal has switched off does not get a session.
      const prof = await client.query(
        `SELECT bool_and(active) AS active FROM public.profiles WHERE auth_user_id = $1`, [user.id]).catch(() => ({ rows: [] }));
      if (prof.rows[0] && prof.rows[0].active === false) return { error: fail() };
      // Spent: the bridge works once.
      await client.query('UPDATE auth.users SET encrypted_password = NULL, updated_at = now() WHERE id = $1', [user.id]);
      return { user };
    });
    if (out.error) throw out.error;
    const session = await this.createSession(out.user, 'password', { ip, userAgent: String(req.headers['user-agent'] || ''), issuer: this.issuer(req) });
    this.audit('login', out.user.id, ip, { provider: 'email' });
    sendJson(res, 200, session, { 'Cache-Control': 'no-store' });
  }

  async refreshGrant(req, res, body) {
    const token = String(body.refresh_token || '').trim();
    if (!token) throw authError(400, 'validation_failed', 'refresh_token is required');
    const out = await this.db.asOwner(async (client) => {
      const r = await client.query(`SELECT t.*, s.not_after, s.user_id AS session_user FROM auth.refresh_tokens t LEFT JOIN auth.sessions s ON s.id = t.session_id WHERE t.token = $1 FOR UPDATE OF t`, [token]);
      const row = r.rows[0];
      if (!row || !row.session_id) throw authError(400, 'refresh_token_not_found', 'Invalid Refresh Token: Refresh Token Not Found');
      if (row.not_after && new Date(row.not_after) < new Date()) throw authError(400, 'session_expired', 'Invalid Refresh Token: Session Expired');
      const u = await client.query('SELECT * FROM auth.users WHERE id = $1 AND deleted_at IS NULL', [row.session_user]);
      const user = u.rows[0];
      if (!user) throw authError(400, 'user_not_found', 'Invalid Refresh Token: User Not Found');
      if (user.banned_until && new Date(user.banned_until) > new Date()) throw authError(400, 'user_banned', 'User is banned');
      let next;
      if (row.revoked) {
        // Reused. Within the reuse window the newest child is handed back
        // (two tabs refreshing at once); after it, the whole session is out.
        const c = await client.query('SELECT * FROM auth.refresh_tokens WHERE parent = $1 AND session_id = $2 ORDER BY id DESC LIMIT 1', [token, row.session_id]);
        const child = c.rows[0];
        if (child && !child.revoked && Date.now() - new Date(child.created_at).getTime() < REUSE_INTERVAL_MS) next = child;
        else {
          await client.query('UPDATE auth.refresh_tokens SET revoked = true, updated_at = now() WHERE session_id = $1', [row.session_id]);
          throw authError(400, 'refresh_token_already_used', 'Invalid Refresh Token: Already Used');
        }
      } else {
        await client.query('UPDATE auth.refresh_tokens SET revoked = true, updated_at = now() WHERE id = $1', [row.id]);
        const ins = await client.query(
          'INSERT INTO auth.refresh_tokens (token, user_id, revoked, created_at, updated_at, parent, session_id) VALUES ($1, $2, false, now(), now(), $3, $4) RETURNING *',
          [this.newRefreshToken(), String(user.id), token, row.session_id]);
        next = ins.rows[0];
        await client.query('UPDATE auth.sessions SET refreshed_at = now(), updated_at = now() WHERE id = $1', [row.session_id]);
      }
      const amr = await client.query('SELECT authentication_method, created_at FROM auth.mfa_amr_claims WHERE session_id = $1 ORDER BY created_at', [row.session_id]);
      const claims = await this.claimsFor(client, user, row.session_id, amr.rows.map((a) => ({ method: a.authentication_method, timestamp: Math.floor(new Date(a.created_at).getTime() / 1000) })), this.issuer(req));
      return this.sessionResponse(claims, next.token, user);
    });
    sendJson(res, 200, out, { 'Cache-Control': 'no-store' });
  }

  newRefreshToken() { return crypto.randomBytes(24).toString('base64url'); }

  async createSession(user, method, { ip, userAgent, issuer } = {}) {
    return this.db.asOwner(async (client) => {
      const sessionId = crypto.randomUUID();
      await client.query('INSERT INTO auth.sessions (id, user_id, created_at, updated_at, aal, user_agent, ip) VALUES ($1, $2, now(), now(), $3, $4, $5)',
        [sessionId, user.id, 'aal1', (userAgent || '').slice(0, 500) || null, ip && /^[0-9a-f.:]+$/i.test(ip) ? ip : null]);
      await client.query('INSERT INTO auth.mfa_amr_claims (id, session_id, authentication_method, created_at, updated_at) VALUES ($1, $2, $3, now(), now())', [crypto.randomUUID(), sessionId, method]);
      const refresh = this.newRefreshToken();
      await client.query('INSERT INTO auth.refresh_tokens (token, user_id, revoked, created_at, updated_at, parent, session_id) VALUES ($1, $2, false, now(), now(), NULL, $3)', [refresh, String(user.id), sessionId]);
      await client.query('UPDATE auth.users SET last_sign_in_at = now(), updated_at = now() WHERE id = $1', [user.id]);
      const fresh = await client.query('SELECT * FROM auth.users WHERE id = $1', [user.id]);
      const claims = await this.claimsFor(client, fresh.rows[0], sessionId, [{ method, timestamp: Math.floor(Date.now() / 1000) }], issuer);
      return this.sessionResponse(claims, refresh, fresh.rows[0]);
    });
  }

  // GoTrue's claims, then the schema's hook, which adds what the portal's
  // freshness checks read (mfa_verified_at) from auth.users.
  async claimsFor(client, user, sessionId, amr, issuer) {
    const now = Math.floor(Date.now() / 1000);
    const app = Object.assign({ provider: 'email', providers: ['email'] }, user.raw_app_meta_data || {});
    const claims = {
      iss: issuer || this.issuer(), sub: user.id, aud: 'authenticated', exp: now + this.cfg.jwtExpiry, iat: now,
      email: user.email || '', phone: user.phone || '', app_metadata: app, user_metadata: user.raw_user_meta_data || {},
      role: 'authenticated', aal: 'aal1', amr, session_id: sessionId, is_anonymous: false,
    };
    try {
      const hook = await client.query('SELECT public.custom_access_token_hook($1::jsonb) AS out', [JSON.stringify({ user_id: user.id, claims, authentication_method: amr[amr.length - 1] ? amr[amr.length - 1].method : 'password' })]);
      const out = hook.rows[0] && hook.rows[0].out;
      if (out && out.claims && typeof out.claims === 'object') return out.claims;
    } catch (e) {
      if (e.code !== '42883') log.warn('access token hook failed', { error: e.message });
    }
    return claims;
  }

  sessionResponse(claims, refreshToken, user) {
    const access = signJwt(claims, this.cfg.jwtSecret);
    return { access_token: access, token_type: 'bearer', expires_in: claims.exp - claims.iat, expires_at: claims.exp, refresh_token: refreshToken, user: this.userView(user) };
  }

  userView(u) {
    return {
      id: u.id, aud: 'authenticated', role: 'authenticated', email: u.email || '',
      email_confirmed_at: u.email_confirmed_at || null, phone: u.phone || '', confirmed_at: u.confirmed_at || u.email_confirmed_at || null,
      last_sign_in_at: u.last_sign_in_at || null, app_metadata: Object.assign({ provider: 'email', providers: ['email'] }, u.raw_app_meta_data || {}),
      user_metadata: u.raw_user_meta_data || {}, identities: u.identities || [], created_at: u.created_at || null, updated_at: u.updated_at || null, is_anonymous: false,
    };
  }

  // The user behind a bearer token, or a 401 in GoTrue's words.
  async userOf(req, url) {
    const { bearer } = credentialsOf(req, url);
    if (!bearer) throw authError(401, 'no_authorization', 'This endpoint requires a Bearer token');
    const v = verifyJwt(bearer, this.cfg.jwtSecret);
    if (!v.ok) throw authError(401, v.expired ? 'bad_jwt' : 'bad_jwt', v.expired ? 'invalid JWT: unable to parse or verify signature, token is expired' : 'invalid JWT: unable to parse or verify signature');
    if (!v.claims.sub || v.claims.role !== 'authenticated') throw authError(401, 'bad_jwt', 'invalid claim: missing sub claim');
    const r = await this.db.query('SELECT * FROM auth.users WHERE id = $1 AND deleted_at IS NULL', [v.claims.sub]);
    if (!r.rows[0]) throw authError(403, 'user_not_found', 'User from sub claim in JWT does not exist');
    if (v.claims.session_id) {
      const s = await this.db.query('SELECT id FROM auth.sessions WHERE id = $1', [v.claims.session_id]);
      if (!s.rows[0]) throw authError(403, 'session_not_found', 'Session from session_id claim in JWT does not exist');
    }
    const ids = await this.db.query('SELECT id AS identity_id, provider_id AS id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at, email FROM auth.identities WHERE user_id = $1', [r.rows[0].id]);
    return { user: { ...r.rows[0], identities: ids.rows }, claims: v.claims };
  }

  async getUser(req, res, url) {
    const { user } = await this.userOf(req, url);
    sendJson(res, 200, this.userView(user), { 'Cache-Control': 'no-store' });
  }

  // Only the person's own display data. Passwords are the portal's (its
  // rpc_change_own_password asks for the current one and a fresh second
  // factor), and the address is changed by an administrator in the portal.
  async putUser(req, res, url) {
    const { user } = await this.userOf(req, url);
    const body = (await readJson(req).catch(() => null)) || {};
    const sets = [];
    const vals = [];
    if (body.password !== undefined) throw authError(422, 'not_supported', 'Passwords are changed in the portal (Settings, Security), which checks the current one and your second factor.');
    if (body.phone !== undefined || body.nonce !== undefined) throw authError(400, 'not_supported', 'Not supported on the Pental gateway.');
    if (body.data && typeof body.data === 'object' && !Array.isArray(body.data)) {
      vals.push(JSON.stringify(body.data)); sets.push(`raw_user_meta_data = COALESCE(raw_user_meta_data, '{}'::jsonb) || $${vals.length}::jsonb`);
    }
    if (typeof body.email === 'string' && body.email.trim()) throw authError(400, 'not_supported', 'Email addresses are changed by an administrator in the portal.');
    if (sets.length) {
      vals.push(user.id);
      await this.db.query(`UPDATE auth.users SET ${sets.join(', ')}, updated_at = now() WHERE id = $${vals.length}`, vals);
    }
    const r = await this.db.query('SELECT * FROM auth.users WHERE id = $1', [user.id]);
    sendJson(res, 200, this.userView({ ...r.rows[0], identities: user.identities }), { 'Cache-Control': 'no-store' });
  }

  async logout(req, res, url) {
    const { user, claims } = await this.userOf(req, url).catch((e) => { if (e.status === 401 || e.status === 403) return { user: null, claims: null }; throw e; });
    if (user) {
      const scope = url.searchParams.get('scope') || 'global';
      if (scope === 'global') await this.db.query('DELETE FROM auth.sessions WHERE user_id = $1', [user.id]);
      else if (scope === 'others' && claims.session_id) await this.db.query('DELETE FROM auth.sessions WHERE user_id = $1 AND id <> $2', [user.id, claims.session_id]);
      else if (claims.session_id) await this.db.query('DELETE FROM auth.sessions WHERE id = $1', [claims.session_id]);
      // The ended sessions stop working for data at once on this instance
      // (and within the liveness window on any other).
      this.db.forgetSessions();
      this.audit('logout', user.id, clientIp(req, this.cfg.proxyHops), { scope });
    }
    res.writeHead(204); res.end();
  }

  audit(action, userId, ip, extra) {
    this.db.query('INSERT INTO auth.audit_log_entries (payload, ip_address) VALUES ($1, $2)', [JSON.stringify({ action, actor_id: userId, timestamp: new Date().toISOString(), ...(extra || {}) }), String(ip || '').slice(0, 64)]).catch(() => {});
  }
}

export { ISSUER };
