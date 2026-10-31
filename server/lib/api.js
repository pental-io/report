// THE SERVER ROUTES THE APP CALLS, ANSWERED HERE.
//
// Pental's portal has a handful of server routes (/api/admin, /api/utils)
// that are thin layers over its database: each finds the caller from their
// own session and calls the database's functions as them. Pental Report answers the
// same routes, the same way, against its own database, so the app's code is
// the portal's unchanged. Where Pental's route asks Pental to sign an
// operation, this server signs it with the keys only it holds (lib/setup.js);
// where Pental's route sends an email, this one hands back the link for the
// administrator to pass on (Pental Report sends no mail).
//
// Also here: /reporter/v1/config (what the app needs to start) and
// /reporter/v1/first-admin (the first-run page).
import crypto from 'node:crypto';
import { HttpError, readJson, sendJson, originOf } from './http.js';
import { anonKey, verifyJwt } from './jwt.js';
import { needsFirstAdmin, makeFirstAdmin } from './setup.js';
import { log } from './log.js';

const ROLE_HIERARCHY = { admin: 5, senior: 4, standard: 3 };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v) => UUID.test(String(v || ''));

export class Api {
  constructor({ cfg, db, authz, instance, version }) {
    this.cfg = cfg; this.db = db; this.authz = authz; this.instance = instance; this.version = version;
    this.anon = anonKey(cfg.jwtSecret);
    this.firstTries = new Map();
  }

