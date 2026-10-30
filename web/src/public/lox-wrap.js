/* THE ENGINE'S THREAD BOOTSTRAP, AS A REAL FILE (1280).
 *
 * [stated] Arian's console, twice: every worker thread dying on
 * `Loading the script 'data:text/javascript;charset=UTF-8,import(".../zetaHelper.js")...'
 * violates the following Content Security Policy directive`.
 *
 * ZetaOffice's loader builds that one-line wrapper as a `data:` URL and each
 * thread `importScripts` it. Allowing `data:` scripts is one way through; not
 * needing them is better, and does not depend on a header surviving every
 * proxy and cache between here and the browser. This is the same one line, as
 * a file on our own origin, and the frame points the loader at it.
 */
// 1336: AND THE EARLIEST PLACE IN A WORKER THAT IS OURS.
//
// [stated] Arian's console, a third time: `warning: unsupported syscall:
// __syscall_mprotect`, still there after 1332 filtered the frame and 1335
// filtered `lox-thread.js`. THE ORDER OF HIS OWN LOG IS THE ANSWER - the
// warning prints BEFORE `zetaHelper: Loading threadJs`, so the office thread
// had already started by the time our thread script arrived. A filter cannot
// catch a line printed before it is installed.
//
// This file is different: it is what EVERY worker thread imports to bootstrap
// itself, before it runs anything. It is the first code on our own origin in
// that scope, which makes it the only place early enough.
//
// Same rule as 1332: the known startup lines are demoted once, and anything
// else the office says comes through untouched. If it turns out even this is
// too late, the line is LibreOffice's own and unreachable, and that is a fact
// about the engine rather than something left undone.
(function () {
  var NOISE = [
    /^warning: unsupported syscall/,
    /QObject::connect\(QWindow, QtFrame\): invalid nullptr parameter/,
    /^QRect\(\d+,\d+ \d+x\d+\)/,
  ];
  var said = false;
  ['error', 'warn', 'log'].forEach(function (level) {
    var real = typeof console !== 'undefined' && console[level] && console[level].bind(console);
    if (!real) return;
    console[level] = function () {
      var first = arguments.length ? String(arguments[0]) : '';
      for (var i = 0; i < NOISE.length; i++) {
        if (NOISE[i].test(first)) {
          if (!said) {
            said = true;
            try { console.debug('[pdf engine] office startup notices suppressed in this thread.'); } catch (e) {}
          }
          return;
        }
      }
      return real.apply(console, arguments);
    };
  });
})();

import('/assets/zetaHelper.js').then(function (m) { m.zetaHelperWrapThread(); });
