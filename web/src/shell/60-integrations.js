// WHERE THE PORTAL ASKS PENTAL, THE REPORTER ANSWERS ITSELF.
//
// Pental's portal checks Pental for schema updates, asks Google for the fonts
// a firm picks, runs scheduled automation from Pental's servers and keeps a
// firm's settings in step with Pental's directory. None of that exists here:
// the server applies its own schema when it starts, every interface font a
// firm can pick is served by the server, and there is no directory.
//
// SPDX-License-Identifier: AGPL-3.0-only

// No update banner: the server applies the schema it ships with.
function _fetchExpectedSchemaVersion() { return Promise.resolve(0); }

// Every font Settings offers is served by this server and declared in
// fonts.css, so there is nothing to fetch.
function _loadFontFamilies() {}

// Scheduled automation (starting and completing engagements on their dates,
// reminders) runs from Pental's servers.
function _canRunSchedule() { return false; }
async function _scheduleHealth() { return null; }

// Sign-in emails and the directory.
async function _signinSetupMaybe() { return; }
async function _reverseSync() { return; }
