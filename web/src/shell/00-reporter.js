// PENTAL REPORT'S SHELL.
//
// The engine (web/src/engine.js) is Pental's own reporting code, as Pental's
// portal runs it. These files are what makes it run on its own server: where
// its database is, which pages and modules it has, its own first-run page and
// navigation, and the way to Pental for what it leaves out. Every top-level
// name defined here replaces the engine's own.
//
// Copyright (c) Pental Limited.
// SPDX-License-Identifier: AGPL-3.0-only

var REPORTER = {
  name: 'Pental Report',
  version: '%%REPORTER_VERSION%%',
  // Pental, for what Pental Report leaves out. Tagged so a visit from here is
  // counted as one.
  pentalUrl: 'https://pental.io',
  // Where its source is published (AGPL-3.0, section 13).
  sourceUrl: 'https://github.com/pental-io/report',
  tag: 'utm_source=pental-report&utm_medium=app',
  config: null,
};

// The engine names its build for cache-busting (the Word-to-PDF engine's
// page is loaded with it): here, Pental Report's version.
var PENTAL_BUILD = 'report-%%REPORTER_VERSION%%';

function _reporterLink(path, campaign) {
  var p = path || '/';
  return REPORTER.pentalUrl + p + (p.indexOf('?') >= 0 ? '&' : '?') + REPORTER.tag + '&utm_campaign=' + encodeURIComponent(campaign || 'report');
}

// Pental's master directory does not exist here: an address that never
// resolves, so nothing can reach it by accident.
var SUPABASE_URL = 'https://pental-directory.invalid';
var SUPABASE_KEY = '';
var MASTER_SUPABASE_URL = 'https://pental-directory.invalid';
var MASTER_SUPABASE_KEY = '';
var TENANT_ID = null, TENANT_INFO = null, EFFECTIVE_SUPABASE_URL = SUPABASE_URL, EFFECTIVE_SUPABASE_KEY = SUPABASE_KEY;
var _byoRefused = false;
