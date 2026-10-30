// WHAT THE REPORTER HAS: its pages and its modules.
//
// Pental's portal reads a firm's Feature Modules to decide what it shows. The
// Pental Report has engagements and the findings library and nothing else, so
// every other module reads as off wherever the engine asks: the client
// portal, QA, invoicing, proposals, scans, meetings, contacts, contractors,
// checklists and the dashboard are Pental's.
//
// SPDX-License-Identifier: AGPL-3.0-only

var _REPORTER_MODULES = { assessments_enabled: true, library_enabled: true };
function _modOn(key) { return _REPORTER_MODULES[key] === true; }

var _PORTAL_PAGES = ['assessments', 'assessment-detail', 'finding-detail', 'all-findings', 'library', 'report-builder', 'users', 'settings', 'my-profile'];
