// A SECOND FACTOR WHERE THE FIRM ASKS FOR ONE (0.1.52).
//
// Pental's portal asks everyone for a second factor. Pental Report asks where
// an administrator requires one (Settings, Security: Require a second
// factor), off on a new install and on for an install that was already
// running when it updated to 0.1.52 (db/overlay.sql). With it off, a password
// is enough for anyone who has not set up a second factor of their own:
// right after their password, the database records their session as fresh
// (rpc_report_password_enough), as a code would, so every rule that reads
// freshness holds for it (how long a session lasts idle, a day at most).
// Anyone who has set up an authenticator or a passkey still proves it, and
// anyone can add one from their profile. A session an API key signed in is
// never a password's (server/lib/auth records it as the key's).
//
// The portal's own sign-in, reload and second-factor screens are kept; four
// of its functions are wrapped (reporter-build/manifest.mjs): a person a
// password is enough for has nothing left to set up, their new session is not
// stale once the database has recorded it, and a session of theirs that has
// lapsed asks for their password again rather than for a second factor.
//
// SPDX-License-Identifier: AGPL-3.0-only

var _rpMfaReq = null;      // the firm's choice as last read: true, false, or null (not read)
var _rpPwFresh = false;    // set by a password sign-in the database has just recorded as fresh

async function _rpMfaRequiredNow() {
  try {
    var r = await supabaseClient.rpc('rpc_report_mfa_required');
    if (r && !r.error && typeof r.data === 'boolean') _rpMfaReq = r.data;
  } catch (e) { /* unknown is required */ }
  return _rpMfaReq;
}

// A person a password is enough for: the firm does not require a second
// factor, and they have set none up.
function _rpPasswordOnly(prof, policy) {
  var req = policy && typeof policy.required === 'boolean' ? policy.required : (_rpMfaReq === false ? false : true);
  if (req !== false) return false;
  var pr = prof || S._mfaProfile || S.profile;
  return !!pr && !_mfaHasEnrolled(pr);
}

// Nothing left to set up for them; anyone else, as the portal says.
function _mfaEnrolmentIncomplete(prof, policy) {
  if (_rpPasswordOnly(prof, policy)) return false;
  return _mfaEnrolmentIncomplete__portal(prof, policy);
}

// After the password: where it is enough, the database records this session
// as fresh first; the portal's own path then goes straight in.
async function _afterCredentialLogin() {
  _rpPwFresh = false;
  if (S.profile) {
    var pol = null;
    try { pol = await _loadMfaPolicy(); } catch (e) { pol = null; }
    if (pol) S._mfaPolicy = pol;
    if (_rpPasswordOnly(S.profile, pol)) {
      var r = null;
      try { r = await supabaseClient.rpc('rpc_report_password_enough'); } catch (e) { r = null; }
      if (r && !r.error && r.data && r.data.ok === true) _rpPwFresh = true;
    }
  }
  return _afterCredentialLogin__portal.apply(this, arguments);
}

// A new session is stale (asks for the second factor) unless the database has
// just recorded it as fresh from the password; this browser then records it
// as a code would, which every later check reads.
function _mfaNewSession() {
  var stale = _mfaNewSession__portal.apply(this, arguments);
  if (!_rpPwFresh) return stale;
  _rpPwFresh = false;
  try { localStorage.setItem('pental_mfa_verified', String(Date.now())); } catch (e) {}
  return false;
}

// Where the portal would ask somebody with nothing set up to set up a second
// factor, and none is required: their session has lapsed, so they sign in
// again with their password.
function renderMfaSetup() {
  if (_rpPasswordOnly(S._mfaProfile || S.profile, S._mfaPolicy)) {
    _rpSignInAgain();
    return;
  }
  return renderMfaSetup__portal.apply(this, arguments);
}
var _rpSigningOut = false;
function _rpSignInAgain() {
  if (_rpSigningOut) return;
  _rpSigningOut = true;
  try { _saySignedOut('Your session has ended. Sign in again with your password.', 'info'); } catch (e) {}
  Promise.resolve().then(function () { return logout(); }).catch(function () {}).then(function () { _rpSigningOut = false; });
}

