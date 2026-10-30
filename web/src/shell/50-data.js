// WHAT THE REPORTER ASKS ITS DATABASE FOR.
//
// The database is Pental's own tenant schema, so it has the paid product's
// tables too (empty here). The engine reads some of them on start-up for the
// pages Pental Report does not have; those reads are answered here, with no
// rows, without asking the server.
//
// SPDX-License-Identifier: AGPL-3.0-only

var _REPORTER_NO_TABLES = {
  invoices: 1, contractor_payments: 1, proposals: 1, feedback: 1, meetings: 1, meeting_attendees: 1, checklists_runbooks: 1,
  assessment_phase_checklist_state: 1, scan_providers: 1, scan_cadences: 1, scan_schedules: 1, scan_runs: 1, scan_results: 1,
  scan_billing_plans: 1, client_scan_targets: 1, issue_trackers: 1, finding_tickets: 1, contractor_teams: 1, qa_comments: 1,
  contact_requests: 1, email_notifications: 1, webauthn_credentials_master: 1, payment_events: 1, tickets: 1,
};
var _REPORTER_NO_RPC = /^rpc_(scan|invoice|proposal|xero|ticket|tracker|meeting|contractor|pm_|docs_|qa_|transfer_status$|set_active_tenant$|mail_frame_save$|signin_setup_save$|credentials_read$|engagements_commercial$|scan_types_servable$)/;

function _reporterNoRows(single) {
  var result = single ? { data: null, error: null, count: 0, status: 200, statusText: 'OK' } : { data: [], error: null, count: 0, status: 200, statusText: 'OK' };
  var done = Promise.resolve(result);
  var q = new Proxy(function () {}, {
    get: function (t, p) {
      if (p === 'then') return function (a, b) { return done.then(a, b); };
      if (p === 'catch') return function (f) { return done.catch(f); };
      if (p === 'finally') return function (f) { return done.finally(f); };
      if (p === 'single' || p === 'maybeSingle') return function () { return _reporterNoRows(true); };
      return function () { return q; };
    },
  });
  return q;
}

(function () {
  var sb = window.supabase;
  if (!sb || !sb.createClient || sb.__reporter) return;
  var make = sb.createClient;
  sb.createClient = function () {
    var c = make.apply(this, arguments);
    var from = c.from.bind(c);
    var rpc = c.rpc.bind(c);
    c.from = function (t) { return _REPORTER_NO_TABLES[t] ? _reporterNoRows(false) : from(t); };
    c.rpc = function (fn, args, o) { return _REPORTER_NO_RPC.test(String(fn || '')) ? _reporterNoRows(true) : rpc(fn, args, o); };
    return c;
  };
  sb.__reporter = true;
})();
