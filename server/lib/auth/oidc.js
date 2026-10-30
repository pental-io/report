// SINGLE SIGN-ON WITH GOOGLE OR MICROSOFT, AS SUPABASE'S /authorize DOES IT.
//
// The portal calls signInWithOAuth({ provider }) and the browser lands here
// at /auth/v1/authorize. The gateway sends it to the provider, takes the
// code back at /auth/v1/callback, verifies the provider's ID token against
// its published keys, and signs the person in by the address on it: an
// account must already exist in auth.users, since nobody is created by
// signing in. The session goes back to the portal in the URL fragment, the
// implicit flow supabase-js reads (detectSessionInUrl).
//
// The browser may only be sent back to the portal's own origin (PORTAL_URL,
// plus ALLOWED_REDIRECT_ORIGINS), never to an address the request names.
import crypto from 'node:crypto';
import { HttpError, clientIp, originOf } from '../http.js';
import { log } from '../log.js';

const PROVIDERS = {
  google: {
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    jwks: 'https://www.googleapis.com/oauth2/v3/certs',
    issuers: ['https://accounts.google.com', 'accounts.google.com'],
    scope: 'openid email profile',
  },
  azure: {
    authorize: (t) => `https://login.microsoftonline.com/${encodeURIComponent(t)}/oauth2/v2.0/authorize`,
    token: (t) => `https://login.microsoftonline.com/${encodeURIComponent(t)}/oauth2/v2.0/token`,
    jwks: (t) => `https://login.microsoftonline.com/${encodeURIComponent(t)}/discovery/v2.0/keys`,
    issuers: [/^https:\/\/login\.microsoftonline\.com\/[0-9a-f-]{36}\/v2\.0$/i],
    scope: 'openid email profile',
  },
};

const b64u = (b) => Buffer.from(b).toString('base64url');


// 1.10.0: the cookie that ties a sign-in's callback to the browser that began
// it, and reading one cookie from a request.
const SSO_COOKIE = 'pental_sso';
function cookieOf(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}

export class Oidc {
  constructor({ auth, cfg }) {
    this.auth = auth; this.cfg = cfg;
    this.jwks = new Map();   // url -> { keys, at }
  }

  provider(name) {
    const p = PROVIDERS[name];
    const c = this.cfg.sso[name];
    if (!p || !c) return null;
    if (!c.clientId || !c.clientSecret) return null;
    // A pinned tenant is a directory id; anything else signs in through the
    // multi-tenant endpoint and is held to a verified domain instead.
    const pinned = name === 'azure' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(c.tenant || '') ? c.tenant.toLowerCase() : '';
    const tenant = name === 'azure' ? (pinned || 'organizations') : '';
    return {
      name, clientId: c.clientId, clientSecret: c.clientSecret, tenant, pinned, domain: c.domain || '',
      authorize: typeof p.authorize === 'function' ? p.authorize(tenant) : p.authorize,
      token: typeof p.token === 'function' ? p.token(tenant) : p.token,
      jwks: typeof p.jwks === 'function' ? p.jwks(tenant) : p.jwks,
      issuers: p.issuers, scope: p.scope,
    };
  }

  callbackUrl(req) { return (originOf(req, this.cfg) || this.cfg.publicUrl) + '/auth/v1/callback'; }