// The API's keys are made and shown within ten minutes of a second factor
// (rpc_api_key_create, rpc_api_keys_mine): for somebody with none, of their
// password. Past that, they sign in again rather than being asked for a code
// they do not have.
function _apiConfirmFactor(said) {
  if (_rpPasswordOnly(S.profile, S._mfaPolicy)) {
    try { _saySignedOut('Sign in again with your password to carry on: keys are made and shown within ten minutes of signing in.', 'info'); } catch (e) {}
    Promise.resolve().then(function () { return logout(); }).catch(function () {});
    return;
  }
  return _apiConfirmFactor__portal.apply(this, arguments);
}

// ── Settings, Security: Require a second factor ──────────────────────────
function _rpMfaReqWords(on) {
  return on
    ? 'Everyone sets up an authenticator app (or a passkey or security key, once Pental Report is served over HTTPS) and proves it when they sign in.'
    : 'A password is enough for anyone who has not set up a second factor. Anyone who has set one up still proves it, and anybody can add one from their profile.';
}
// An administrator's switch, at the head of the second-factor settings. It is
// saved as soon as it is changed, not with the fields below it.
function _rpMfaSwitchHtml() {
  if (!(S.profile && S.profile.role === 'admin')) {
    // Settings is an administrator's page; drawn for anybody else, it says
    // what is asked and who changes it.
    return '<div class="rp-mfa-req-said" style="font-size:0.78rem;color:var(--gray);margin-bottom:0.75rem;line-height:1.55">'
      + esc(_rpMfaEnforcementWords()) + ' An administrator changes this.</div>';
  }
  var on = _rpMfaReq !== false;
  if (_rpMfaReq === null) setTimeout(function () { _rpMfaRequiredNow().then(_rpMfaSwitchPaint); }, 0);
  return '<div class="rp-mfa-req" style="margin-bottom:1rem;padding:0.85rem;border:1px solid var(--border);border-radius:8px;background:var(--hover)">'
    + '<label class="tpl-toggle" style="display:inline-flex;align-items:center;gap:0.55rem;cursor:pointer">'
    + '<input type="checkbox" id="rpMfaRequired"' + (on ? ' checked' : '') + ' onchange="_rpMfaSwitch(this)">'
    + '<span class="tpl-toggle-track"></span>'
    + '<span style="font-size:0.86rem;font-weight:700;color:var(--text)">Require a second factor</span></label>'
    + '<div id="rpMfaReqNote" style="font-size:0.76rem;color:var(--gray);line-height:1.55;margin-top:0.45rem">' + esc(_rpMfaReqWords(on)) + '</div>'
    + '<div style="font-size:0.7rem;color:var(--gray);margin-top:0.35rem">Saved as soon as it is changed.</div>'
    + '</div>';
}
function _rpMfaSwitchPaint() {
  var box = document.getElementById('rpMfaRequired');
  var note = document.getElementById('rpMfaReqNote');
  var on = _rpMfaReq !== false;
  if (box) box.checked = on;
  if (note) note.textContent = _rpMfaReqWords(on);
}
async function _rpMfaSwitch(el) {
  var want = !!(el && el.checked);
  if (el) el.disabled = true;
  try {
    var r = await supabaseClient.rpc('rpc_report_set_mfa_required', { p_on: want });
    if (r && r.error) throw r.error;
    _rpMfaReq = want;
    if (S._mfaPolicy) S._mfaPolicy.required = want;
    toast(want
      ? 'A second factor is now required. Anyone without one sets one up the next time they sign in.'
      : 'A second factor is now optional. A password is enough for anyone who has not set one up.', 'success');
  } catch (e) {
    toast('Whether a second factor is required could not be changed: ' + ((e && e.message) || e), 'error');
  } finally {
    if (el) el.disabled = false;
    _rpMfaSwitchPaint();
  }
}
// What is asked, for a page drawn for somebody who is not an administrator.
function _rpMfaEnforcementWords() {
  return _rpMfaReq === false
    ? 'A second factor is optional here: a password is enough for anyone who has not set one up, and anyone can add one from their profile.'
    : 'A second factor is required for every account.';
}
