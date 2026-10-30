// Runs in <head> before the page paints: the light or dark theme and the
// accent colour this browser last saw, so the page does not flash. The app
// sets them properly from the firm's settings once it has loaded.
// SPDX-License-Identifier: AGPL-3.0-only
(function () {
  var el = document.documentElement;
  try {
    var b = JSON.parse(localStorage.getItem('pental_branding') || '{}');
    var mode = b.theme_mode;
    var saved = localStorage.getItem('pental-theme');
    var light = mode === 'light' || (mode !== 'dark' && (saved === 'light' || (!saved && window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches)));
    if (light) el.setAttribute('data-theme', 'light');
    var ac = b.accent_color;
    if (/^#[0-9a-f]{6}$/i.test(ac || '')) {
      el.style.setProperty('--accent', ac);
      el.style.setProperty('--accent-rgb', parseInt(ac.slice(1, 3), 16) + ',' + parseInt(ac.slice(3, 5), 16) + ',' + parseInt(ac.slice(5, 7), 16));
    }
  } catch (e) { /* the defaults */ }
})();
