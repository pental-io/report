// A NEWER PENTAL REPORT, SAID TO ITS ADMINISTRATORS, AND INSTALLED FOR THEM.
//
// [stated] Arian: "also there should be a way to let them know an update is
// available, automatically update, or if it has to be manual make it as
// seamless as possible".
//
// The server asks GitHub for the latest release (server/lib/updates.js). An
// administrator sees a newer one in a banner at the top of every page, the
// portal's own banner for an update ([stated] Arian: "i wanted the banner one
// the portal already has similar to that"), and in Settings, Updates, with
// what it changes. Where the computer it runs on has
// the updater the installer sets up, Update Now installs it there and then,
// and new releases install by themselves overnight unless that is turned off;
// this page waits for the new version and reloads into it. Where it has none,
// the one command that updates it is given, for that computer, to copy.
//
// SPDX-License-Identifier: AGPL-3.0-only

var _rpUpd = { status: null, at: 0, busy: false, watching: false, later: '', restarting: false };
var _RP_UPD_REFRESH_MS = 30 * 60 * 1000;

function _rpUpdAdmin() { return !!(S.profile && S.profile.role === 'admin'); }

async function _rpUpdCall(method, body) {
  var session = await supabaseClient.auth.getSession();
  var token = session && session.data && session.data.session && session.data.session.access_token;
  if (!token) throw new Error('Your session has ended. Sign in again.');
  var r = await fetch('/reporter/v1/updates', {
    method: method,
    headers: Object.assign({ Authorization: 'Bearer ' + token }, body ? { 'Content-Type': 'application/json' } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  var j = null;
  try { j = await r.json(); } catch (e) { j = null; }
  if (j && j.current) _rpUpdSet(j);
  if (!r.ok) throw new Error((j && j.error) || 'The server did not answer (' + r.status + ').');
  return j;
}

function _rpUpdSet(st) {
  var before = JSON.stringify(_rpUpd.status || {});
  _rpUpd.status = st;
  _rpUpd.at = Date.now();
  if (JSON.stringify(st) === before) return;
  _rpUpdBannerRedraw();
  if (S.page === 'settings' && S.settingsTab === 'updates') {
    var card = document.getElementById('rpUpdCard');
    if (card) card.outerHTML = _rpUpdatesSettingsHtml();
  }
}

// From the sidebar, whenever it is drawn: a fresh status every half hour.
function _rpUpdKick() {
  if (!_rpUpdAdmin() || _rpUpd.busy) return;
  if (_rpUpd.at && Date.now() - _rpUpd.at < _RP_UPD_REFRESH_MS) return;
  _rpUpd.busy = true;
  _rpUpd.at = Date.now();
  _rpUpdCall('GET').catch(function () {}).then(function () {
    _rpUpd.busy = false;
    _rpUpdWelcome();
  });
}

// Once, after an update has finished: what it brought.
function _rpUpdWelcome() {
  var st = _rpUpd.status, run = st && st.run;
  if (!run || run.state !== 'done' || run.version !== st.current) return;
  var key = 'rp_updated_' + run.version;
  try { if (localStorage.getItem(key)) return; localStorage.setItem(key, '1'); } catch (e) { return; }
  toast('Pental Report is updated to ' + run.version + '.', 'success', 6000);
}

// ── The banner ─────────────────────────────────────────────────────────────
// The portal's update banner (its renderSchemaUpdateBanner: "Database update
// available", with what to do and Later), in its place at the top of every
// page. This server brings its own database up to date as it starts, so the
// portal's reason for that banner never arises here, and the slot is the
// release's: what it is, the one thing to do about it, what it changes, and
// Later, which keeps it away until the next page load. ONLY WHEN SOMEBODY HAS
// SOMETHING TO DO ([stated] Arian: "wait if its automatic there is no need"):
// with the updater on the computer and automatic updates on, a release installs
// itself overnight and nothing is said until it has (a toast, once). The
// banner is for no updater, automatic updates turned off, an update that did
// not finish, and the few minutes one is being installed.
function renderSchemaUpdateBanner() {
  return '<div id="rpUpdBanner">' + _rpUpdBannerInner() + '</div>';
}
function _rpUpdBannerRedraw() {
  var b = document.getElementById('rpUpdBanner');
  if (b) b.innerHTML = _rpUpdBannerInner();
}
function _rpUpdLater() { _rpUpd.later = (_rpUpd.status && _rpUpd.status.latest && _rpUpd.status.latest.version) || 'all'; _rpUpdBannerRedraw(); }
var _RP_UPD_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#eab308" stroke-width="2" style="flex-shrink:0" aria-hidden="true"><path d="M12 2v6m0 0 3-3m-3 3L9 5"/><path d="M4 12a8 8 0 1 0 16 0"/></svg>';
function _rpUpdBannerInner() {
  var st = _rpUpd.status;
  if (!_rpUpdAdmin() || !st || !st.latest) return '';
  var v = st.latest.version, run = st.run;
  var running = _rpUpd.restarting || (run && run.state === 'running' && run.version === v) || (_rpUpd.watching && st.newer);
  var failed = !running && run && run.state === 'failed' && run.version === v && st.newer;
  if (!running && !st.newer) return '';
  if (!running && !failed && st.updater && st.auto) return '';
  if (!running && _rpUpd.later === v) return '';
  var title, line, acts = '';
  var news = '<button type="button" class="btn btn-ghost btn-sm" onclick="_rpUpdOpen()" style="font-size:0.75rem;white-space:nowrap">What’s new</button>';
  if (running) {
    title = 'Updating to Pental Report ' + v;
    line = _rpUpd.restarting ? 'Restarting on ' + v + '. This page reloads by itself when it is back.'
      : (run && run.state === 'running' ? 'Installing ' + v + ', after a copy of the database. This page reloads by itself when it is back.'
        : 'The updater starts within a minute. This page reloads by itself when it is back.');
    acts = news;
  } else {
    var cmds = _rpUpdCommands(st);
    title = failed ? 'The update to ' + v + ' did not finish' : 'Update available: Pental Report ' + v;
    if (failed) {
      line = (run.from || st.current) + ' was kept. ' + (run.message || 'The updater wrote what happened to update.log, in the folder Pental Report lives in.');
    } else if (st.updater) {
      line = 'This server runs ' + st.current + '. Update now and it restarts on ' + v + ' within a few minutes, after a copy of the database.'
        + ' Automatic updates are off (Settings, Updates).';
    } else {
      line = 'This server runs ' + st.current + '. ' + (cmds.length === 1
        ? 'To update, run the install command again ' + (st.host === 'windows' ? 'in PowerShell' : 'in a terminal') + ' on the computer it runs on: your settings and your data stay as they are.'
        : 'To update, run the install command again on the computer it runs on: your settings and your data stay as they are.');
    }
    if (st.updater) {
      acts += '<button type="button" class="btn btn-primary btn-sm" onclick="_rpUpdNow(this)" style="font-size:0.75rem;white-space:nowrap">' + (failed ? 'Try again' : 'Update now') + '</button>';
    } else if (cmds.length === 1) {
      acts += '<button type="button" class="btn btn-primary btn-sm" onclick="_rpUpdCopyCmd(this)" style="font-size:0.75rem;white-space:nowrap">Copy command</button>';
    } else {
      acts += '<button type="button" class="btn btn-primary btn-sm" onclick="_rpUpdOpen()" style="font-size:0.75rem;white-space:nowrap">How to update</button>';
    }
    acts += news + '<button type="button" class="btn btn-ghost btn-sm" onclick="_rpUpdLater()" style="font-size:0.75rem" title="Hide it until the page is next loaded">Later</button>';
  }
  return '<div class="rp-upd-banner" role="status" style="display:flex;align-items:center;gap:0.75rem;padding:0.7rem 0.95rem;margin-bottom:1rem;border:1px solid rgba(234,179,8,0.3);background:rgba(234,179,8,0.06);border-radius:8px">'
    + (running ? '<span class="rp-upd-spin" aria-hidden="true"></span>' : _RP_UPD_ICON)
    + '<div style="flex:1;min-width:0"><div style="font-weight:600;font-size:0.82rem;color:var(--text)">' + esc(title) + '</div>'
    + '<div style="font-size:0.74rem;color:var(--gray);margin-top:1px">' + esc(line) + '</div></div>'
    + '<div class="rp-upd-banner-acts">' + acts + '</div></div>';
}
// The command for this computer, from the banner, without opening anything.
function _rpUpdCopyCmd(btn) {
  var cmds = _rpUpd.status ? _rpUpdCommands(_rpUpd.status) : [];
  if (!cmds.length) return;
  var done = function () { if (btn) { btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = 'Copy command'; }, 1800); } };
  try { navigator.clipboard.writeText(cmds[0].cmd).then(done, function () { _rpUpdOpen(); }); } catch (e) { _rpUpdOpen(); }
}

// ── The command that updates it, for the computer it runs on ────────────────
function _rpUpdCommands(st) {
  var dir = st.dir || '';
  var sh = 'curl -fsSL https://pental.io/report/install.sh | ' + (st.root ? 'sudo ' : '') + 'sh'
    + (dir && st.host !== 'windows' ? ' -s -- --dir \'' + dir.replace(/'/g, '\'\\\'\'') + '\'' : '');
  var ps = dir && st.host === 'windows'
    ? '& ([scriptblock]::Create((irm https://pental.io/report/install.ps1))) -Dir \'' + dir.replace(/'/g, '\'\'') + '\''
    : 'irm https://pental.io/report/install.ps1 | iex';
  if (st.host === 'windows') return [{ where: 'In PowerShell, on the computer Pental Report runs on:', cmd: ps }];
  if (st.host === 'linux' || st.host === 'macos') return [{ where: 'In a terminal, on the computer Pental Report runs on:', cmd: sh }];
  return [{ where: 'On macOS or Linux, in a terminal on the computer Pental Report runs on:', cmd: sh },
    { where: 'On Windows, in PowerShell:', cmd: ps }];
}
function _rpUpdCommandHtml(st) {
  return _rpUpdCommands(st).map(function (c, i) {
    return '<div class="rp-upd-cmd"><div class="rp-upd-where">' + esc(c.where) + '</div>'
      + '<div class="rp-upd-line"><code id="rpUpdCmd' + i + '">' + esc(c.cmd) + '</code>'
      + '<button type="button" class="btn btn-secondary btn-sm" onclick="_rpUpdCopy(' + i + ', this)">Copy</button></div></div>';
  }).join('');
}
function _rpUpdCopy(i, btn) {
  var el = document.getElementById('rpUpdCmd' + i);
  if (!el) return;
  var done = function () { if (btn) { btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = 'Copy'; }, 1800); } };
  try { navigator.clipboard.writeText(el.textContent).then(done, function () { _rpUpdSelect(el); }); } catch (e) { _rpUpdSelect(el); }
}
function _rpUpdSelect(el) {
  var r = document.createRange(); r.selectNodeContents(el);
  var s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
}

