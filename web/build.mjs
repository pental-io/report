#!/usr/bin/env node
// BUILDS PENTAL REPORT'S APP into web/dist, which the server serves.
//
//   node web/build.mjs            plain, readable output
//   node web/build.mjs --minify   smaller (needs `npm install` in web/ for terser)
//
// One script for the whole app, in this order: the two libraries the
// document preview needs on the page (JSZip and docx-preview, exactly as
// published), the stand-ins (src/stubs.js), the shell (src/shell/*.js, in
// name order), then the engine (src/engine.js). Function names in one script
// are shared, so the shell's definitions are the ones that run. The other
// libraries are served as their publishers released them, from
// /assets/vendor, and loaded when a page needs one.
//
// SPDX-License-Identifier: AGPL-3.0-only
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(here, 'src');
const DIST = path.join(here, 'dist');
const minifyWanted = process.argv.includes('--minify');
const version = JSON.parse(fs.readFileSync(path.join(here, '..', 'server', 'package.json'), 'utf8')).version;
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8');
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 10);

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(path.join(DIST, 'assets'), { recursive: true });

// ── The app's script ───────────────────────────────────────────────────────
const shellFiles = fs.readdirSync(path.join(SRC, 'shell')).filter((f) => f.endsWith('.js')).sort();
let app = [read('stubs.js'), ...shellFiles.map((f) => `// ── shell/${f} ──\n` + read(path.join('shell', f))), read('engine.js')].join('\n;\n');
app = app.split('%%REPORTER_VERSION%%').join(version);
// The methodology library's text, fetched when a template is previewed or
// added, named by its content so a browser never keeps an old one.
const libText = JSON.stringify(JSON.parse(read('methodology-library.json')));
const libFile = `methodology-library.${hash(libText)}.json`;
if (app.split('%%CRB_LIBRARY_FILE%%').length !== 2) throw new Error('the app names the methodology library other than once');
app = app.split('%%CRB_LIBRARY_FILE%%').join(libFile);
const leftover = app.match(/%%(SUPABASE_URL|SUPABASE_PUBLISHABLE_KEY|MASTER_SUPABASE_URL|MASTER_SUPABASE_PUBLISHABLE_KEY|REPORTER_VERSION|CRB_LIBRARY_FILE)%%/g);
if (leftover) throw new Error('placeholders left in the app: ' + [...new Set(leftover)].join(', '));
// It must parse: a broken script shows a blank page with no other clue.
{
  const vm = await import('node:vm');
  try { new vm.Script(app, { filename: 'app.js' }); } catch (e) { throw new Error('the app does not parse: ' + e.message + '\n' + String(e.stack || '').split('\n').slice(0, 3).join('\n')); }
}
if (minifyWanted) {
  const { minify } = await import('terser');
  const r = await minify(app, { compress: { passes: 2, drop_debugger: true }, mangle: false, format: { comments: /SPDX|Copyright/ } });
  app = r.code;
}
const vendorDir = (prefix) => {
  const d = fs.readdirSync(path.join(SRC, 'vendor')).find((x) => x.startsWith(prefix));
  if (!d) throw new Error('missing src/vendor/' + prefix + '*');
  return 'vendor/' + d;
};
const pre = [vendorDir('jszip-') + '/jszip.min.js', vendorDir('docx-preview-') + '/docx-preview.min.js'].map(read).join('\n;\n') + '\n;\n';
app = pre + app;
const appFile = `app-${hash(app)}.js`;
fs.writeFileSync(path.join(DIST, 'assets', appFile), app);

// ── Styles ─────────────────────────────────────────────────────────────────
const css = read('styles.css') + '\n' + read('reporter.css');
const cssFile = `style-${hash(css)}.css`;
fs.writeFileSync(path.join(DIST, 'assets', cssFile), css);

// ── Libraries and the files the app loads by name ─────────────────────────
fs.cpSync(path.join(SRC, 'vendor'), path.join(DIST, 'assets', 'vendor'), { recursive: true });
fs.cpSync(path.join(SRC, 'public'), path.join(DIST, 'assets'), { recursive: true });
fs.writeFileSync(path.join(DIST, 'assets', libFile), libText);
const sb = fs.readFileSync(path.join(SRC, 'vendor', 'supabase-js-2.39.3', 'supabase.js'), 'utf8');
const sbFile = `supabase-js-2.39.3.${hash(sb)}.js`;
fs.writeFileSync(path.join(DIST, 'assets', sbFile), sb);
fs.copyFileSync(path.join(SRC, 'vendor', 'supabase-js-2.39.3', '26.supabase.js'), path.join(DIST, 'assets', '26.supabase.js'));

// ── The page ──────────────────────────────────────────────────────────────
const theme = read('theme-inline.js');
const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex, nofollow">
<meta name="generator" content="Pental Report ${version}">
<title id="pageTitle">Pental Report</title>
<link rel="icon" id="faviconLink" href="/assets/favicon.svg" type="image/svg+xml">
<style>@keyframes xspin{to{transform:rotate(360deg)}}body{margin:0;background:#0c0c0c}html[data-theme="light"] body{background:#ebebef}body:not(.loaded) #app{visibility:hidden}</style>
<script>${theme}</script>
<link rel="stylesheet" href="/assets/fonts/fonts.css">
<link rel="stylesheet" href="/assets/${cssFile}">
</head>
<body>
<div id="app"></div>
<script src="/assets/${sbFile}"></script>
<script src="/assets/${appFile}"></script>
<script src="/assets/vendor/jspdf-2.5.1/jspdf.umd.min.js" defer></script>
<script src="/assets/vendor/pizzip-3.2.0/pizzip.min.js" defer></script>
<script src="/assets/vendor/docxtemplater-3.68.3/docxtemplater.min.js" defer></script>
</body>
</html>
`;
fs.writeFileSync(path.join(DIST, 'index.html'), html);

// ── Compressed copies ─────────────────────────────────────────────────────
// Brotli and gzip copies of every text file worth compressing, made once
// here so the server never compresses on a request (lib/web.js picks the
// copy the browser accepts).
const zlib = await import('node:zlib');
const COMPRESS = /\.(js|mjs|css|html|svg|json|txt|map)$/i;
let squeezed = 0;
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const f = path.join(d, e.name);
    if (e.isDirectory()) { walk(f); continue; }
    if (!COMPRESS.test(e.name)) continue;
    const buf = fs.readFileSync(f);
    if (buf.length < 1024) continue;
    fs.writeFileSync(f + '.br', zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length } }));
    fs.writeFileSync(f + '.gz', zlib.gzipSync(buf, { level: 9 }));
    squeezed++;
  }
};
walk(DIST);

// Readable by whoever runs the server (the image runs it as an ordinary
// user), whatever permissions the files were checked out with.
const open_ = (d) => {
  fs.chmodSync(d, 0o755);
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const f = path.join(d, e.name);
    if (e.isDirectory()) open_(f); else fs.chmodSync(f, 0o644);
  }
};
open_(DIST);
console.log(`built ${version}: assets/${appFile} (${Math.round(app.length / 1024)} KB), assets/${cssFile} (${Math.round(css.length / 1024)} KB), ${squeezed} files compressed`);
