/* LIBREOFFICE IN THE BROWSER: THE OFFICE-THREAD HALF (1275).
 *
 * [stated] Arian: "dude it is not converting the docx properly obviously
 * figure out a better converter solution more modern and pixel perfect", and
 * then "1" - LibreOffice compiled to WebAssembly, running in the browser.
 *
 * Why this exists at all: the converter Pental shipped until now lays a
 * document out with an HTML renderer and transcribes that to PDF. An HTML
 * renderer does not draw Word charts, SmartArt or several field types, so a
 * template that uses them comes out with blank areas no matter how good the
 * transcription is. This runs LibreOffice's own layout engine instead - the
 * same engine that opens the file on a desktop - so what it cannot draw is
 * only what LibreOffice itself cannot draw.
 *
 * This file runs INSIDE the office web worker, loaded by ZetaOffice's own
 * `soffice.js`. It never touches the network: the document arrives as bytes
 * over a message port and the PDF goes back the same way. Nothing is uploaded
 * anywhere, by anyone, which is the rule this product is built on.
 */
'use strict';

// 1335: THE ONE NOISE LINE THAT ESCAPED, BECAUSE IT IS NOT IN THE FRAME.
//
// 1332 quietened LibreOffice's startup chatter by overriding `console` in
// `pdf-engine.html`. `warning: unsupported syscall: __syscall_mprotect` still
// got through, and the stack in Arian's console says why: `threadPrintErr` ->
// `_emscripten_err` -> `invokeEntryPoint`, which is the OFFICE WORKER's own
// stack. A worker has its own global scope and its own console; an override in
// the frame cannot reach it.
//
// This file is the one piece of the worker Pental serves - from its own origin,
// loaded by soffice.js as the thread script - so it is the only place the
// override can be installed on that side. Same rule as 1332: the known lines
// are demoted once, anything else the office says comes through untouched.
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
            try { console.debug('[pdf engine] office-thread startup notices suppressed; '
              + 'they are unrelated to the PDF.'); } catch (e) {}
          }
          return;
        }
      }
      return real.apply(console, arguments);
    };
  });
})();

const zetajs = globalThis.zetajsStore.zetajs;
const css = zetajs.uno.com.sun.star;
const context = zetajs.getUnoComponentContext();
const desktop = css.frame.Desktop.create(context);

function prop(name, value) {
  return new css.beans.PropertyValue({ Name: name, Handle: 0, Value: value, State: css.beans.PropertyState.DIRECT_VALUE });
}

// 1282: THE FILES ARE THE PAGE'S, NOT OURS. Emscripten proxies LibreOffice's
// file syscalls to the main thread, so the file system LibreOffice reads is
// the one in the PAGE's JavaScript context, not this worker's. Writing the
// document here produced a file this thread could see and LibreOffice could
// not, which is what `IllegalArgumentException` on load meant. The page writes
// the input and reads the output; this thread only converts.
function convert(id, inPath, outPath, filterName) {
  var step = 'starting';
  try {
    step = 'opening the document';
    // NOT read-only: the table of contents has to be rebuilt before export,
    // and LibreOffice will not update a field in a document it cannot edit.
    const doc = desktop.loadComponentFromURL('file://' + inPath, '_blank', 0, [
      prop('Hidden', true),
    ]);
    if (!doc) throw new Error('LibreOffice opened nothing');
    try {
      // 1286: BUILD THE CONTENTS BEFORE PRINTING IT.
      //
      // [stated] Arian: "table of contents not updating". Word rebuilds a TOC
      // when the document is opened; LibreOffice converting from the command
      // line does not, and Pental deliberately BLANKS the cached TOC on the way
      // out (so Word cannot show another engagement's headings). The two
      // together mean the PDF prints an empty contents page. So: refresh the
      // fields, update every index, then let the layout settle so the page
      // numbers in the contents are the pages the text actually lands on.
      step = 'updating the fields';
      try { doc.getTextFields().refresh(); } catch (e) {}
      step = 'rebuilding the table of contents';
      try {
        const idx = doc.getDocumentIndexes();
        for (let i = 0; i < idx.getCount(); i++) { try { idx.getByIndex(i).update(); } catch (e) {} }
      } catch (e) {}
      step = 'settling the layout';
      try { doc.refresh(); } catch (e) {}
      try { doc.getTextFields().refresh(); } catch (e) {}
      step = 'writing the PDF';
      // 1288: NOT THE EXPORT DEFAULTS. LibreOffice re-encodes every image as
      // JPEG at quality 90 on the way out, and a penetration test report is
      // mostly screenshots of terminals and web interfaces, where that is
      // visible mush around small text. Lossless, and no downsampling.
      //
      // Tried with the filter data and again without it: an older bridge that
      // cannot marshal a nested sequence loses the image quality, not the PDF.
      var _store = function (withData) {
        var args = [
          prop('FilterName', filterName || 'writer_pdf_Export'),
          prop('Overwrite', true),
        ];
        if (withData) args.push(prop('FilterData', [
          prop('UseLosslessCompression', true),
          prop('ReduceImageResolution', false),
        ]));
        doc.storeToURL('file://' + outPath, args);
      };
      try { _store(true); } catch (e) { _store(false); }
    } finally {
      try { doc.close(false); } catch (e) {}
    }
    zetajs.mainPort.postMessage({ pentalPdf: id, ok: true, outPath: outPath });
  } catch (e) {
    var msg = (e && (e.message || e.name)) || String(e);
    zetajs.mainPort.postMessage({ pentalPdf: id, ok: false, error: msg + ' (' + step + ')' });
  }
}

// 1283: which fonts this engine actually has. A template naming a font the
// engine lacks is laid out in whatever LibreOffice substitutes, and the
// substitute's metrics are what shift the page.
function fontNames() {
  try {
    const tk = css.awt.Toolkit.create(context);
    const dev = tk.createScreenCompatibleDevice(64, 64);
    const list = dev.getFontDescriptors();
    const seen = {};
    for (let i = 0; i < list.length; i++) { const n = list[i].Name; if (n) seen[n] = 1; }
    return Object.keys(seen);
  } catch (e) { return []; }
}

zetajs.mainPort.onmessage = function (ev) {
  const d = ev.data || {};
  if (d.pentalFonts) { zetajs.mainPort.postMessage({ pentalFontList: fontNames() }); return; }
  if (d.pentalConvert) convert(d.pentalConvert, d.inPath, d.outPath, d.filter);
};

// Tell the page the office is up and this script is listening.
zetajs.mainPort.postMessage({ pentalReady: true });
