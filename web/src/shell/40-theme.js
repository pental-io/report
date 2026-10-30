// Light and dark. The portal keeps these in its head script; Pental Report's
// head script is smaller, so they are here.
// SPDX-License-Identifier: AGPL-3.0-only
function _isThemeForced() {
  try {
    var b = JSON.parse(localStorage.getItem('pental_branding') || '{}');
    return b.theme_mode && b.theme_mode !== 'both';
  } catch (e) { return false; }
}
function toggleTheme() {
  if (_isThemeForced()) return;
  var current = document.documentElement.getAttribute('data-theme');
  var next = current === 'light' ? 'dark' : 'light';
  if (next === 'dark') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem('pental-theme', next); } catch (e) {}
  // The firm's colours, fonts and logo for that theme, as the portal's own
  // toggle sets them: without these the page kept the colours it had.
  try { applyThemeColors(); } catch (e) {}
  try { applyFonts(); } catch (e) {}
  try { _refreshThemedLogos(); } catch (e) {}
  updateThemeIcon();
}
function updateThemeIcon() {
  var btn = document.getElementById('portalThemeBtn');
  if (!btn) return;
  var isDark = document.documentElement.getAttribute('data-theme') !== 'light';
  btn.innerHTML = isDark
    ? '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v2m0 18v2M4.22 4.22l1.42 1.42m12.73 12.73l1.42 1.42M1 12h2m18 0h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>'
    : '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1111.21 3a7 7 0 009.79 9.79z"/></svg>';
}
if (window.matchMedia) {
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', function (e) {
    if (_isThemeForced()) return;
    var saved = null;
    try { saved = localStorage.getItem('pental-theme'); } catch (x) {}
    if (!saved) {
      if (e.matches) document.documentElement.setAttribute('data-theme', 'light');
      else document.documentElement.removeAttribute('data-theme');
    }
  });
}
