// THE WORD ROUND TRIP'S COMMENTS JOIN THE ENGAGEMENT'S.
//
// The report goes out as a Word file, is edited in Word, and comes back:
// what changed is shown and applied as the portal does it. In Pental's
// portal a comment written in Word comes back into the QA thread of the
// field it was written on. Pental Report has no QA: its team talks in the
// engagement's Comments, so that is where a Word comment comes back, posted
// by whoever brought the file in and saying who wrote it in Word and where.
// A reply in Word comes back as a reply. Comments here are not resolved, so
// a thread resolved in Word is not offered as one to resolve.
//
// SPDX-License-Identifier: AGPL-3.0-only

// What a Word comment says as one of the engagement's comments. A reply under
// its thread needs no "where"; a comment on its own does.
function _rpWordCommentText(c, underThread) {
  var by = String((c && c.author) || 'A reviewer').trim();
  var text = String((c && c.text) || '').trim();
  if (underThread) return by + ', in Word:\n' + text;
  var f = c && c.findingId ? (S.data.findings || []).find(function (x) { return x.id === c.findingId; }) : null;
  var label = String((c && c.fieldLabel) || '').trim();
  var where = f ? (label ? 'the ' + label + ' of ' : '') + (f.title || 'a finding')
    : (label ? 'the ' + label : 'the report');
  return by + ', in Word, on ' + where + ':\n' + text;
}

// Comments already brought in from an earlier upload of the same file are
// not brought in twice: they are matched on what they say.
function _syncMarkKnownComments(list, assessmentId) {
  try {
    var have = {};
    (S.data.assessment_comments || []).forEach(function (r) {
      if (!r || r.assessment_id !== assessmentId) return;
      var k = _syncNorm(String(r.content || ''));
      if (k && !have[k]) have[k] = r;
    });
    (list || []).forEach(function (c) {
      var r = have[_syncNorm(_rpWordCommentText(c, false))] || (c.parent ? have[_syncNorm(_rpWordCommentText(c, true))] : null);
      if (r) c.known = r.id || true;
    });
    (list || []).forEach(function (c) {
      if (!c.parent || c.known) return;
      var p = (list || []).find(function (x) { return x.id === c.parent; });
      if (p && typeof p.known === 'string') c.parentRow = p.known;
    });
  } catch (e) { /* every comment offered, as new */ }
  return list;
}

async function _syncImportComments(assessmentId, comments) {
  var list = (comments || []).filter(function (c) { return c && !c.known; });
  if (!list.length) return;
  var rowOf = {};
  (comments || []).forEach(function (c) { if (c && typeof c.known === 'string') rowOf[c.id] = c.known; });
  var made = 0, failed = 0;
  // Threads first, so a reply can be put under its thread.
  var rounds = [list.filter(function (c) { return !c.parent; }), list.filter(function (c) { return !!c.parent; })];
  for (var r = 0; r < rounds.length; r++) {
    for (var i = 0; i < rounds[r].length; i++) {
      var c = rounds[r][i];
      var parentId = c.parent ? (rowOf[c.parent] || c.parentRow || null) : null;
      var res = await supabaseClient.from('assessment_comments').insert({
        assessment_id: assessmentId, user_id: S.profile.id, user_name: S.profile.name || '', user_role: S.profile.role || '',
        parent_id: parentId, content: _rpWordCommentText(c, !!parentId),
        // The team's, as every comment here is: a move to Pental never shows
        // it to a client.
        client_visible: false,
      }).select();
      var row = res && !res.error && res.data && res.data[0];
      if (!row) { failed++; continue; }
      rowOf[c.id] = row.id;
      S.data.assessment_comments = S.data.assessment_comments || [];
      S.data.assessment_comments.push(row);
      made++;
    }
  }
  if (made) toast(made + ' comment' + (made === 1 ? '' : 's') + ' from Word added to Comments', 'success');
  if (failed) toast(failed + ' comment' + (failed === 1 ? '' : 's') + ' from Word could not be added', 'error');
}