  allowedRedirect(raw) {
    let u;
    try { u = new URL(String(raw || '')); } catch { return ''; }
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && /^(localhost|127\.0\.0\.1)$/.test(u.hostname))) return '';
    const origins = [this.cfg.portalUrl, ...this.cfg.allowedRedirectOrigins].filter(Boolean);
    if (!origins.includes(u.origin)) return '';
    u.hash = '';
    return u.toString();
  }

  sign(obj) {
    const body = b64u(JSON.stringify(obj));
    const sig = b64u(crypto.createHmac('sha256', this.cfg.jwtSecret + '|sso').update(body).digest());
    return body + '.' + sig;
  }
  open(state) {
    const [body, sig] = String(state || '').split('.');
    if (!body || !sig) return null;
    const expect = b64u(crypto.createHmac('sha256', this.cfg.jwtSecret + '|sso').update(body).digest());
    if (expect.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(expect), Buffer.from(sig))) return null;
    try { return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
  }

  redirectError(res, to, code, description) {
    const target = to || this.cfg.portalUrl || this.cfg.publicUrl;
    const q = new URLSearchParams({ error: 'server_error', error_code: code, error_description: description });
    res.writeHead(302, { Location: target + '#' + q.toString(), 'Cache-Control': 'no-store' });
    res.end();
  }

  async authorize(req, res, url) {
    const name = String(url.searchParams.get('provider') || '');
    const p = this.provider(name);
    if (!p) throw new HttpError(400, { code: 400, error_code: 'validation_failed', msg: `Unsupported provider: provider is not enabled`, error: 'validation_failed', error_description: `Unsupported provider: ${name || '(none)'} is not enabled on this gateway` });
    if (!originOf(req, this.cfg)) throw new HttpError(500, { code: 500, error_code: 'not_configured', msg: 'PUBLIC_URL is not set on the gateway', error: 'not_configured', error_description: 'PUBLIC_URL is not set on the gateway' });
    const to = this.allowedRedirect(url.searchParams.get('redirect_to')) || this.cfg.portalUrl;
    if (!to) throw new HttpError(400, { code: 400, error_code: 'validation_failed', msg: 'redirect_to is not an allowed origin (set PORTAL_URL on the gateway)', error: 'validation_failed', error_description: 'redirect_to is not an allowed origin (set PORTAL_URL on the gateway)' });
    const nonce = crypto.randomBytes(16).toString('hex');
    const state = this.sign({ p: name, to, n: nonce, t: Date.now() });
    const q = new URLSearchParams({
      client_id: p.clientId, redirect_uri: this.callbackUrl(req), response_type: 'code', scope: p.scope, state, nonce,
      ...(name === 'google' ? { access_type: 'online', prompt: 'select_account' } : { prompt: 'select_account', response_mode: 'query' }),
    });
    // 1.10.0: THE SIGN-IN COMES BACK TO THE BROWSER THAT STARTED IT. The state
    // proved the sign-in started here, not who started it: a link to the
    // callback with someone else's code and state signed the person who opened
    // it in as that someone (login CSRF). The nonce is kept in a cookie on this
    // address, for the callback only, and must come back with the state.
    const secure = /^https:/i.test(originOf(req, this.cfg)) ? '; Secure' : '';
    res.writeHead(302, { Location: p.authorize + '?' + q.toString(), 'Cache-Control': 'no-store',
      'Set-Cookie': `${SSO_COOKIE}=${nonce}; Path=/auth/v1/callback; Max-Age=600; HttpOnly; SameSite=Lax${secure}` });
    res.end();
  }

  async callback(req, res, url) {
    const state = this.open(url.searchParams.get('state'));
    if (!state || !state.p || Date.now() - (state.t || 0) > 10 * 60 * 1000) return this.redirectError(res, '', 'bad_oauth_state', 'The sign-in did not start here, or took longer than ten minutes.');
    const kept = cookieOf(req, SSO_COOKIE);
    if (!kept || !state.n || kept.length !== String(state.n).length || !crypto.timingSafeEqual(Buffer.from(kept), Buffer.from(String(state.n)))) {
      return this.redirectError(res, '', 'bad_oauth_state', 'The sign-in did not start in this browser. Start it again from the sign-in page.');
    }
    const to = this.allowedRedirect(state.to) || this.cfg.portalUrl;
    const p = this.provider(state.p);
    if (!p) return this.redirectError(res, to, 'provider_disabled', 'That provider is not enabled on this gateway.');
    if (url.searchParams.get('error')) return this.redirectError(res, to, 'oauth_provider_error', String(url.searchParams.get('error_description') || url.searchParams.get('error')).slice(0, 200));
    const code = url.searchParams.get('code');
    if (!code) return this.redirectError(res, to, 'bad_oauth_callback', 'The provider sent no code back.');
    let tok;
    try {
      const r = await fetch(p.token, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({ client_id: p.clientId, client_secret: p.clientSecret, grant_type: 'authorization_code', code, redirect_uri: this.callbackUrl(req) }),
        signal: AbortSignal.timeout(15000),
      });
      tok = await r.json().catch(() => null);
      if (!r.ok || !tok || !tok.id_token) return this.redirectError(res, to, 'oauth_token_exchange', 'The provider refused the code: ' + String((tok && (tok.error_description || tok.error)) || r.status).slice(0, 200));
    } catch (e) {
      return this.redirectError(res, to, 'oauth_token_exchange', 'Could not reach the provider: ' + e.message);
    }
    const id = await this.verifyIdToken(p, tok.id_token, state.n);
    if (!id.ok) return this.redirectError(res, to, 'bad_id_token', id.error);
    const who = this.identityOf(p, id.claims);
    if (who.error) return this.redirectError(res, to, who.code, who.error);
    const { email, subject } = who;
    // An account already linked to this sign-in wins; otherwise the verified
    // address links it, once.
    const linked = await this.auth.db.query(
      `SELECT u.* FROM auth.identities i JOIN auth.users u ON u.id = i.user_id WHERE i.provider = $1 AND i.provider_id = $2 AND u.deleted_at IS NULL LIMIT 1`, [p.name, subject]);
    const u = linked.rows[0] ? linked : await this.auth.db.query('SELECT * FROM auth.users WHERE lower(email) = $1 AND deleted_at IS NULL LIMIT 1', [email]);
    const user = u.rows[0];
    const refused = 'No portal account matches this sign-in. Ask an administrator of the portal to add you.';
    if (!user) return this.redirectError(res, to, 'user_not_found', refused);
    if (user.banned_until && new Date(user.banned_until) > new Date()) return this.redirectError(res, to, 'user_banned', 'This account is suspended.');
    const prof = await this.auth.db.query('SELECT bool_and(active) AS active FROM public.profiles WHERE auth_user_id = $1', [user.id]).catch(() => ({ rows: [] }));
    if (prof.rows[0] && prof.rows[0].active === false) return this.redirectError(res, to, 'user_not_found', refused);
    await this.auth.db.query(
      `INSERT INTO auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
       VALUES ($1, $2, $3::jsonb, $4, now(), now(), now())
       ON CONFLICT (provider_id, provider) DO UPDATE SET identity_data = EXCLUDED.identity_data, last_sign_in_at = now(), updated_at = now()`,
      [subject, user.id, JSON.stringify({ sub: subject, email, email_verified: true, name: id.claims.name || '', provider_id: subject, iss: id.claims.iss, tid: id.claims.tid || undefined }), p.name]);
    const session = await this.auth.createSession(user, 'oauth', { ip: clientIp(req, this.cfg.proxyHops), userAgent: String(req.headers['user-agent'] || ''), issuer: this.auth.issuer(req) });
    this.auth.audit('login', user.id, clientIp(req, this.cfg.proxyHops), { provider: p.name });
    const frag = new URLSearchParams({
      access_token: session.access_token, expires_in: String(session.expires_in), expires_at: String(session.expires_at),
      refresh_token: session.refresh_token, token_type: 'bearer', type: 'oauth', provider_token: '',
    });
    res.writeHead(302, { Location: to + '#' + frag.toString(), 'Cache-Control': 'no-store', 'Set-Cookie': `${SSO_COOKIE}=; Path=/auth/v1/callback; Max-Age=0; HttpOnly; SameSite=Lax` });
    res.end();
  }

  // WHO SIGNED IN, AND WHETHER THE PROVIDER VOUCHES FOR THE ADDRESS.
  //
  // Microsoft lets any directory put any address on a user, so an address from
  // a directory the firm does not run proves nothing (the "nOAuth" takeover).
  // It is accepted only from the firm's own tenant when SSO_MICROSOFT_TENANT
  // pins it, or with Microsoft's own verified-domain flag (xms_edov) otherwise;
  // the stable subject is the tenant and object ids. Google's address must be
  // verified, and in the firm's Workspace domain when SSO_GOOGLE_DOMAIN is set.
  identityOf(p, c) {
    const valid = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);
    if (p.name === 'google') {
      const email = String(c.email || '').trim().toLowerCase();
      if (!valid(email)) return { code: 'no_email', error: 'The provider did not say which address signed in.' };
      if (c.email_verified !== true && c.email_verified !== 'true') return { code: 'email_not_verified', error: 'That Google account\'s address is not verified.' };
      if (p.domain && String(c.hd || '').toLowerCase() !== p.domain) return { code: 'wrong_domain', error: 'Sign in with your ' + p.domain + ' account.' };
      return { email, subject: String(c.sub) };
    }
    const tid = String(c.tid || '').toLowerCase();
    const oid = String(c.oid || '').toLowerCase();
    if (!tid || !oid) return { code: 'bad_id_token', error: 'The Microsoft sign-in did not identify the directory and the account.' };
    if (p.pinned) {
      if (tid !== p.pinned) return { code: 'wrong_tenant', error: 'The account is not in the configured Microsoft 365 organisation.' };
      // In the firm's own directory its administrators decide the addresses.
      const email = String(c.email || c.preferred_username || '').trim().toLowerCase();
      if (!valid(email)) return { code: 'no_email', error: 'The provider did not say which address signed in.' };
      return { email, subject: tid + ':' + oid };
    }
    const email = String(c.email || '').trim().toLowerCase();
    const edov = c.xms_edov === true || c.xms_edov === 'true' || c.xms_edov === 1 || c.xms_edov === '1';
    if (!valid(email) || !edov) {
      return { code: 'email_not_verified', error: 'Microsoft did not confirm this address belongs to its directory. An administrator can set SSO_MICROSOFT_TENANT on the gateway to your organisation\'s tenant id, or add the xms_edov optional claim to the app registration.' };
    }
    return { email, subject: tid + ':' + oid };
  }

  async keysFor(p) {
    const cached = this.jwks.get(p.jwks);
    if (cached && Date.now() - cached.at < 6 * 3600 * 1000) return cached.keys;
    const r = await fetch(p.jwks, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error('JWKS ' + r.status);
    const j = await r.json();
    const keys = Array.isArray(j.keys) ? j.keys : [];
    this.jwks.set(p.jwks, { keys, at: Date.now() });
    return keys;
  }

  async verifyIdToken(p, token, nonce) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return { ok: false, error: 'The ID token is malformed.' };
    let header, claims;
    try { header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); }
    catch { return { ok: false, error: 'The ID token is malformed.' }; }
    if (header.alg !== 'RS256') return { ok: false, error: 'Unexpected ID token algorithm ' + header.alg };
    let keys;
    try { keys = await this.keysFor(p); } catch (e) { return { ok: false, error: 'Could not fetch the provider\'s keys: ' + e.message }; }
    let jwk = keys.find((k) => k.kid === header.kid);
    if (!jwk) {
      // A rotated key: fetch once more.
      this.jwks.delete(p.jwks);
      try { keys = await this.keysFor(p); } catch { keys = []; }
      jwk = keys.find((k) => k.kid === header.kid);
      if (!jwk) return { ok: false, error: 'The ID token was signed with a key the provider does not publish.' };
    }
    let ok = false;
    try {
      const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
      ok = crypto.verify('sha256', Buffer.from(parts[0] + '.' + parts[1]), key, Buffer.from(parts[2], 'base64url'));
    } catch (e) { return { ok: false, error: 'Could not verify the ID token: ' + e.message }; }
    if (!ok) return { ok: false, error: 'The ID token signature is invalid.' };
    const now = Math.floor(Date.now() / 1000);
    if (typeof claims.exp !== 'number' || claims.exp + 60 < now) return { ok: false, error: 'The ID token has expired.' };
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(p.clientId)) return { ok: false, error: 'The ID token was not issued for this app.' };
    const issOk = p.issuers.some((i) => (i instanceof RegExp ? i.test(String(claims.iss || '')) : i === claims.iss));
    if (!issOk) return { ok: false, error: 'The ID token issuer is not ' + p.name + '.' };
    if (nonce && claims.nonce !== nonce) return { ok: false, error: 'The ID token nonce does not match this sign-in.' };
    if (p.name === 'azure' && p.pinned && String(claims.tid || '').toLowerCase() !== p.pinned) {
      return { ok: false, error: 'The account is not in the configured Microsoft 365 organisation.' };
    }
    log.info('sso id token verified', { provider: p.name });
    return { ok: true, claims };
  }
}
