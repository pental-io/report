// THE APP'S OWN FILES, FROM THIS SERVER.
//
// The built app (web/dist) is served from the same address as its API, so
// nothing crosses origins and no address is configured twice. Anything that
// is not a file under /assets is the app's page (it routes itself). The
// headers are the Pental portal's own: a content policy that lets scripts
// come from here alone, no framing, no sniffing. 2069: the in-browser
// Word-to-PDF engine is a frame of engine.pental.io, an address of its own, so
// its code (from its CDN) cannot reach this app's session; this server no
// longer serves its page.
import fs from 'node:fs';
import path from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.wasm': 'application/wasm',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.txt': 'text/plain; charset=utf-8', '.map': 'application/json',
};
const ENGINE = 'https://engine.pental.io';   // 2069: the Word-to-PDF engine's own address
const APP_CSP = "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; worker-src 'self' blob:; "
  + "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; "
  + "img-src 'self' data: blob: https:; connect-src 'self' wss: ws: https: http://localhost:* http://127.0.0.1:*; "
  + `frame-src 'self' blob: ${ENGINE}; frame-ancestors 'self'; object-src 'none'; base-uri 'self'; form-action 'self'`;

function secure(req) {
  return String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https' || !!(req.socket && req.socket.encrypted);
}

export class Web {
  constructor({ cfg }) {
    this.dir = cfg.webDir;
    this.indexCache = null;
  }

  ready() { return fs.existsSync(path.join(this.dir, 'index.html')); }

  headers(req, file) {
    const h = {
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
      'Cross-Origin-Resource-Policy': 'same-site',
    };
    const base = path.basename(file);
    h['Content-Security-Policy'] = APP_CSP;
    h['X-Frame-Options'] = 'SAMEORIGIN';
    if (base === 'index.html') h['Cache-Control'] = 'no-cache, must-revalidate';
    else if (file.includes(path.sep + 'assets' + path.sep)) h['Cache-Control'] = 'public, max-age=31536000, immutable';
    else h['Cache-Control'] = 'no-cache';
    if (secure(req)) h['Strict-Transport-Security'] = 'max-age=63072000; includeSubDomains';
    return h;
  }

  // true when it answered.
  serve(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    let rel;
    try { rel = decodeURIComponent(url.pathname); } catch { return false; }
    if (rel.includes('\0')) return false;
    let file = path.join(this.dir, path.normalize(rel).replace(/^([/\\])+/, ''));
    if (!file.startsWith(this.dir + path.sep) && file !== this.dir) return false;
    let st = null;
    try { st = fs.statSync(file); } catch { st = null; }
    if (!st || st.isDirectory()) {
      // A file the app asks for that is not there is a 404; anything else is
      // the app's own page, which routes itself.
      if (/^\/assets\//.test(rel) || /\.[a-z0-9]{2,5}$/i.test(rel)) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
        res.end('Not found');
        return true;
      }
      file = path.join(this.dir, 'index.html');
      try { st = fs.statSync(file); } catch { st = null; }
      if (!st) {
        res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('The app has not been built: run `node web/build.mjs`, or build the Docker image.');
        return true;
      }
    }
    const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
    // The build keeps a Brotli and a gzip copy beside each text file; send
    // the one this browser takes.
    const accepts = String(req.headers['accept-encoding'] || '');
    let body = file, encoding = null;
    for (const [enc, ext] of [['br', '.br'], ['gzip', '.gz']]) {
      if (!new RegExp('\\b' + enc + '\\b').test(accepts)) continue;
      try { const s2 = fs.statSync(file + ext); if (s2.isFile()) { body = file + ext; encoding = enc; st = s2; break; } } catch { /* no copy */ }
    }
    const h = { 'Content-Type': type, 'Content-Length': st.size, Vary: 'Accept-Encoding', ...this.headers(req, file) };
    if (encoding) h['Content-Encoding'] = encoding;
    res.writeHead(200, h);
    if (req.method === 'HEAD') { res.end(); return true; }
    fs.createReadStream(body).pipe(res);
    return true;
  }
}
