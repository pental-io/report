// THE REPORTER'S NAVIGATION.
//
// The portal's own sidebar, with Pental Report's pages: engagements, findings,
// the library, your profile, and for administrators the team and settings.
//
// SPDX-License-Identifier: AGPL-3.0-only

function renderSidebar() {
  var u = S.profile;
  var settings = S.data.settings || {};
  var companyName = settings.company_name || '';
  document.title = (companyName ? companyName + ' - ' : '') + 'Pental Report';
  var logo = _activeLogo(settings);
  var onAss = (S.page.indexOf('assessment') >= 0 || S.page === 'finding-detail');
  var b = function (page, active, icon, label) {
    return '<button class="nav-btn' + (active ? ' active' : '') + '" onclick="nav(\'' + page + '\')">' + icon + label + '</button>';
  };
  var h = '<aside class="sidebar"><div class="sidebar-header"><a href="#" class="logo" onclick="nav(\'assessments\');return false">';
  h += logo
    ? '<img data-themed-logo loading="eager" decoding="sync" src="' + esc(logo) + '" style="height:auto;max-height:48px;max-width:200px;object-fit:contain">'
    : (companyName ? _reporterMark(28) + '<span>' + esc(companyName) + '</span>' : _reporterLockup(26));
  h += '</a></div><nav class="nav"><div class="nav-section">';
  h += b('assessments', onAss, IC.assess || IC.doc, 'Assessments');
  h += b('all-findings', S.page === 'all-findings', IC.alert, 'Findings');
  h += b('library', S.page === 'library', IC.library, 'Library');
  h += b('my-profile', S.page === 'my-profile', IC.user, 'Profile');
  if (canManage()) h += b('users', S.page === 'users', IC.staff, 'Team');
  if (u.role === 'admin') h += b('settings', S.page === 'settings', IC.settings, 'Settings');
  h += '</div></nav>';
  // The version links to where Pental Report's source is published
  // (AGPL-3.0, section 13: a user of the network service can get its source).
  h += '<div class="rp-side-note"><a class="rp-ver" href="' + esc(REPORTER.sourceUrl) + '" target="_blank" rel="noopener" title="Pental Report is free software (AGPL-3.0): its source">Pental Report ' + esc(REPORTER.version) + '</a>'
    + '<button type="button" class="rp-move-btn" onclick="_reporterMove()">Move to Pental</button></div>';
  h += '<div class="sidebar-footer"><div class="user-info">';
  // Your picture where you have put one up, and nothing in its place where you
  // have not: no circle with an initial standing in for it.
  if (u.avatar_url) {
    h += '<div class="avatar has-photo" aria-hidden="true" style="background-image:url(' + esc(u.avatar_url) + ');background-size:cover;background-position:center"></div>';
  }
  h += '<div class="user-details"><div class="user-name">' + esc(_personName(u.name, 'User')) + '</div><div class="user-role">' + esc(_reporterRole(u.role)) + '</div></div>';
  h += '<button class="btn btn-ghost" onclick="toggleTheme()" id="portalThemeBtn" title="Light or dark" aria-label="Light or dark" style="padding:0.4rem' + (_themeMode() !== 'both' ? ';display:none' : '') + '">'
    + '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4"/></svg></button>';
  h += '<button class="btn btn-ghost" onclick="logout()" title="Sign out" aria-label="Sign out">' + IC.logout + '</button>';
  h += '</div></div></aside>';
  return h;
}

function _reporterRole(r) {
  return { admin: 'Administrator', senior: 'Senior tester', standard: 'Tester' }[r] || (r || 'user');
}

// MOVE TO PENTAL: the one way Pental Report points at Pental. Everything here goes
// across in a backup file, which Pental's portal restores as it is.
function _reporterMove() {
  var old = document.getElementById('rpLinkBox');
  if (old) old.remove();
  var admin = S.profile && S.profile.role === 'admin';
  var box = document.createElement('div');
  box.id = 'rpLinkBox';
  box.className = 'rp-linkbox';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.setAttribute('aria-labelledby', 'rpMoveTitle');
  // 1975: [stated] Arian, "make more seamless to transition everything to
  // main pental if they want to". The file first, so it is in hand; then the
  // trial itself, not the pricing page; then the one place it goes, which
  // the new portal's setup asks for as one of its steps.
  var steps = '<ol class="rp-move-steps">'
    + '<li><strong>Download everything from here.</strong> One file with your team, clients, assessments, findings, Library, '
    + 'custom fields, sections, prompts, templates and uploaded files. Your AI key stays behind.'
    + (admin ? '<div><button type="button" class="btn btn-primary btn-sm" id="rpMoveExport">Download Everything</button></div>'
             : '<div class="rp-hint">An administrator downloads it.</div>')
    + '</li>'
    + '<li><strong>Start your free trial of Pental.</strong> Free from the day your portal goes live, with no card required.'
    + '<div><a class="btn btn-secondary btn-sm" target="_blank" rel="noopener" href="' + esc(_reporterLink('/login?trial=1', 'move')) + '">Start Free Trial</a></div></li>'
    + '<li><strong>Choose the file in your portal\'s setup.</strong> Its Bring Your Data Across step restores it whole, or later '
    + 'Settings, Data. Your work arrives as it is here, and your team signs in with a password link.</li>'
    + '</ol>';
  // 1975, after the first sync: [stated] Arian, of "clients read their
  // reports": "read their reports should say read their findings, sell the
  // additional features better, allowing pentest as a service, live
  // reporting, etc." What Pental adds, each with what it does for the firm,
  // as /report and the README say it.
  var adds = '<ul class="rp-move-adds">'
    + '<li><strong>Pentest as a service.</strong> Clients sign in to a portal on your own domain to read their findings, '
    + 'ask for retests and comment on the engagement, during it and long after it.</li>'
    + '<li><strong>Live reporting.</strong> Show a finding to the client the day you confirm it, marked as a draft until '
    + 'it is written up, and nothing unfinished goes into the report.</li>'
    + '<li><strong>QA before anything goes out.</strong> One review queue, your own checklist, comments and suggested '
    + 'edits on the words themselves, and an optional AI reviewer.</li>'
    + '<li><strong>Credentials and scheduling.</strong> Clients send their test credentials encrypted, for your lead '
    + 'tester to view once, and a testing calendar shows who is testing what, and when.</li>'
    + '<li><strong>And the rest.</strong> Attestation letters, findings pushed to your clients\' Jira, ServiceNow and '
    + 'other trackers with their state read back, and scanner output imported as findings.</li>'
    + '</ul>';
  box.innerHTML = '<div class="rp-linkbox-card rp-linkbox-card--move">'
    + '<h2 id="rpMoveTitle" class="rp-h1">Move to Pental</h2>'
    + '<p class="rp-note">Pental is all of Pental Report, and what it takes to sell pentesting as a service, under your brand. '
    + 'Your reporting carries on exactly as it is.</p>'
    + adds
    + '<h3 class="rp-move-h">Moving in Three Steps</h3>'
    + steps
    + '<div class="rp-linkbox-foot"><button class="btn btn-ghost" id="rpMoveDone" type="button">Close</button></div>'
    + '</div>';
  document.body.appendChild(box);
  var close = function () { box.remove(); document.removeEventListener('keydown', onKey); };
  var onKey = function (e) { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  box.addEventListener('click', function (e) { if (e.target === box) close(); });
  document.getElementById('rpMoveDone').onclick = close;
  var ex = document.getElementById('rpMoveExport');
  if (ex) ex.onclick = function () { exportAllData(); };
  document.getElementById('rpMoveDone').focus();
}
