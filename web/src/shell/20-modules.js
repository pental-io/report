// WHAT THE REPORTER HAS: its pages and its modules.
//
// Pental's portal reads a firm's Feature Modules to decide what it shows.
// Pental Report has engagements, the findings library, checklists and
// runbooks on an engagement's phases, its clients and (1977) the testing
// calendar. Every other module reads as off
// wherever the engine asks: the client portal, QA, invoicing, proposals,
// scans, meetings, contacts, contractors and the dashboard are Pental's.
//
// Checklists and runbooks follow the firm's own switch, at the top of
// Settings, Checklists & Runbooks, and are on until it is turned off (as the
// schema's default has them). That tab is always there, so the switch can
// always be turned back on.
//
// SPDX-License-Identifier: AGPL-3.0-only

var _REPORTER_MODULES = { assessments_enabled: true, library_enabled: true, testing_calendar_enabled: true };
var _REPORTER_SWITCHED = { enable_checklists_runbooks: true };
function _modOn(key) {
  if (_REPORTER_MODULES[key] === true) return true;
  if (!Object.prototype.hasOwnProperty.call(_REPORTER_SWITCHED, key)) return false;
  var s = S.data && S.data.settings;
  var v = s ? s[key] : undefined;
  return (v === true || v === false) ? v : _REPORTER_SWITCHED[key];
}

// 1977: and its clients, each with their engagements, and the testing calendar.
var _PORTAL_PAGES = ['assessments', 'assessment-detail', 'finding-detail', 'all-findings', 'library', 'report-builder', 'users', 'settings', 'my-profile',
  'clients', 'client-detail', 'calendar'];