// ── What a release changes, from its notes on GitHub ───────────────────────
// Escaped first, then a little Markdown: headings, bullets, bold, code and
// https links. How to install it is left off: here it is installed for you, or
// the command is below.
function _rpUpdNotesHtml(md) {
  var text = String(md || '').replace(/\r\n/g, '\n');
  var cut = text.search(/^#{2,4}\s*Install or update\b/im);
  if (cut > -1) text = text.slice(0, cut);
  var inline = function (s) {
    return esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\[([^\]]+)\]\((https:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  };
  var out = [], list = null, para = [];
  var flush = function () {
    if (para.length) { out.push('<p>' + inline(para.join(' ')) + '</p>'); para = []; }
    if (list) { out.push('<ul>' + list.join('') + '</ul>'); list = null; }
  };
  text.split('\n').forEach(function (line) {
    var t = line.trim();
    if (!t) { flush(); return; }
    var hm = /^#{1,4}\s+(.*)$/.exec(t);
    if (hm) { flush(); out.push('<h4>' + inline(hm[1]) + '</h4>'); return; }
    var lm = /^[-*]\s+(.*)$/.exec(t);
    if (lm) { if (para.length) { out.push('<p>' + inline(para.join(' ')) + '</p>'); para = []; } (list = list || []).push('<li>' + inline(lm[1]) + '</li>'); return; }
    if (list) { list[list.length - 1] = list[list.length - 1].replace(/<\/li>$/, ' ' + inline(t) + '</li>'); return; }
    para.push(t);
  });
  flush();
  return out.join('') || '<p>' + esc('The release says nothing more than its number.') + '</p>';
}

function _rpUpdWhen(iso) {
  if (!iso) return '';
  try { return fmtDate(iso); } catch (e) { return String(iso).slice(0, 10); }
}

// ── The dialog ─────────────────────────────────────────────────────────────
function _rpUpdOpen() {
  var st = _rpUpd.status;
  if (!st || !st.latest) return;
  var old = document.getElementById('rpLinkBox');
  if (old) old.remove();
  var v = st.latest.version;
  var running = st.run && st.run.state === 'running' && st.run.version === v;
  var h = '<div class="rp-linkbox-card rp-linkbox-card--move rp-upd-card">'
    + '<h2 id="rpUpdTitle" class="rp-h1">Pental Report ' + esc(v) + '</h2>'
    + '<p class="rp-note">' + (st.newer ? 'This server runs ' + esc(st.current) + '. ' : 'This server runs it. ')
    + (st.latest.published_at ? esc(v) + ' came out on ' + esc(_rpUpdWhen(st.latest.published_at)) + '.' : '') + '</p>'
    + '<h3 class="rp-move-h">What’s New</h3><div class="rp-upd-notes">' + _rpUpdNotesHtml(st.latest.notes) + '</div>';
  if (st.newer) h += '<div id="rpUpdAct">' + _rpUpdActionHtml(st, running) + '</div>';
  h += '<div class="rp-linkbox-foot"><a class="btn btn-ghost" href="' + esc(st.latest.url) + '" target="_blank" rel="noopener">On GitHub</a>'
    + '<button class="btn btn-ghost" id="rpUpdDone" type="button">Close</button></div></div>';
  var box = document.createElement('div');
  box.id = 'rpLinkBox';
  box.className = 'rp-linkbox';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.setAttribute('aria-labelledby', 'rpUpdTitle');
  box.innerHTML = h;
  document.body.appendChild(box);
  var close = function () { box.remove(); document.removeEventListener('keydown', onKey); };
  var onKey = function (e) { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  box.addEventListener('click', function (e) { if (e.target === box) close(); });
  document.getElementById('rpUpdDone').onclick = close;
  document.getElementById('rpUpdDone').focus();
  if (running) _rpUpdWatch(v);
}

function _rpUpdActionHtml(st, running) {
  var v = st.latest.version;
  if (running || _rpUpd.watching) {
    return '<div class="rp-upd-progress" role="status"><span class="rp-upd-spin" aria-hidden="true"></span>'
      + '<span id="rpUpdProgress">Updating to ' + esc(v) + '. This page reloads by itself when it is back.</span></div>';
  }
  if (st.updater) {
    var failed = st.run && st.run.state === 'failed' && st.run.version === v;
    return (failed ? '<p class="rp-upd-failed">The last try did not finish, so ' + esc(st.run.from || st.current) + ' was kept. '
        + esc(st.run.message || 'The updater wrote what happened to update.log, in the folder Pental Report lives in.') + '</p>' : '')
      + '<div class="rp-upd-go"><button type="button" class="btn btn-primary" onclick="_rpUpdNow(this)">Update Now</button>'
      + '<span class="rp-note">Pental Report restarts on ' + esc(v) + ', usually within a few minutes. A copy of the database is made first, and if '
      + esc(v) + ' does not start, ' + esc(st.current) + ' is put back.</span></div>'
      + '<p class="rp-note">' + (st.auto ? 'New releases also install by themselves overnight.' : 'Automatic updates are off: Settings, Updates.') + '</p>';
  }
  return '<h3 class="rp-move-h">To Update It</h3>' + _rpUpdCommandHtml(st)
    + '<p class="rp-note">Your settings and your data stay as they are.'
    + (st.host === 'windows' ? '' : ' The installer also offers to keep Pental Report up to date by itself from then on.') + '</p>';
}

async function _rpUpdNow(btn) {
  if (btn) btn.disabled = true;
  try {
    var st = await _rpUpdCall('POST', { action: 'now' });
    _rpUpd.watching = true;
    var act = document.getElementById('rpUpdAct');
    if (act) act.innerHTML = _rpUpdActionHtml(st, true);
    _rpUpdBannerRedraw();
    _rpUpdWatch(st.latest.version);
  } catch (e) {
    if (btn) btn.disabled = false;
    toast(e.message || 'The update could not be started.', 'error', 8000);
  }
}

// Until the server answers as the new version: then this page reloads into
// it. The server goes away for a moment while it is replaced.
function _rpUpdWatch(v) {
  if (_rpUpd.watchTimer) return;
  _rpUpd.watching = true;
  var t0 = Date.now();
  var say = function (s) { var el = document.getElementById('rpUpdProgress'); if (el) el.textContent = s; };
  _rpUpd.watchTimer = setInterval(async function () {
    try {
      var r = await fetch('/health', { cache: 'no-store' });
      var j = r.ok ? await r.json() : null;
      if (j && j.version === v) {
        clearInterval(_rpUpd.watchTimer);
        say('Updated to ' + v + '. Reloading.');
        setTimeout(function () { location.reload(); }, 1200);
        return;
      }
      var st = await _rpUpdCall('GET').catch(function () { return null; });
      if (st && _rpUpd.restarting) { _rpUpd.restarting = false; _rpUpdBannerRedraw(); }
      if (st && st.run && st.run.version === v && st.run.state === 'failed') {
        clearInterval(_rpUpd.watchTimer); _rpUpd.watchTimer = null; _rpUpd.watching = false;
        var act = document.getElementById('rpUpdAct');
        if (act) act.innerHTML = _rpUpdActionHtml(st, false);
        _rpUpdBannerRedraw();
        return;
      }
      say(st && st.run && st.run.state === 'running' && st.run.version === v
        ? 'Installing ' + v + '. This page reloads by itself when it is back.'
        : 'Waiting for the updater to start, within a minute.');
    } catch (e) {
      say('Restarting on ' + v + '. This page reloads by itself when it is back.');
      if (!_rpUpd.restarting) { _rpUpd.restarting = true; _rpUpdBannerRedraw(); }
    }
    if (Date.now() - t0 > 20 * 60 * 1000) {
      clearInterval(_rpUpd.watchTimer); _rpUpd.watchTimer = null;
      say('This is taking longer than it should. The updater writes what happened to update.log, in the folder Pental Report lives in.');
    }
  }, 3000);
}

async function _rpUpdAuto(on) {
  try { await _rpUpdCall('POST', { action: 'auto', on: !!on }); toast(on ? 'New releases install by themselves overnight.' : 'Automatic updates are off.', 'success'); }
  catch (e) { toast(e.message, 'error'); }
}
async function _rpUpdCheck(btn) {
  if (btn) { btn.disabled = true; btn.textContent = 'Checking'; }
  try { await _rpUpdCall('POST', { action: 'check' }); }
  catch (e) { toast(e.message, 'error'); }
  var b = document.getElementById('rpUpdCheckBtn');
  if (b) { b.disabled = false; b.textContent = 'Check Now'; }
}

// ── Settings, Updates ──────────────────────────────────────────────────────
function _rpUpdatesSettingsHtml() {
  var st = _rpUpd.status;
  if (!st) { _rpUpdKick(); }
  var h = '<div class="card mb-4" id="rpUpdCard"><div class="card-header"><span class="card-title">Updates</span></div><div class="card-body">';
  if (!st) return h + '<p class="set-p">Asking this server about updates.</p></div></div>';
  var latest = st.latest;
  h += '<p class="set-p">This server runs Pental Report <strong>' + esc(st.current) + '</strong>. ';
  if (!st.checks) h += 'Update checks are off on this server (UPDATE_CHECK in .env), so new releases are not looked for.';
  else if (!latest) h += 'It has not heard from GitHub yet.';
  else if (st.newer) h += '<strong>' + esc(latest.version) + '</strong> is out.';
  else h += 'That is the latest release.';
  if (latest && latest.checked_at) h += ' <span class="rp-hint">Checked ' + esc(_rpUpdWhen(latest.checked_at)) + '.</span>';
  h += '</p><div class="rp-upd-row">';
  if (st.checks) h += '<button type="button" class="btn btn-secondary btn-sm" id="rpUpdCheckBtn" onclick="_rpUpdCheck(this)">Check Now</button>';
  if (st.newer) h += '<button type="button" class="btn btn-primary btn-sm" onclick="_rpUpdOpen()">See What’s New</button>';
  h += '</div>';
  var run = st.run;
  if (run && run.state === 'done') h += '<p class="set-p rp-hint">Last updated to ' + esc(run.version) + (run.from ? ' from ' + esc(run.from) : '') + ' on ' + esc(_rpUpdWhen(run.at)) + '.</p>';
  if (run && run.state === 'failed') h += '<p class="set-p rp-upd-failed">The update to ' + esc(run.version) + ' on ' + esc(_rpUpdWhen(run.at)) + ' did not finish, so '
    + esc(run.from || st.current) + ' was kept. ' + esc(run.message || '') + '</p>';
  h += '<h4 class="rp-upd-h">Installing Updates</h4>';
  if (st.updater) {
    h += '<label class="rp-upd-auto"><input type="checkbox"' + (st.auto ? ' checked' : '') + ' onchange="_rpUpdAuto(this.checked)">'
      + '<span><strong>Install new releases by themselves, overnight.</strong> Between 1am and 6am on the server’s clock, after a copy of the database is made. '
      + 'With this off, Update Now installs one when you choose.</span></label>';
  } else {
    h += '<p class="set-p">' + (st.updaterSeen
      ? 'The updater on the computer Pental Report runs on last asked on ' + esc(_rpUpdWhen(st.updaterSeen)) + ', so it is not running just now (a computer asleep stops it). Until it is back, this updates it:'
      : 'This server has no updater, so it is updated with the install command. ' + (st.host === 'windows' ? 'Run it when a release comes out:' : 'Run it once and it offers to set one up, so updates install by themselves from then on:'))
      + '</p>' + _rpUpdCommandHtml(st);
  }
  h += '<p class="set-p rp-hint">To know of a new release, this server asks GitHub for the latest one twice a day. Nothing else is sent. UPDATE_CHECK=off in .env turns it off.</p>';
  return h + '</div></div>';
}
