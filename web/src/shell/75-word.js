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
