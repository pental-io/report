// WHERE THE PORTAL ASKS PENTAL'S SERVERS, REPORTER ASKS ITS OWN.
//
// Three things in Pental's portal go through Pental: a logo is stored on
// Pental's side so the sign-in page can show it, AI without a key of the
// firm's own uses Pental's AI service, and an invitation is emailed. Here
// the logo goes into Pental Report's own storage, AI always uses the firm's
// own provider and key (sent from its server), and an invitation is a
// link the administrator passes on. And a security key, which the database
// checks itself, is offered only where that check can pass: over HTTPS.
//
// SPDX-License-Identifier: AGPL-3.0-only

// ── Logos and the favicon ────────────────────────────────────────────────
// Into the branding bucket, which anyone may read (the sign-in page needs the
// logo before anybody signs in) and only an administrator may write.
async function _uploadBranding(kind, dataUrl) {
  var m = /^data:([^;,]+)(;base64)?,(.*)$/.exec(String(dataUrl || ''));
  if (!m) throw new Error('That image could not be read');
  var type = m[1];
  var raw = m[2] ? atob(m[3]) : decodeURIComponent(m[3]);
  var bytes = new Uint8Array(raw.length);
  for (var i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  var ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/svg+xml': 'svg', 'image/webp': 'webp', 'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico', 'image/gif': 'gif' }[type] || 'bin';
  var path = String(kind || 'logo').replace(/[^a-z0-9-]/gi, '') + '-' + Date.now().toString(36) + '.' + ext;
  var up = await supabaseClient.storage.from('branding').upload(path, new Blob([bytes], { type: type }), { upsert: true, contentType: type });
  if (up && up.error) throw new Error(up.error.message || 'The upload was refused');
  return EFFECTIVE_SUPABASE_URL + '/storage/v1/object/public/branding/' + encodeURIComponent(path);
}

// ── AI: the firm's own provider, from Pental Report's server ───────────────────
// The portal falls back to Pental's AI service when a firm has no key of its
// own. Pental Report has no such service: without a key it says what to do.
async function _aiFirmSide(provider) {
  var side = await _aiFirmSide__portal(provider);
  if (side === false) {
    var e = new Error(_forPeople('AI needs a provider and a key of your own. An administrator saves them in Settings, AI, '
      + 'and Pental Report then sends each request from its own server straight to that provider.'));
    e.status = 409;
    e.firmSide = true;
    e.noKey = true;
    throw e;
  }
  return side;
}
function _aiRouteText(cap, provider, unknown) {
  if (unknown) return 'With a key saved, requests go from this server straight to the provider, so neither the key nor what is asked passes through anyone else.';
  var own = _aiOwn(cap, provider);
  if (own && cap && cap.local) return 'Its requests go from this server straight to the provider, so neither the key nor what is asked passes through anyone else.';
  if (own) return 'This server cannot send AI requests just now. Check that it can reach the provider, then try again.';
  return 'Save a key to turn AI on. Requests then go from this server straight to the provider.';
}

// ── Security keys need HTTPS ─────────────────────────────────────────────
// The database checks a security key's signature itself, and accepts it only
// from an https:// page on the key's own site, as Pental's portal does. Served
// over plain HTTP (a trial on localhost, or a bare address), Pental Report offers
// the authenticator app alone, rather than a key the database would refuse.
function _rpKeysOk() { return window.location.protocol === 'https:'; }
function _rpNoKeys(profile) {
  if (_rpKeysOk() || !profile || !profile.mfa_methods) return profile;
  profile.mfa_methods.allowed = Object.assign({ totp: true }, profile.mfa_methods.allowed || {}, { webauthn: false });
  return profile;
}
async function _loadMfaPolicy() {
  var p = await _loadMfaPolicy__portal();
  if (!_rpKeysOk() && p && p.methods_allowed) p.methods_allowed = Object.assign({}, p.methods_allowed, { webauthn: false });
  return p;
}
// Each way the portal reads a person's methods: at sign-in, and whenever the
// profile is loaded again (the profile's Security card draws from it).
async function _fetchProfile(email, authUserId) {
  return _rpNoKeys(await _fetchProfile__portal(email, authUserId));
}
async function loadProfile() {
  var r = await loadProfile__portal.apply(this, arguments);
  _rpNoKeys(S.profile);
  return r;
}

// Said where a person looks for one: over plain HTTP the authenticator app
// is the only second factor, and a passkey or security key comes once Pental
// Report is served over HTTPS ([stated] Arian: "why is there no passkey
// options? i can only see authenticator").
var _RP_KEYS_NOTE = 'Passkeys and security keys work once Pental Report is served over HTTPS, shared over Tailscale or on your own domain. Add one from your profile then.';
// The authenticator's setup screen gets it from _reporterTidy (shell/70),
// which sees every page drawn; the profile from its own wrap here.
function _rpKeysNoteOnSetup() {
  if (_rpKeysOk()) return;
  var body = document.querySelector('#app .login-card .card-body');
  if (!body || body.querySelector('.rp-keys-note') || !document.getElementById('mfaTotpInput')) return;
  var t = (body.querySelector('.login-title') || {}).textContent || '';
  if (!/authenticator/i.test(t)) return;
  var p = document.createElement('p');
  p.className = 'rp-keys-note';
  p.textContent = _RP_KEYS_NOTE;
  body.appendChild(p);
}
function renderMyProfile() {
  var h = renderMyProfile__portal.apply(this, arguments);
  if (_rpKeysOk() || typeof h !== 'string') return h;
  return h + '<div class="card mt-4 rp-keys-card"><div class="card-body"><p class="rp-note" style="margin:0">' + esc(_RP_KEYS_NOTE) + '</p></div></div>';
}

// ── Invitations and password links ───────────────────────────────────────
// Pental Report sends no email, so its server hands back the link a person uses
// to choose their password; it is shown here to copy and pass on.
async function adminApi(action, data, opts) {
  var result = await adminApi__portal(action, data, opts);
  if (result && result.link && result.invite === 'link') {
    var who = (data && data.email) || ((S.data.users || []).find(function (u) { return data && u.id === data.user_id; }) || {}).email || '';
    _reporterShowLink(who, result.link, result.expires);
  }
  return result;
}

function _reporterShowLink(email, link, expires) {
  var old = document.getElementById('rpLinkBox');
  if (old) old.remove();
  var box = document.createElement('div');
  box.id = 'rpLinkBox';
  box.className = 'rp-linkbox';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.setAttribute('aria-labelledby', 'rpLinkTitle');
  box.innerHTML = '<div class="rp-linkbox-card">'
    + '<h2 id="rpLinkTitle" class="rp-h1">Send ' + esc(email || 'them') + ' this link</h2>'
    + '<p class="rp-note">It lets them choose a password and sign in. It works once, for ' + esc(expires || 'a limited time')
    + '. Pental Report sends no email, so pass it on the way you would any other private link.</p>'
    + '<div class="rp-linkbox-row"><input class="form-input" id="rpLinkVal" readonly value="' + esc(link) + '">'
    + '<button class="btn btn-primary" id="rpLinkCopy" type="button">Copy</button></div>'
    + '<div class="rp-linkbox-foot"><button class="btn btn-ghost" id="rpLinkDone" type="button">Done</button></div>'
    + '</div>';
  document.body.appendChild(box);
  var input = document.getElementById('rpLinkVal');
  var close = function () { box.remove(); document.removeEventListener('keydown', onKey); };
  var onKey = function (e) { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  document.getElementById('rpLinkDone').onclick = close;
  document.getElementById('rpLinkCopy').onclick = async function () {
    try { await navigator.clipboard.writeText(link); }
    catch (e) { input.select(); try { document.execCommand('copy'); } catch (x) { /* selected for a manual copy */ } }
    this.textContent = 'Copied';
  };
  input.focus();
  input.select();
}

// ── Signing in: a password, then the authenticator ───────────────────────
// Pental's sign-in page can also offer an emailed code and Google and
// Microsoft sign-in, each through Pental's servers. Pental Report sends no
// email and has no single sign-on, so its page is the email address and the
// password, then the authenticator, whatever the settings say (a backup from
// Pental carries the portal's) and before they have loaded ([stated] Arian:
// "remove the oauth google and microsoft or anything else that doesnt work
// with report").
function renderLogin() {
  var was = window._dbBranding;
  window._dbBranding = Object.assign({}, was || {}, { password_login_enabled: true, sso_google_enabled: false, sso_microsoft_enabled: false });
  try { return renderLogin__portal(); } finally { window._dbBranding = was; }
}

// ── The firm's name where it has no logo ─────────────────────────────────
// The sign-in page shows the firm's logo, or its name where it has none; the
// pages around it (a forgotten password, choosing one from a link, the second
// factor) showed the logo or nothing ([stated] Arian: "why is pw reset area
// not using branding?"). Now they show what the sign-in page shows, in the
// firm's colour, the brand loaded first when a link opens one of them.
function _authLogo() {
  var h = _authLogo__portal();
  if (_resolveLogoSrc()) return h;
  var b = window._dbBranding || {};
  if (b.login_show_company_name === false) return h;
  var name = b.company_name || (TENANT_INFO && TENANT_INFO.company_name) || '';
  return name ? h + '<span class="rp-auth-name">' + esc(name) + '</span>' : h;
}
function renderSetPassword(token) {
  renderSetPassword__portal(token);
  if (window._dbBranding && Object.keys(window._dbBranding).length) return;
  // Opened from a link, before the brand has loaded: drawn again with it,
  // keeping anything already typed.
  Promise.resolve().then(function () { return loadBrandingFromDB(); }).then(function () {
    if (!document.getElementById('pwNew')) return;
    var a = document.getElementById('pwNew').value, c = document.getElementById('pwConfirm').value;
    renderSetPassword__portal(token);
    document.getElementById('pwNew').value = a;
    document.getElementById('pwConfirm').value = c;
    try { if (a || c) checkPwPolicy(); } catch (e) { /* the checklist as drawn */ }
  }).catch(function () { /* as drawn */ });
}

// ── A forgotten password ─────────────────────────────────────────────────
// Pental Report sends no email, so a reset link cannot be asked for here: an
// administrator makes one from Team, and for the only administrator whoever
// runs the server makes one (server/bin/password-link.js).
function renderPasswordRequest() {
  var app = document.getElementById('app');
  if (!app) return;
  _suppressRender = true;
  app.innerHTML = '<div class="login-page"><div class="login-card"><div class="card-body">'
    + '<div class="login-header" style="text-align:center"><div class="login-logo">' + _authLogo() + '</div>'
    + '<h1 class="login-title">Forgotten Your Password?</h1>'
    + '<p class="login-sub">Pental Report sends no email, so ask an administrator for a new link. They make one from Team, with the password reset link beside your name.</p></div>'
    + '<p class="rp-note">The only administrator? Whoever runs this server can make one:</p>'
    + '<pre class="rp-cmd">docker compose exec report node server/bin/password-link.js you@yourfirm.com</pre>'
    + '<div style="text-align:center;margin-top:0.85rem;font-size:0.8rem"><a href="#" onclick="_backToSignIn();return false" style="color:var(--gray);text-decoration:none">Back to sign in</a></div>'
    + '</div></div></div>';
  document.body.classList.add('loaded');
}

// ── The account ──────────────────────────────────────────────────────────
// In Pental the first administrator can hand the subscription to another;
// Pental Report has no subscription to hand over.
function canHandOverTo() { return false; }

// 1975, after the first sync: [stated] Arian, of the "First administrator"
// badge on the Team page: "wtf is first administrator, do something more
// modern and beautiful there is maybe no reason to even put this here". No
// badge (the manifest's renderUsers patches); the one place it matters, a
// refusal to remove someone, names the person who set Pental Report up.
function _rpOwnerName() {
  var id = typeof _accountOwnerId === 'function' ? _accountOwnerId() : null;
  var u = id ? (S.data.users || []).find(function (x) { return String(x.id) === String(id); }) : null;
  var n = u && u.name ? String(u.name).trim().split(/\s+/)[0] : '';
  return n || '';
}
function _rpOwnerSays(what) {
  var n = _rpOwnerName();
  if (what === 'stays') {
    return n ? n + ' set Pental Report up here, so their account stays.'
      : 'The account that set Pental Report up here stays.';
  }
  return n ? 'Only ' + n + ', who set Pental Report up here, can remove another administrator.'
    : 'Only the person who set Pental Report up here can remove another administrator.';
}

// ── The backup carries the logos ─────────────────────────────────────────
// Pental Report keeps a firm's logos in its own storage (above), so its
// backup carries them too, and the portal or Pental Report restoring it puts them where
// it keeps its own (importAllData).
var _BACKUP_BUCKETS = ['assessment-files', 'avatars', 'templates', 'branding'];