  // The REST layer, as the caller, over this server's own loopback.
  async rest(token, method, path, body, prefer) {
    const headers = { apikey: this.anon, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'x-tenant-id': this.instance.tenantId };
    if (prefer) headers.Prefer = prefer;
    const r = await fetch(`http://127.0.0.1:${this.cfg.port}/rest/v1/${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    let data = null;
    const text = await r.text();
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { ok: r.ok, status: r.status, data };
  }
  rpc(token, fn, args) { return this.rest(token, 'POST', 'rpc/' + fn, args || {}); }

  caller(req) {
    const h = String(req.headers.authorization || '');
    if (!h.startsWith('Bearer ')) throw new HttpError(401, { error: 'Not authenticated' });
    const token = h.slice(7).trim();
    const v = verifyJwt(token, this.cfg.jwtSecret);
    if (!v.ok || !v.claims || v.claims.role !== 'authenticated' || !isUuid(v.claims.sub)) throw new HttpError(401, { error: 'Unauthorized' });
    return { token, id: v.claims.sub, claims: v.claims };
  }

  async me(c) {
    const r = await this.rest(c.token, 'GET', `profiles?auth_user_id=eq.${c.id}&select=id,role,email,name,active`);
    if (!r.ok || !Array.isArray(r.data) || !r.data.length) throw new HttpError(403, { error: 'Profile not found' });
    const me = r.data[0];
    if (me.active === false) throw new HttpError(403, { error: 'Account deactivated' });
    return me;
  }

  // ── /reporter/v1 ──────────────────────────────────────────────────────
  async config(req, res) {
    let first = false;
    try { first = await needsFirstAdmin(this.db); } catch { first = false; }
    let company = '';
    try { company = (await this.db.query('SELECT company_name FROM public.settings ORDER BY created_at LIMIT 1')).rows[0]?.company_name || ''; } catch { company = ''; }
    sendJson(res, 200, {
      url: originOf(req, this.cfg) || '', key: this.anon, tenant_id: this.instance.tenantId, version: this.version,
      first_run: first, company_name: company,
    }, { 'Cache-Control': 'no-store' });
  }

  async firstAdmin(req, res) {
    const ip = String(req.socket && req.socket.remoteAddress || '');
    const now = Date.now();
    const tries = (this.firstTries.get(ip) || []).filter((t) => now - t < 15 * 60 * 1000);
    if (tries.length >= 10) throw new HttpError(429, { error: 'Too many attempts. Wait a few minutes and try again.' });
    tries.push(now); this.firstTries.set(ip, tries);
    const body = (await readJson(req).catch(() => null)) || {};
    if (!this.authz.isSetupToken(String(body.setup_token || '').trim())) {
      throw new HttpError(403, { error: 'That is not this server\'s setup token. It is SETUP_TOKEN in the .env file next to docker-compose.yml.' });
    }
    if (!(await needsFirstAdmin(this.db))) throw new HttpError(409, { error: 'Pental Report already has an administrator here. Sign in instead.' });
    const out = await makeFirstAdmin(this.db, { email: body.email, name: body.name, password: body.password, company: body.company });
    if (!out.ok) return sendJson(res, out.exists ? 409 : 400, { error: out.error });
    log.info('first administrator made');
    sendJson(res, 200, { ok: true });
  }

  // ── /api/admin ────────────────────────────────────────────────────────
  // A link for the person to set or reset their password, made as Pental's
  // _signin_send_link makes one, and handed back instead of emailed.
  async passwordLink(req, profileId, purpose) {
    const token = crypto.randomBytes(32).toString('base64url');
    const reset = purpose === 'reset';
    await this.db.asOwner(async (c) => {
      await c.query('UPDATE public.password_setup_tokens SET used_at = now() WHERE profile_id = $1 AND used_at IS NULL', [profileId]);
      await c.query(`INSERT INTO public.password_setup_tokens (profile_id, token_hash, purpose, expires_at, issued_here)
        VALUES ($1, encode(extensions.digest(convert_to($2, 'UTF8'), 'sha256'), 'hex'), $3, now() + $4::interval, true)`,
      [profileId, token, reset ? 'reset' : 'set', reset ? '1 hour' : '72 hours']);
    });
    return { link: (originOf(req, this.cfg) || '') + '/#pw_token=' + token, expires: reset ? '1 hour' : '72 hours' };
  }

  async ownerId(token) {
    const st = await this.rest(token, 'GET', 'settings?select=account_owner_id&limit=1');
    const stamped = st.ok && Array.isArray(st.data) && st.data[0] ? st.data[0].account_owner_id : null;
    if (stamped) {
      const p = await this.rest(token, 'GET', `profiles?id=eq.${stamped}&role=eq.admin&active=eq.true&select=id&limit=1`);
      if (p.ok && Array.isArray(p.data) && p.data.length) return p.data[0].id;
    }
    const f = await this.rest(token, 'GET', 'profiles?role=eq.admin&active=eq.true&select=id&order=created_at.asc&limit=1');
    return f.ok && Array.isArray(f.data) && f.data[0] ? f.data[0].id : null;
  }

  async admin(req, res) {
    if (req.method !== 'POST') throw new HttpError(405, { error: 'Method not allowed' });
    const c = this.caller(req);
    const me = await this.me(c);
    const { action, ...body } = (await readJson(req).catch(() => null)) || {};
    const signed = (op) => ({ p_auth: this.instance.envelope(op), p_secret: this.instance.provisionSecret });
    switch (action) {
      case 'invite_user': {
        const email = String(body.email || '').trim();
        const { name, role } = body;
        if (!email || !name || !role) return sendJson(res, 400, { error: 'Email, name, and role are required' });
        if (!Object.prototype.hasOwnProperty.call(ROLE_HIERARCHY, role)) return sendJson(res, 400, { error: 'Pental Report has administrators, seniors and testers. Client and external accounts are in Pental.' });
        if (!['admin', 'senior'].includes(me.role)) return sendJson(res, 403, { error: 'Only admins and seniors can create users' });
        if ((ROLE_HIERARCHY[role] || 0) > (ROLE_HIERARCHY[me.role] || 0)) return sendJson(res, 403, { error: 'Cannot create user with higher privileges' });
        const r = await this.rpc(c.token, 'rpc_create_auth_user', { p_email: email, p_name: name, p_role: role });
        if (!r.ok || (r.data && r.data.error)) return sendJson(res, 400, { error: (r.data && (r.data.error || r.data.message)) || 'The account could not be made.' });
        const link = await this.passwordLink(req, r.data.user_id, 'set');
        return sendJson(res, 200, { success: true, user_id: r.data.user_id, invite: 'link', link: link.link, expires: link.expires,
          message: 'Account made. Send ' + email + ' this link to choose their password (it works for ' + link.expires + ').' });
      }
      case 'resend_invite':
      case 'send_password_setup':
      case 'send_password_reset': {
        const { user_id } = body;
        if (!isUuid(user_id)) return sendJson(res, 400, { error: 'Invalid user_id format' });
        if (!['admin', 'senior'].includes(me.role)) return sendJson(res, 403, { error: 'Only admins and seniors can send these' });
        const t = await this.rest(c.token, 'GET', `profiles?id=eq.${user_id}&select=id,email,active`);
        if (!t.ok || !Array.isArray(t.data) || !t.data.length) return sendJson(res, 404, { error: 'User not found' });
        if (t.data[0].active === false) return sendJson(res, 400, { error: 'This account is deactivated' });
        const link = await this.passwordLink(req, user_id, action === 'send_password_reset' ? 'reset' : 'set');
        return sendJson(res, 200, { success: true, invite: 'link', link: link.link, expires: link.expires,
          message: 'Send ' + t.data[0].email + ' this link (it works for ' + link.expires + '): ' + link.link });
      }
      case 'update_user_role': {
        const { user_id, role } = body;
        if (!isUuid(user_id) || !role) return sendJson(res, 400, { error: 'user_id and role are required' });
        if (!Object.prototype.hasOwnProperty.call(ROLE_HIERARCHY, role)) return sendJson(res, 400, { error: 'Invalid role' });
        if (!['admin', 'senior'].includes(me.role)) return sendJson(res, 403, { error: 'Only admins and seniors can change roles' });
        const t = await this.rest(c.token, 'GET', `profiles?id=eq.${user_id}&select=id,role`);
        if (!t.ok || !Array.isArray(t.data) || !t.data.length) return sendJson(res, 404, { error: 'User not found' });
        const owner = await this.ownerId(c.token);
        const byOwner = !!owner && String(me.id) === String(owner);
        if (String(user_id) === String(me.id)) return sendJson(res, 403, { error: 'You cannot change your own role' });
        if (owner && String(user_id) === String(owner)) return sendJson(res, 403, { error: 'The role of the person who set Pental Report up stays as it is.' });
        const level = ROLE_HIERARCHY[me.role] || 0;
        if (!byOwner && t.data[0].role === 'admin') return sendJson(res, 403, { error: 'Only the person who set Pental Report up here can change another administrator\'s role.' });
        if (!byOwner && (ROLE_HIERARCHY[t.data[0].role] || 0) >= level) return sendJson(res, 403, { error: 'Cannot modify users with equal or higher roles' });
        if ((ROLE_HIERARCHY[role] || 0) > level) return sendJson(res, 403, { error: 'Cannot assign a role higher than your own' });
        const u = await this.rest(c.token, 'PATCH', `profiles?id=eq.${user_id}&select=id`, { role }, 'return=representation');
        if (!u.ok || !Array.isArray(u.data) || !u.data.length) return sendJson(res, 400, { error: 'Failed to update role' });
        return sendJson(res, 200, { success: true, message: 'Role updated' });
      }
      case 'delete_user': {
        const { user_id } = body;
        if (!isUuid(user_id)) return sendJson(res, 400, { error: 'Invalid user_id format' });
        if (!['admin', 'senior'].includes(me.role)) return sendJson(res, 403, { error: 'Not authorized' });
        const t = await this.rest(c.token, 'GET', `profiles?id=eq.${user_id}&select=id,role,auth_user_id`);
        if (!t.ok || !Array.isArray(t.data) || !t.data.length) return sendJson(res, 404, { error: 'User not found' });
        const owner = await this.ownerId(c.token);
        const isOwner = !!owner && String(me.id) === String(owner);
        if (!isOwner && (ROLE_HIERARCHY[t.data[0].role] || 0) >= (ROLE_HIERARCHY[me.role] || 0)) return sendJson(res, 403, { error: 'Cannot delete users with equal or higher roles' });
        if (owner && String(user_id) === String(owner)) return sendJson(res, 403, { error: 'The account that set Pental Report up here stays.' });
        const d = await this.rpc(c.token, 'rpc_admin_delete_profile', { p_profile_id: user_id, p_force: body.force === true });
        const out = (d.ok && d.data) || {};
        if (out.ok !== true) {
          const why = out.reason;
          if (why === 'not_authorised') return sendJson(res, 403, { error: 'You need admin access and a recent MFA check to delete users.' });
          if (why === 'owner') return sendJson(res, 403, { error: 'The account that set Pental Report up here stays.' });
          if (why === 'rank') return sendJson(res, 403, { reason: 'rank', error: 'Only the person who set Pental Report up here can remove another administrator.' });
          if (why === 'not_found') return sendJson(res, 404, { error: 'User not found' });
          if (why === 'referenced') return sendJson(res, 409, { error: `Deleting this user will also remove records that cannot exist without them: ${(out.blocked_by || []).join(', ') || 'another record'}.`, can_force: true, blocked_by: out.blocked_by || [] });
          return sendJson(res, 500, { error: 'Delete failed and the account was not removed.' });
        }
        const authId = t.data[0].auth_user_id;
        if (authId) {
          const left = await this.rest(c.token, 'GET', `profiles?auth_user_id=eq.${authId}&select=id&limit=1`);
          if (left.ok && Array.isArray(left.data) && !left.data.length) {
            await this.rpc(c.token, 'rpc_hard_delete_auth_user', { p_auth_id: authId, p_secret: this.instance.provisionSecret }).catch(() => null);
          }
        }
        return sendJson(res, 200, { success: true, message: 'User deleted' });
      }
      case 'update_user_email': {
        const { user_id } = body;
        const typed = String(body.email || '').trim();
        const next = typed.toLowerCase();
        if (!isUuid(user_id) || !typed) return sendJson(res, 400, { error: 'user_id and email are required' });
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(next) || next.length > 254) return sendJson(res, 400, { error: 'That does not look like an email address' });
        const t = await this.rest(c.token, 'GET', `profiles?id=eq.${user_id}&select=id,role,email,auth_user_id`);
        if (!t.ok || !Array.isArray(t.data) || !t.data.length) return sendJson(res, 404, { error: 'User not found' });
        const target = t.data[0];
        if (String(target.email || '') === typed) return sendJson(res, 200, { success: true, message: 'That is already their address' });
        if (!['admin', 'senior'].includes(me.role)) return sendJson(res, 403, { error: 'Only an administrator or senior can change an email address' });
        if (String(target.email || '').toLowerCase() === next) {
          const u = await this.rest(c.token, 'PATCH', `profiles?id=eq.${user_id}&select=id`, { email: typed }, 'return=representation');
          if (!u.ok || !Array.isArray(u.data) || !u.data.length) return sendJson(res, 400, { error: 'Could not update the address. Nothing was changed.' });
          return sendJson(res, 200, { success: true, message: 'Email address updated', email: typed, case_only: true });
        }
        const isSelf = String(user_id) === String(me.id);
        const owner = await this.ownerId(c.token);
        const isOwner = !!owner && String(me.id) === String(owner);
        if (!isSelf) {
          if (me.role === 'senior' && target.role === 'senior') return sendJson(res, 403, { error: 'You cannot change the email address of another senior' });
          if (target.role === 'admin' && !isOwner) return sendJson(res, 403, { error: 'Only the person who set Pental Report up here can change another administrator\'s email address.' });
        }
        const m = await this.rpc(c.token, 'rpc_admin_change_sign_in_email', { p_profile_id: user_id, p_email: typed, ...signed('rpc_admin_change_sign_in_email') });
        const moved = (m.ok && m.data) || {};
        if (moved.ok !== true) {
          const why = moved.reason;
          if (why === 'taken') return sendJson(res, 409, { error: 'Another account already signs in with that address' });
          if (why === 'not_authorised') return sendJson(res, 403, { error: 'You need admin or senior access and a recent MFA check to change a sign-in address.' });
          if (why === 'owner_only') return sendJson(res, 403, { error: 'Only the person who set Pental Report up here can change another administrator\'s email address.' });
          if (why === 'rank') return sendJson(res, 403, { error: 'You cannot change the email address of another senior' });
          if (why === 'not_found') return sendJson(res, 404, { error: 'User not found' });
          return sendJson(res, 500, { error: 'Could not change the sign-in address. Nothing was changed.' });
        }
        return sendJson(res, 200, { success: true, message: 'Email address updated', email: typed, notified: false });
      }
      case 'invite_client_user':
      case 'claim_account_owner':
        return sendJson(res, 200, { success: false, reason: 'not_in_reporter', error: 'Client accounts and billing are in Pental, not Pental Report.' });
      default:
        return sendJson(res, 400, { error: 'Unknown action: ' + action });
    }
  }

  // ── /api/utils ────────────────────────────────────────────────────────
  async utils(req, res, url) {
    const fn = url.searchParams.get('fn');
    if (fn === 'sessions') return this.sessions(req, res);
    if (fn === 'usage') return sendJson(res, 200, { ok: true, usage: {} });
    if (fn === 'env-check') return sendJson(res, 200, { ok: true });
    // 1977: links are not checked from a firm's own server, which would mean
    // fetching whatever addresses an AI reply names from inside its network.
    // An empty list here read as "none of them work", so the references a
    // finding's Generate, Generate all and the library's Generate all wrote
    // were all dropped: no answer is an answer the app keeps every link on.
    if (fn === 'check-urls') return sendJson(res, 501, { error: 'Pental Report does not check links' });
    return sendJson(res, 404, { error: 'Not part of Pental Report' });
  }

  async sessions(req, res) {
    if (req.method !== 'POST') throw new HttpError(405, { error: 'Method not allowed' });
    const c = this.caller(req);
    const me = await this.me(c);
    const current = c.claims.session_id || null;
    const b = (await readJson(req).catch(() => null)) || {};
    if (b.action === 'register') {
      if (!b.auth_session_id || String(b.auth_session_id).length < 8) return sendJson(res, 400, { error: 'Valid auth_session_id required' });
      if (current && b.auth_session_id !== current) return sendJson(res, 400, { error: 'Session id mismatch' });
      const ip = String((req.headers['x-forwarded-for'] || '').split(',')[0] || (req.socket && req.socket.remoteAddress) || '').trim() || null;
      const r = await this.rpc(c.token, 'rpc_session_register', { p_auth_session_id: b.auth_session_id, p_ip: ip,
        p_user_agent: typeof b.user_agent === 'string' ? b.user_agent.slice(0, 500) : null, p_device_label: typeof b.device_label === 'string' ? b.device_label.slice(0, 100) : null,
        p_expires_at: typeof b.expires_at === 'string' && b.expires_at.length < 40 ? b.expires_at : null });
      if (!r.ok || (r.data && r.data.error)) return sendJson(res, 500, { error: 'Register failed' });
      return sendJson(res, 200, { success: true, result: r.data });
    }
    if (b.action === 'touch') {
      if (!b.auth_session_id) return sendJson(res, 400, { error: 'auth_session_id required' });
      const r = await this.rpc(c.token, 'rpc_session_touch', { p_auth_session_id: b.auth_session_id });
      return sendJson(res, 200, { success: r.ok });
    }
    if (b.action === 'revoke_current') {
      if (!current) return sendJson(res, 200, { success: false });
      const f = await this.rest(c.token, 'GET', `user_sessions?auth_session_id=eq.${encodeURIComponent(current)}&select=id&limit=1`);
      if (!f.ok || !Array.isArray(f.data) || !f.data.length) return sendJson(res, 200, { success: true, skipped: true });
      await this.rpc(c.token, 'rpc_session_revoke', { p_session_id: f.data[0].id, p_reason: 'logout' });
      return sendJson(res, 200, { success: true });
    }
    if (b.action === 'list') {
      let target = me.id, own = true;
      if (b.target_profile_id && isUuid(b.target_profile_id) && b.target_profile_id !== me.id) {
        if (!['admin', 'senior'].includes(me.role)) return sendJson(res, 403, { error: 'Only admins and senior users can view other users\' sessions' });
        target = b.target_profile_id; own = false;
      }
      const r = await this.rest(c.token, 'GET', `user_sessions?profile_id=eq.${target}&select=id,auth_session_id,ip,user_agent,device_label,first_seen_at,last_active_at,expires_at,revoked_at&order=last_active_at.desc`);
      if (!r.ok) return sendJson(res, 500, { error: 'Failed to load sessions' });
      return sendJson(res, 200, { sessions: (Array.isArray(r.data) ? r.data : []).map((x) => ({ id: x.id, ip: x.ip || null, user_agent: x.user_agent || null,
        device_label: x.device_label || null, first_seen_at: x.first_seen_at, last_active_at: x.last_active_at, expires_at: x.expires_at, revoked_at: x.revoked_at,
        is_current: !!(current && x.auth_session_id === current), is_own: own })) });
    }
    if (b.action === 'revoke') {
      if (!isUuid(b.session_id)) return sendJson(res, 400, { error: 'Valid session_id required' });
      const o = await this.rest(c.token, 'GET', `user_sessions?id=eq.${b.session_id}&select=profile_id&limit=1`);
      if (!o.ok || !Array.isArray(o.data) || !o.data.length) return sendJson(res, 404, { error: 'Session not found' });
      if (o.data[0].profile_id !== me.id && !['admin', 'senior'].includes(me.role)) return sendJson(res, 403, { error: 'Not your session' });
      const r = await this.rpc(c.token, 'rpc_session_revoke', { p_session_id: b.session_id, p_reason: 'user' });
      return sendJson(res, 200, { success: !!(r.ok && r.data) });
    }
    if (b.action === 'revoke_others') {
      if (!current) return sendJson(res, 400, { error: 'No current session context' });
      const r = await this.rpc(c.token, 'rpc_session_revoke_others', { p_current_auth_session_id: current });
      return sendJson(res, 200, { success: r.ok, revoked_count: typeof r.data === 'number' ? r.data : 0 });
    }
    return sendJson(res, 400, { error: 'Unknown action' });
  }
}
