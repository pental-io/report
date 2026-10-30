// WHERE THE DATABASE IS, AND THE FIRST-RUN PAGE.
//
// Pental's portal asks Pental's directory which firm it is and where that
// firm's database is. Pental Report's database is its own server's, at the
// same address as the page: the server says so (/reporter/v1/config), with
// the publishable key and this instance's id. A server with no administrator
// yet shows the first-run page instead of signing in.
//
// SPDX-License-Identifier: AGPL-3.0-only

async function _reporterConfig() {
  if (REPORTER.config) return REPORTER.config;
  var r = await fetch('/reporter/v1/config', { cache: 'no-store', credentials: 'same-origin' });
  if (!r.ok) throw new Error('The Pental Report server did not answer (' + r.status + ')');
  REPORTER.config = await r.json();
  return REPORTER.config;
}

async function resolveTenant() {
  var c;
  try { c = await _reporterConfig(); } catch (e) {
    _reporterFatal('Pental Report could not reach its server', String(e && e.message || e));
    return new Promise(function () {});
  }
  TENANT_ID = c.tenant_id;
  TENANT_INFO = {
    tenant_id: c.tenant_id, company_name: c.company_name || '', subdomain: 'report', status: 'active', deployment_status: 'active',
    plan: 'report', is_byo: true, byo_url: c.url || window.location.origin, byo_key: c.key,
  };
  EFFECTIVE_SUPABASE_URL = TENANT_INFO.byo_url;
  EFFECTIVE_SUPABASE_KEY = c.key;
  _byoRefused = false;
  if (c.first_run) {
    _reporterFirstRun(c);
    // The portal's start-up waits here: there is nobody to sign in yet.
    return new Promise(function () {});
  }
  return TENANT_INFO;
}

function _reporterFatal(title, detail) {
  document.body.classList.add('loaded');
  document.getElementById('app').innerHTML = '<div class="rp-center"><div class="rp-card"><h1 class="rp-h1">' + esc(title) + '</h1>'
    + '<p class="rp-note">' + esc(detail) + '</p><p class="rp-note">Check the server is running (<code>docker compose ps</code>) and reload this page.</p></div></div>';
}

