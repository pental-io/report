// WHAT THE PORTAL SHOWS FOR ITS PAID PARTS, AND REPORTER LEAVES OFF.
//
// Pental's portal has a client portal (clients sign in to read their findings,
// comment and ask for retests), QA review, proposals, invoicing, scans,
// letters of attestation and email. Pental Report has none of them, so their
// sections, settings and switches come off the pages here rather than showing
// and doing nothing.
//
// Three ways, each where it fits:
//   - the assessment sections and settings tabs Pental Report has are decided by
//     wrapping the portal's own functions (it keeps them as <name>__portal);
//   - controls with a stable hook are hidden in reporter.css;
//   - what can only be recognised by its heading (a settings card, a table
//     column) is hidden by _reporterTidy() below whenever the page changes.
//     It hides rather than removes, so anything the portal reads back from
//     the page when saving is still there.
//
// SPDX-License-Identifier: AGPL-3.0-only

// ── Assessment sections ──────────────────────────────────────────────────
// The ones for documents Pental Report does not make (the letter of attestation,
// proposals, invoices, scan reports), scans, the client's credentials, and the
// timeline of an engagement's way through testing, QA and delivery, which it
// has none of ([stated] Arian: "there should be no timeline either in
// reporting it is redundant"). Comments stay, as the team's own (1975, after
// the first sync: "why in the comment area no longer there?"), never shown to
// a client: see the manifest's patches to postComment and renderCommentThread.
var _REPORTER_SECTIONS_OUT = {
  doc_attestation: 1, doc_proposal: 1, doc_invoice: 1, doc_vuln_report: 1,
  scan_import: 1, credentials: 1, timeline: 1,
};
function _smDefs() {
  return _smDefs__portal().filter(function (d) { return !_REPORTER_SECTIONS_OUT[d.key]; });
}
function _smEnabled(key) {
  return _REPORTER_SECTIONS_OUT[key] ? false : _smEnabled__portal(key);
}
// Nothing on an assessment is shown to a client: there is no client portal.
function _smHasClient() { return false; }

// Scanner exports are a Pental feature.
function _ffScannerImport() { return false; }

// Where sign-in is made (Pental's servers or the firm's own) is a question
// for the portal; here it is always this server.
function _signinStateHtml() { return ''; }

// A report's version history: written, tested, released. The portal's
// default adds a QA review row, which belongs to its QA module.
var VH_DEFAULT_ROWS = [
  { k: 'creation', v: '0.1', l: 'Document Creation' },
  { k: 'details', v: '0.2', l: 'Test Details Added' },
  { k: 'release', v: '1.0', l: 'Document Release' },
];

// Engagements start and finish when somebody presses the button: the
// schedule that does it by date runs on Pental's servers.
function _assAutomationNote() { return null; }

// ── Settings ─────────────────────────────────────────────────────────────
var _REPORTER_SETTINGS_TABS = {
  login: 1, branding: 1, pdf_templates: 1, filenames: 1, company: 1, testing_ip: 1,
  assessments: 1, findings: 1, checklists: 1, ai: 1, security: 1, data: 1,
  // 1976: its own, for a newer release (shell/85-updates.js).
  updates: 1,
  // 1977: the API, as in the portal (an administrator's: _setTabOn).
  api: 1,
};
function _setTabOn(id) {
  if (id === 'api' && !(S.profile && S.profile.role === 'admin')) return false;
  return !!_REPORTER_SETTINGS_TABS[id];
}
function renderSettings() {
  if (!S._embedSettings && !_REPORTER_SETTINGS_TABS[S.settingsTab]) S.settingsTab = 'branding';
  return renderSettings__portal();
}

// ── Hidden by heading ────────────────────────────────────────────────────
// Settings cards for the paid parts, by their title.
var _REPORTER_CARDS_OUT = {
  'Lead Tester Card': 1,      // Teams and Slack buttons
  'QA Module': 1,
  'Plan Usage': 1,            // Pental's plans
  'Custom Domain': 1,         // set up at pental.io; Pental Report's is its own
};
// Table columns, by their heading. An engagement has no status here (it is
// open from the moment it is made), so the list has no Status column.
var _REPORTER_COLUMNS_OUT = { 'Client Visible': 1, 'Status': 1 };
// A findings table: its main column is the finding (renderAssessmentDetail's
// three, and the Findings page's), where an engagement list's is the
// assessment.
function _rpFindingsTable(th) {
  var row = th && th.parentNode;
  var main = row && row.querySelector ? row.querySelector('th.c-main') : null;
  return !!(main && (main.textContent || '').trim() === 'Finding');
}