// ── The Word round trip, in line with the report's button ─────────────────
// 1975, later that morning: [stated] Arian, "remove the pdf upload feature
// for the reporter and for the docx reader make it inline modern and
// beautiful. there is no need because a client does not log in or read it
// from there". The portal's report card has a final PDF to upload (it goes
// on the client's Report button) and, beside it, a panel with its own drop
// box for the edited Word file. Here nobody but the team downloads the
// report, so the PDF slot is gone (the manifest's renderAssessmentDetail
// patches), and the round trip is on the report's own row: "Edited in
// Word?" and the placeholder that asks for the file ([stated] "i liked the
// upload placeholder thing for when its requiring an upload just wanted it
// inline"), the Word file to download beside it when the PDF is made
// automatically; the file can be dropped on it. The edited file the report
// now hands back, when there is one, is a line under the row.
var _RP_WORD_TIP = 'Edit the report in Word and bring it back: you review what changed before anything is written. '
  + 'Track changes and comments are fine: you choose which tracked edits to accept, '
  + 'and Word comments come back as comments on this engagement.';

function _syncPanelHtml(a, opts) {
  opts = opts || {};
  var id = String(a.id);
  var h = '<div class="rp-trip" title="' + esc(_RP_WORD_TIP) + '"'
    + ' ondragover="_rpWordDrag(event, this, true)" ondragleave="_rpWordDrag(event, this, false)"'
    + ' ondrop="_rpWordDrop(event, this, \'' + id + '\')">';
  h += '<span class="rp-trip-l">Edited in Word?</span>';
  if (opts.withDownload) {
    h += _renderDocxDownloadButton('report', a.id, 'downloadReport', { label: 'Download the Word file', showWhenEmpty: true,
      extraActions: [_qaReviewCopyAction(a)] });
  }
  h += '<label class="rp-trip-drop">'
    + '<span class="rp-trip-none">' + (a.edited_docx_path ? 'Edited it again?' : 'No edited DOCX uploaded') + '</span>'
    + '<span class="rp-trip-act">Click to upload DOCX</span>'
    + '<input type="file" accept=".docx" style="display:none" onchange="syncUploadEdited(\'' + id + '\', this)"></label>';
  h += '</div>';
  if (a.edited_docx_path) {
    h += '<div class="sync-current rp-trip-cur" title="' + esc('Download hands this file back everywhere in Pental Report, brought up to date with anything changed here since') + '">';
    h += '<span class="qa-pill info">Current report</span>';
    h += '<span class="sync-current-name">' + esc(a.edited_docx_name || 'Uploaded report') + '</span>';
    h += '<span class="sync-current-when">' + fmtDateTime(a.edited_docx_at) + '</span>';
    if (canManage()) h += '<button class="btn btn-ghost btn-sm qa-cmt-act" onclick="clearEditedReport(\'' + id + '\')" title="Hand back a freshly generated report from now on">Use a generated one</button>';
    h += '</div>';
  }
  return h;
}

// A Word file dropped on the control is brought in as if it were chosen.
function _rpWordDrag(e, el, over) {
  if (!e || !el) return;
  if (over) { e.preventDefault(); el.classList.add('is-over'); return; }
  if (e.relatedTarget && el.contains(e.relatedTarget)) return;
  el.classList.remove('is-over');
}
function _rpWordDrop(e, el, id) {
  if (!e) return;
  e.preventDefault();
  if (el) el.classList.remove('is-over');
  var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (!f) return;
  if (!/\.docx$/i.test(f.name || '')) { toast('That is not a Word document (.docx)', 'error'); return; }
  var input = el && el.querySelector('input[type=file]');
  try {
    var dt = new DataTransfer();
    dt.items.add(f);
    input.files = dt.files;
  } catch (err) {
    toast('Click to upload it instead', 'error');
    return;
  }
  syncUploadEdited(id, input);
}
window._rpWordDrag = _rpWordDrag;
window._rpWordDrop = _rpWordDrop;