// ── First run ───────────────────────────────────────────────────────────
// The setup token, the firm's name and the first administrator's account.
// The firm's logo, colours and theme are set afterwards in Settings,
// Branding ([stated] Arian: "just remove the branding options in the initial
// setup they can just do it in the portal").
//
// 1975, after the first sync: [stated] Arian, "the reporter keeps redirecting
// to this page upon opening the setup". The engine's start-up waits at
// resolveTenant while this page is up, but its branding timer still calls
// render() five seconds in, and render() drew the sign-in page over the form.
// Nothing draws over this page now.
function _reporterFirstRun(c) {
  _suppressRender = true;
  window._brandingResolved = true;
  document.body.classList.add('loaded');
  document.title = 'Set Up Pental Report';
  var h = '<div class="rp-center"><form class="rp-card" id="rpFirst" onsubmit="_reporterFirstSubmit(event)" autocomplete="on" novalidate>'
    + '<div class="rp-brand">' + _reporterLockup(26) + '</div>'
    + '<h1 class="rp-h1">Set Up Pental Report</h1>'
    + '<p class="rp-note">You are the first person here, so you will be its administrator. You can add your team once you are in.</p>'
    + '<label class="form-label" for="rpToken">Setup token</label>'
    + '<input class="form-input" id="rpToken" name="setup_token" required autocomplete="off" spellcheck="false" placeholder="prs_...">'
    + '<p class="rp-hint">The installer showed it, and it is SETUP_TOKEN in the <code>.env</code> file beside <code>docker-compose.yml</code>. It proves you run this server.</p>'
    + '<label class="form-label" for="rpCompany">Your firm</label>'
    + '<input class="form-input" id="rpCompany" name="company" required maxlength="160" autocomplete="organization" placeholder="Firm name, as your reports name it">'
    + '<label class="form-label" for="rpName">Your name</label>'
    + '<input class="form-input" id="rpName" name="name" required maxlength="120" autocomplete="name">'
    + '<label class="form-label" for="rpEmail">Email</label>'
    + '<input class="form-input" id="rpEmail" name="email" type="email" required autocomplete="email">'
    + '<label class="form-label" for="rpPw">Password</label>'
    + '<input class="form-input" id="rpPw" name="password" type="password" required minlength="12" autocomplete="new-password">'
    + '<p class="rp-hint">At least 12 characters. When you first sign in you set up a second factor: an authenticator app, or a security key once Pental Report is served over HTTPS.</p>'
    + '<label class="form-label" for="rpPw2">Password again</label>'
    + '<input class="form-input" id="rpPw2" type="password" required minlength="12" autocomplete="new-password">'
    + '<p class="rp-error" id="rpErr" role="alert" hidden></p>'
    + '<button class="btn btn-primary rp-wide" id="rpGo" type="submit">Create my account</button>'
    + '<p class="rp-hint rp-after">Your logo, colours and theme are set in Settings, Branding, once you are in.</p>'
    + '</form></div>';
  document.getElementById('app').innerHTML = h;
  // The installer opens this page with the setup token after a # (never sent
  // to the server, and taken off the address at once), so it is filled in.
  var _given = '';
  try {
    var _m = /(?:^|[#&])setup=([A-Za-z0-9_-]{24,})/.exec(window.location.hash || '');
    if (_m) { _given = _m[1]; history.replaceState(null, '', window.location.pathname + window.location.search); }
  } catch (e) {}
  if (_given) document.getElementById('rpToken').value = _given;
  try { document.getElementById(_given ? 'rpCompany' : 'rpToken').focus(); } catch (e) {}
}

function _rpSay(msg) {
  var err = document.getElementById('rpErr');
  if (!err) return;
  err.textContent = msg || '';
  err.hidden = !msg;
}

async function _reporterFirstSubmit(ev) {
  ev.preventDefault();
  var f = document.getElementById('rpFirst');
  var go = document.getElementById('rpGo');
  var val = function (id) { return (document.getElementById(id).value || '').trim(); };
  _rpSay('');
  // The browser's own checks, said in one place.
  var bad = f.querySelector(':invalid');
  if (bad) {
    var named = { rpToken: 'Enter the setup token.', rpCompany: 'Enter your firm\'s name.', rpName: 'Enter your name.', rpEmail: 'Enter a valid email address.', rpPw: 'The password needs at least 12 characters.', rpPw2: 'Enter the password again.' };
    _rpSay(named[bad.id] || 'Fill in every field.');
    try { bad.focus(); } catch (e) {}
    return;
  }
  if (document.getElementById('rpPw').value !== document.getElementById('rpPw2').value) {
    _rpSay('The two passwords are not the same.'); return;
  }
  go.disabled = true; go.textContent = 'Creating your account';
  try {
    var r = await fetch('/reporter/v1/first-admin', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
      body: JSON.stringify({ setup_token: val('rpToken'), company: val('rpCompany'), name: val('rpName'), email: val('rpEmail'), password: document.getElementById('rpPw').value }),
    });
    var j = await r.json().catch(function () { return {}; });
    if (!r.ok) throw new Error(j.error || ('The server answered ' + r.status));
    try { sessionStorage.setItem('pental_report_new', val('rpEmail')); } catch (e) {}
    window.location.replace('/');
  } catch (e) {
    _rpSay(String(e && e.message || e));
    go.disabled = false; go.textContent = 'Create my account';
  }
  return f;
}

// Pental's mark, in Pental's red whatever the theme, and the lockup: the
// mark, PENTAL, and the product's name.
function _reporterMark(px) {
  var s = px || 24;
  return '<svg class="rp-mark" width="' + s + '" height="' + Math.round(s * 0.9) + '" viewBox="0 0 228 205" aria-hidden="true" fill="#b71c1c">'
    + '<path d="M40,0H178V32L164,44V13H48V45H14v147h151v-73l14-12v98H0V37Z"/><path d="m212.5,20.8 15.9,14.5-84.9,78.4-51.3-49.5 17.3-17.3 35.3,36.2c0,0 45.6-42 67.6-62.2z"/>'
    + '<path d="M35,155.2H151.9V168H35Z"/><path d="M34,70H72.8L84.4,82.8 34,83Z"/><path d="m34,98.1h66.5l12.5,12.8-79,0.2z"/><path d="m34,127h95.9l12.8,12.8-108.7,0.2z"/></svg>';
}
function _reporterLockup(px) {
  return _reporterMark(px) + '<span class="rp-word">PENTAL</span><span class="rp-prod">Report</span>';
}