function _reporterTidy(root) {
  root = root && root.querySelectorAll ? root : document;
  try { _rpKeysNoteOnSetup(); } catch (e) { /* never in the way of the page */ }
  var cards = root.querySelectorAll('.card-title');
  for (var i = 0; i < cards.length; i++) {
    var title = (cards[i].textContent || '').replace(/\s+/g, ' ').trim();
    if (!_REPORTER_CARDS_OUT[title]) continue;
    var card = cards[i].closest('.card');
    if (card) card.style.display = 'none';
  }
  var heads = root.querySelectorAll('th');
  for (var j = 0; j < heads.length; j++) {
    var th = heads[j];
    var _head = (th.textContent || '').trim();
    if (!_REPORTER_COLUMNS_OUT[_head] || th.getAttribute('data-rp-out')) continue;
    // 1977: [stated] Arian: "why is there no status column for the findings
    // in reprot tool like in portal". A finding has a status here (open,
    // remediated, part remediated, not remediated, risk accepted), and its
    // column is headed Status too, so taking an engagement's out took the
    // findings' with it. A table whose main column is the finding keeps it.
    if (_head === 'Status' && _rpFindingsTable(th)) continue;
    var table = th.closest('table');
    if (!table) continue;
    var at = Array.prototype.indexOf.call(th.parentNode.children, th);
    var was = table.getAttribute('data-rp-out') ? table.getAttribute('data-rp-out').split(',') : [];
    if (was.indexOf(String(at)) === -1) was.push(String(at));
    table.setAttribute('data-rp-cols', String(th.parentNode.children.length));
    table.setAttribute('data-rp-out', was.join(','));
    th.setAttribute('data-rp-out', '1');
  }
  // Every row of a table with a column out, including rows added later.
  //
  // 1975: THE COLUMN IS TAKEN OUT, NOT HIDDEN. [stated] Arian, of the gap at
  // the right of the findings table: "what is this space?". Hidden cells left
  // the column in the table: the table sizer had already given it its width,
  // so the rows ended short of the card with an empty band after them. A cell
  // taken out of the page is a change the sizer sees, and it sizes the table
  // again on the columns that are left.
  var tables = root.querySelectorAll ? root.querySelectorAll('table[data-rp-out]') : [];
  var own = root.closest && root.closest('table[data-rp-out]');
  var list = Array.prototype.slice.call(tables);
  if (own) list.push(own);
  for (var k = 0; k < list.length; k++) {
    var t = list[k];
    var cols = +t.getAttribute('data-rp-cols');
    // Highest first, so taking one out does not move the next.
    var out = t.getAttribute('data-rp-out').split(',').map(Number).sort(function (a, b) { return b - a; });
    var rows = t.querySelectorAll('tr');
    for (var r = 0; r < rows.length; r++) {
      var cells = rows[r].children;
      if (cells.length !== cols) {
        // A row with one wide cell ("No findings yet") spans one column fewer.
        if (cells.length === 1 && +cells[0].getAttribute('colspan') === cols && !rows[r].getAttribute('data-rp-span')) {
          cells[0].setAttribute('colspan', String(cols - out.length));
          rows[r].setAttribute('data-rp-span', '1');
        }
        continue;
      }
      for (var c = 0; c < out.length; c++) if (cells[out[c]]) cells[out[c]].remove();
    }
  }
}

(function () {
  if (typeof MutationObserver !== 'function') return;
  var queued = false;
  var run = function () { queued = false; try { _reporterTidy(document); } catch (e) { /* never in the way of the page */ } };
  var start = function () {
    new MutationObserver(function () {
      // Changes arrive in bursts while a page renders; tidy once, before it
      // is painted.
      if (queued) return;
      queued = true;
      Promise.resolve().then(run);
    }).observe(document.body, { childList: true, subtree: true });
    run();
  };
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
})();

// ── An engagement is open from the moment it is made ─────────────────────
// [stated] Arian: "start testing/end testing is redundant". No Start or
// Complete Testing (the manifest's patches), no status shown anywhere, and
// every engagement's report downloadable from the list: in Pental's portal it
// is once the report has been delivered.
function renderMergedStatus() { return ''; }
// Current first, by the engagement's dates rather than a status: one whose
// dates take in today, then those still to start (soonest first), then those
// that have ended (the most recent first).
function _assTier(a) {
  var s = _assTime(a, 'start_date'), e = _assTime(a, 'end_date');
  if (s === null && e === null) return 1;
  var now = Date.now();
  if (e !== null && e + 86400000 <= now) return 2;
  if (s !== null && s > now) return 1;
  return 0;
}
function renderReportColumn(assessment) {
  return '<button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();downloadListDoc(\'report\',\'' + assessment.id + '\')" '
    + 'style="font-size:0.65rem;padding:0.1rem 0.25rem;white-space:nowrap" title="Download Report">' + IC.dl + ' Report</button>';
}

// ── The report's own button ──────────────────────────────────────────────
// [stated] Arian: "dropdown appears even though only one docx uploaded ...
// should be more tailored in report to as a view that clients wont see
// basically its only for their team". Adding other PDFs beside a report is
// how Pental's portal hands a client more than one document; here the
// report's button is the report, and other files go in the engagement's
// Files.
function _assDocAddPdfHtml() { return ''; }
window._assDocAddPdfHtml = _assDocAddPdfHtml;
// And no switch on a file for whether a client sees it: nobody else does.
function _fileVisibleToggle() { return ''; }
window._fileVisibleToggle = _fileVisibleToggle;

// ── No email ─────────────────────────────────────────────────────────────
// Pental Report sends no email, so nothing offers to send one: not starting
// an engagement, not a comment, not anything else the portal emails about.
function _emailsOn() { return false; }
window._emailsOn = _emailsOn;

// ── No plan, so no limit ─────────────────────────────────────────────────
// Pental's portal is priced per tester, and its invite and client forms check
// the testers a firm pays for. Pental Report has no plan: as many people and
// clients as the firm likes.
function getPlanLimits() {
  return { users: Infinity, clients: Infinity, label: 'Pental Report', perTester: false };
}
