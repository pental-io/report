// /storage/v1: files, the way Supabase Storage serves them to storage-js.
//
// The rows in storage.objects are written in the caller's own transaction
// (db.js), so the portal schema's policies on that table decide every upload,
// download, listing and deletion exactly as they do on Supabase. The bytes
// live in the database (backend-pg.js) or an S3-compatible bucket
// (backend-s3.js), keyed by the row's id, and are only touched once the row
// has passed.
//
//   POST/PUT  object/:bucket/*path        upload (x-upsert: true to replace)
//   GET       object/:bucket/*path        download, as the caller
//   GET       object/authenticated/...    the same
//   GET       object/public/...           a public bucket, no token needed
//   POST      object/sign/:bucket/*path   { expiresIn } -> { signedURL }
//   POST      object/sign/:bucket         { expiresIn, paths } -> [...]
//   GET       object/sign/:bucket/*path?token=   download by signed link
//   POST      object/upload/sign/...      { url, token } for one upload
//   PUT       object/upload/sign/...?token=      that upload
//   POST      object/list/:bucket         { prefix, limit, offset, sortBy, search }
//   DELETE    object/:bucket              { prefixes: [...] }
//   DELETE    object/:bucket/*path
//   POST      object/move | object/copy   { bucketId, sourceKey, destinationKey }
//   GET/HEAD  object/info/:bucket/*path
//   GET       bucket, bucket/:id
//   GET       status
//   *         upload/resumable[/id]       TUS (tus.js)
import crypto from 'node:crypto';
import { HttpError, readBody, sendJson, decodePart } from '../http.js';
import { signJwt, verifyLink, linkKey } from '../jwt.js';
import { requestHeaders, requestIp } from '../rest/index.js';
import { PgBackend } from './backend-pg.js';
import { S3Backend } from './backend-s3.js';
import { Tus } from './tus.js';
import { log } from '../log.js';

export function storageError(status, code, error, message) {
  return new HttpError(status, { statusCode: String(code), error, message });
}

const NAME_RE = /^[^\u0000-\u001f\u007f]{1,1024}$/;

export function cleanName(raw) {
  const s = String(raw || '').replace(/^\/+|\/+$/g, '').replace(/\/+/g, '/');
  if (!s || !NAME_RE.test(s) || s.split('/').some((p) => p === '.' || p === '..')) throw storageError(400, '400', 'InvalidKey', 'Invalid key: ' + String(raw || '').slice(0, 100));
  return s;
}

// A multipart/form-data body, enough for storage-js: the file part (any
// name) and text fields such as cacheControl.
export function parseMultipart(buf, contentType) {
  const m = /boundary=("?)([^";]+)\1/i.exec(contentType || '');
  if (!m) throw storageError(400, '400', 'InvalidRequest', 'multipart boundary missing');
  const boundary = Buffer.from('--' + m[2]);
  const fields = {};
  let file = null;
  let pos = buf.indexOf(boundary);
  while (pos >= 0) {
    pos += boundary.length;
    if (buf.slice(pos, pos + 2).toString() === '--') break;
    if (buf[pos] === 13 && buf[pos + 1] === 10) pos += 2;
    const headEnd = buf.indexOf('\r\n\r\n', pos);
    if (headEnd < 0) break;
    const head = buf.slice(pos, headEnd).toString('utf8');
    const next = buf.indexOf(boundary, headEnd + 4);
    const bodyEnd = next < 0 ? buf.length : next - 2;
    const body = buf.slice(headEnd + 4, bodyEnd);
    const name = (/name="([^"]*)"/i.exec(head) || [])[1] || '';
    const filename = (/filename="([^"]*)"/i.exec(head) || [])[1];
    const type = (/content-type:\s*([^\r\n]+)/i.exec(head) || [])[1];
    if (filename !== undefined || type) { if (!file) file = { name, filename: filename || '', type: (type || 'application/octet-stream').trim(), body }; }
    else fields[name] = body.toString('utf8');
    pos = next;
  }
  return { fields, file };
}

export class Storage {
  constructor({ db, cfg, authz, schema }) {
    this.db = db; this.cfg = cfg; this.authz = authz; this.schema = schema;
    this.backend = cfg.storage.backend === 's3' ? new S3Backend(cfg.storage.s3) : new PgBackend(db);
    this.tus = new Tus(this);
    this.largeInFlight = 0;
    this.largeWaiting = [];
  }

  largeSlot() {
    if (this.largeInFlight < this.cfg.storage.maxLargeUploads) { this.largeInFlight++; return Promise.resolve(); }
    return new Promise((resolve) => this.largeWaiting.push(resolve));
  }
  releaseSlot() {
    const next = this.largeWaiting.shift();
    if (next) next(); else this.largeInFlight = Math.max(0, this.largeInFlight - 1);
  }

  stop() { this.tus.stop(); }

  ctxFor(req, url, who) {
    return { role: who.role, claims: who.claims, headers: requestHeaders(req), clientIp: requestIp(req, this.cfg && this.cfg.proxyHops), method: req.method, path: url.pathname };
  }

  async handle(req, res, url, rest) {
    const method = req.method.toUpperCase();
    const path = String(rest || '').replace(/\/+$/, '');
    if (path === 'status' && method === 'GET') return sendJson(res, 200, { healthy: true, backend: this.backend.name });
    if (path === 'version' && method === 'GET') return sendJson(res, 200, { version: 'pental-gateway' });
    if (path === 'upload/resumable' || path.startsWith('upload/resumable/')) return this.tus.handle(req, res, url, path.slice('upload/resumable'.length).replace(/^\//, ''));
    if (path === 'bucket' && method === 'GET') return this.listBuckets(req, res, url);
    if (path.startsWith('bucket/') && method === 'GET') return this.getBucket(req, res, url, path.slice(7));
    if (path === 'bucket' && method === 'POST') return this.createBucket(req, res, url);
    if (path === 'object/move' && method === 'POST') return this.moveOrCopy(req, res, url, 'move');
    if (path === 'object/copy' && method === 'POST') return this.moveOrCopy(req, res, url, 'copy');
    if (path.startsWith('object/list/') && method === 'POST') return this.list(req, res, url, path.slice('object/list/'.length));
    if (path.startsWith('object/list-v2/') && method === 'POST') return this.list(req, res, url, path.slice('object/list-v2/'.length));
    if (path.startsWith('object/info/')) return this.info(req, res, url, path.slice('object/info/'.length), method);
    if (path.startsWith('object/public/') && (method === 'GET' || method === 'HEAD')) return this.download(req, res, url, path.slice('object/public/'.length), { publicOnly: true, head: method === 'HEAD' });
    if (path.startsWith('object/authenticated/') && (method === 'GET' || method === 'HEAD')) return this.download(req, res, url, path.slice('object/authenticated/'.length), { head: method === 'HEAD' });
    if (path.startsWith('object/sign/')) {
      const rest2 = path.slice('object/sign/'.length);
      if (method === 'GET' || method === 'HEAD') return this.download(req, res, url, rest2, { signed: url.searchParams.get('token') || '', head: method === 'HEAD' });
      if (method === 'POST') return rest2.includes('/') ? this.sign(req, res, url, rest2) : this.signMany(req, res, url, rest2);
    }
    if (path.startsWith('object/upload/sign/')) {
      const rest2 = path.slice('object/upload/sign/'.length);
      if (method === 'POST') return this.signUpload(req, res, url, rest2);
      if (method === 'PUT') return this.upload(req, res, url, rest2, { signedUpload: url.searchParams.get('token') || '' });
    }
    if (path.startsWith('object/')) {
      const rest2 = path.slice('object/'.length);
      if (method === 'POST' || method === 'PUT') return this.upload(req, res, url, rest2, { update: method === 'PUT' });
      if (method === 'GET' || method === 'HEAD') return this.download(req, res, url, rest2, { head: method === 'HEAD' });
      if (method === 'DELETE') return rest2.includes('/') ? this.removeOne(req, res, url, rest2) : this.removeMany(req, res, url, rest2);
    }
    throw storageError(404, '404', 'not_found', 'No such route');
  }

  // The path the router decoded is decoded once more: a signed link's name is
  // encoded here (signedPath) and again by supabase-js (encodeURI), and this
  // is what undoes the second. 1.10.0: safely (decodePart), so a name with a
  // % of its own is taken as written rather than failing the request.
  split(rest) {
    const i = rest.indexOf('/');
    if (i <= 0) throw storageError(400, '400', 'InvalidRequest', 'A bucket and an object name are required');
    return { bucket: decodePart(rest.slice(0, i)), name: cleanName(decodePart(rest.slice(i + 1))) };
  }

  async bucket(id) {
    const r = await this.db.query('SELECT * FROM storage.buckets WHERE id = $1', [id]);
    if (!r.rows[0]) throw storageError(404, '404', 'Bucket not found', 'Bucket not found');
    return r.rows[0];
  }

  // ── buckets ──────────────────────────────────────────────────────────────
  async listBuckets(req, res, url) {
    this.authz.resolve(req, url);
    const r = await this.db.query('SELECT id, name, owner, public, file_size_limit, allowed_mime_types, created_at, updated_at FROM storage.buckets ORDER BY name');
    sendJson(res, 200, r.rows);
  }
  async getBucket(req, res, url, id) {
    this.authz.resolve(req, url);
    const b = await this.bucket(decodePart(id));
    sendJson(res, 200, { id: b.id, name: b.name, owner: b.owner, public: b.public, file_size_limit: b.file_size_limit, allowed_mime_types: b.allowed_mime_types, created_at: b.created_at, updated_at: b.updated_at });
  }
  async createBucket(req, res, url) {
    const who = this.authz.resolve(req, url);
    if (who.role !== 'owner') throw storageError(403, '403', 'Unauthorized', 'Buckets are created by the setup, not by a session');
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    const id = cleanName(body.id || body.name);
    await this.db.query('INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types) VALUES ($1, $1, $2, $3, $4) ON CONFLICT (id) DO NOTHING', [id, !!body.public, body.file_size_limit || null, body.allowed_mime_types || null]);
    sendJson(res, 200, { name: id });
  }

  // ── upload ───────────────────────────────────────────────────────────────
  // A standard upload is held in memory while it is written, so only a few
  // large ones (over 8 MB, or of unknown size) are read at a time; the rest
  // wait their turn. Anything bigger than the limit belongs on the resumable
  // route, which works in parts.
  async readUpload(req) {
    const ct = String(req.headers['content-type'] || '');
    const declared = parseInt(req.headers['content-length'], 10);
    const large = !(Number.isFinite(declared) && declared <= 8 * 1024 * 1024);
    if (large) await this.largeSlot();
    let buf;
    try { buf = await readBody(req, { limit: this.cfg.storage.maxUploadBytes }); }
    catch (e) {
      if (e && e.status === 413) {
        // The connection closes with the answer, so the rest of an oversized
        // upload is not read for nothing.
        const big = storageError(413, '413', 'Payload too large', `The object exceeded the maximum allowed size (${Math.round(this.cfg.storage.maxUploadBytes / 1048576)} MB); use a resumable upload for larger files`);
        big.headers = { ...(big.headers || {}), Connection: 'close' };
        throw big;
      }
      throw e;
    } finally { if (large) this.releaseSlot(); }
    let body = buf, type = ct.split(';')[0].trim() || 'application/octet-stream', cacheControl = String(req.headers['cache-control'] || '');
    if (/^multipart\/form-data/i.test(ct)) {
      const m = parseMultipart(buf, ct);
      if (!m.file) throw storageError(400, '400', 'InvalidRequest', 'No file in the form');
      body = m.file.body; type = m.file.type;
      if (m.fields.cacheControl) cacheControl = 'max-age=' + m.fields.cacheControl;
    }
    if (!cacheControl) cacheControl = 'max-age=3600';
    return { body, type, cacheControl };
  }

  metadataFor(body, type, cacheControl) {
    const etag = '"' + crypto.createHash('md5').update(body).digest('hex') + '"';
    return { eTag: etag, size: body.length, mimetype: type, cacheControl, lastModified: new Date().toISOString(), contentLength: body.length, httpStatusCode: 200 };
  }

  async upload(req, res, url, rest, { update = false, signedUpload = '' } = {}) {
    const { bucket: bucketId, name } = this.split(rest);
    let who;
    if (signedUpload) {
      const v = verifyLink(signedUpload, this.cfg.jwtSecret);
      if (!v.ok || v.claims.url !== bucketId + '/' + name || v.claims.kind !== 'upload') throw storageError(400, '400', 'InvalidJWT', 'The upload link is not valid or has expired');
      who = { role: v.claims.role || 'authenticated', claims: v.claims.claims || { role: 'authenticated', sub: v.claims.owner } };
    } else who = this.authz.resolve(req, url);
    const bucket = await this.bucket(bucketId);
    const { body, type, cacheControl } = await this.readUpload(req);
    if (bucket.file_size_limit && body.length > Number(bucket.file_size_limit)) throw storageError(413, '413', 'Payload too large', 'The object exceeded the maximum allowed size');
    if (Array.isArray(bucket.allowed_mime_types) && bucket.allowed_mime_types.length && !bucket.allowed_mime_types.some((m) => m === type || (m.endsWith('/*') && type.startsWith(m.slice(0, -1))))) {
      throw storageError(415, '415', 'invalid_mime_type', `mime type ${type} is not supported`);
    }
    const upsert = String(req.headers['x-upsert'] || '').toLowerCase() === 'true';
    const metadata = this.metadataFor(body, type, cacheControl);
    const owner = who.claims && who.claims.sub ? who.claims.sub : null;
    const ctx = this.ctxFor(req, url, who);
    const out = await this.db.transaction(ctx, async (client) => {
      const existing = await client.query('SELECT id FROM storage.objects WHERE bucket_id = $1 AND name = $2', [bucketId, name]);
      let id;
      if (existing.rows[0]) {
        if (!update && !upsert) throw storageError(400, '409', 'Duplicate', 'The resource already exists');
        const u = await client.query('UPDATE storage.objects SET metadata = $3, owner = COALESCE(owner, $4), owner_id = COALESCE(owner_id, $5), updated_at = now(), last_accessed_at = now(), version = $6 WHERE bucket_id = $1 AND name = $2 RETURNING id',
          [bucketId, name, JSON.stringify(metadata), owner, owner ? String(owner) : null, crypto.randomUUID()]);
        if (!u.rows[0]) throw storageError(400, '403', 'Unauthorized', 'new row violates row-level security policy');
        id = u.rows[0].id;
      } else {
        if (update) throw storageError(404, '404', 'not_found', 'Object not found');
        let ins;
        try {
          ins = await client.query('INSERT INTO storage.objects (bucket_id, name, owner, owner_id, metadata, version) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
            [bucketId, name, owner, owner ? String(owner) : null, JSON.stringify(metadata), crypto.randomUUID()]);
        } catch (e) {
          if (e.code === '42501') throw storageError(400, '403', 'Unauthorized', 'new row violates row-level security policy');
          throw e;
        }
        id = ins.rows[0].id;
      }
      // The row passed the policies; the bytes are the gateway's to write.
      await client.query('RESET ROLE');
      await this.backend.put(client, id, body, type);
      return { id };
    });
    sendJson(res, 200, { Key: bucketId + '/' + name, Id: out.id });
  }

  // ── download ─────────────────────────────────────────────────────────────
  async download(req, res, url, rest, { publicOnly = false, signed = '', head = false } = {}) {
    const { bucket: bucketId, name } = this.split(rest);
    let row;
    if (publicOnly) {
      const bucket = await this.bucket(bucketId);
      if (!bucket.public) throw storageError(400, '400', 'InvalidRequest', 'Bucket is not public');
      row = (await this.db.query('SELECT id, name, metadata, updated_at FROM storage.objects WHERE bucket_id = $1 AND name = $2', [bucketId, name])).rows[0];
    } else if (signed) {
      const v = verifyLink(signed, this.cfg.jwtSecret);
      if (!v.ok || v.claims.url !== bucketId + '/' + name || v.claims.kind !== 'download') throw storageError(400, '400', 'InvalidJWT', 'The link is not valid or has expired');
      row = (await this.db.query('SELECT id, name, metadata, updated_at FROM storage.objects WHERE bucket_id = $1 AND name = $2', [bucketId, name])).rows[0];
    } else {
      const who = this.authz.resolve(req, url);
      row = await this.db.transaction(this.ctxFor(req, url, who), async (client) => (await client.query('SELECT id, name, metadata, updated_at FROM storage.objects WHERE bucket_id = $1 AND name = $2', [bucketId, name])).rows[0]);
    }
    if (!row) throw storageError(404, '404', 'not_found', 'Object not found');
    const meta = row.metadata || {};
    const size = Number(meta.size ?? meta.contentLength ?? 0);
    const headers = {
      'Content-Type': meta.mimetype || 'application/octet-stream',
      'Cache-Control': meta.cacheControl || 'max-age=3600',
      'Last-Modified': new Date(row.updated_at || Date.now()).toUTCString(),
      'Accept-Ranges': 'bytes',
    };
    if (meta.eTag) headers.ETag = meta.eTag;
    const dl = url.searchParams.get('download');
    if (dl !== null) {
      const fname = (dl || name.split('/').pop() || 'file').replace(/["\r\n]/g, '');
      headers['Content-Disposition'] = `attachment; filename="${fname}"; filename*=UTF-8''${encodeURIComponent(fname)}`;
    }
    if (req.headers['if-none-match'] && meta.eTag && req.headers['if-none-match'] === meta.eTag) { res.writeHead(304, headers); res.end(); return; }
    let start = 0, end = null, status = 200;
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
    if (range && size > 0 && !head) {
      if (range[1] === '' && range[2] !== '') { start = Math.max(0, size - parseInt(range[2], 10)); end = size - 1; }
      else { start = parseInt(range[1], 10) || 0; end = range[2] === '' ? size - 1 : Math.min(size - 1, parseInt(range[2], 10)); }
      if (start > end || start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); res.end(); return; }
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
      headers['Content-Length'] = String(end - start + 1);
    } else if (size > 0 || meta.size === 0) {
      headers['Content-Length'] = String(size);
    }
    res.writeHead(status, headers);
    if (head) { res.end(); return; }
    this.db.query('UPDATE storage.objects SET last_accessed_at = now() WHERE id = $1', [row.id]).catch(() => {});
    await this.backend.stream(row.id, res, { start, end });
  }

  // ── signed links ─────────────────────────────────────────────────────────
  async visible(req, url, who, bucketId, name) {
    return this.db.transaction(this.ctxFor(req, url, who), async (client) => (await client.query('SELECT id FROM storage.objects WHERE bucket_id = $1 AND name = $2', [bucketId, name])).rows[0]);
  }

  signedPath(bucketId, name, expiresIn) {
    const exp = Math.floor(Date.now() / 1000) + Math.max(1, Math.min(7 * 86400, parseInt(expiresIn, 10) || 60));
    const token = signJwt({ url: bucketId + '/' + name, kind: 'download', iat: Math.floor(Date.now() / 1000), exp }, linkKey(this.cfg.jwtSecret));
    return '/object/sign/' + bucketId + '/' + name.split('/').map(encodeURIComponent).join('/') + '?token=' + token;
  }

  async sign(req, res, url, rest) {
    const who = this.authz.resolve(req, url);
    const { bucket: bucketId, name } = this.split(rest);
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    const row = await this.visible(req, url, who, bucketId, name);
    if (!row) throw storageError(404, '404', 'not_found', 'Object not found');
    sendJson(res, 200, { signedURL: this.signedPath(bucketId, name, body.expiresIn) });
  }

  async signMany(req, res, url, bucketId) {
    const who = this.authz.resolve(req, url);
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    const paths = Array.isArray(body.paths) ? body.paths.slice(0, 1000) : [];
    const out = [];
    for (const p of paths) {
      let name;
      try { name = cleanName(p); } catch { out.push({ error: 'Invalid key', path: p, signedURL: null }); continue; }
      const row = await this.visible(req, url, who, decodePart(bucketId), name);
      out.push(row ? { error: null, path: name, signedURL: this.signedPath(decodePart(bucketId), name, body.expiresIn) } : { error: 'Object not found', path: name, signedURL: null });
    }
    sendJson(res, 200, out);
  }

  async signUpload(req, res, url, rest) {
    const who = this.authz.resolve(req, url);
    const { bucket: bucketId, name } = this.split(rest);
    await this.bucket(bucketId);
    // The upload itself runs the policies; this only proves the caller may
    // ask, and binds the link to them.
    const exp = Math.floor(Date.now() / 1000) + 7200;
    const token = signJwt({ url: bucketId + '/' + name, kind: 'upload', role: who.role, claims: who.claims, owner: who.claims.sub || null, exp }, linkKey(this.cfg.jwtSecret));
    sendJson(res, 200, { url: '/object/upload/sign/' + bucketId + '/' + name.split('/').map(encodeURIComponent).join('/') + '?token=' + token, token });
  }

  // ── list ─────────────────────────────────────────────────────────────────
  async list(req, res, url, bucketId) {
    const who = this.authz.resolve(req, url);
    bucketId = decodePart(bucketId);
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    let prefix = String(body.prefix || '').replace(/^\/+|\/+$/g, '');
    if (prefix) prefix += '/';
    const limit = Math.max(1, Math.min(10000, parseInt(body.limit, 10) || 100));
    const offset = Math.max(0, parseInt(body.offset, 10) || 0);
    const sortCol = (body.sortBy && ['name', 'updated_at', 'created_at', 'last_accessed_at'].includes(body.sortBy.column)) ? body.sortBy.column : 'name';
    const sortDesc = !!(body.sortBy && String(body.sortBy.order).toLowerCase() === 'desc');
    const search = String(body.search || '').toLowerCase();
    const rows = await this.db.transaction(this.ctxFor(req, url, who), async (client) =>
      (await client.query('SELECT id, name, updated_at, created_at, last_accessed_at, metadata FROM storage.objects WHERE bucket_id = $1 AND name LIKE $2 ORDER BY name', [bucketId, prefix.replace(/[%_\\]/g, '\\$&') + '%'])).rows);
    const files = [];
    const folders = new Map();
    for (const r of rows) {
      const rest = r.name.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash >= 0) {
        const folder = rest.slice(0, slash);
        if (folder && !folders.has(folder)) folders.set(folder, { name: folder, id: null, updated_at: null, created_at: null, last_accessed_at: null, metadata: null });
      } else if (rest) {
        files.push({ name: rest, id: r.id, updated_at: r.updated_at, created_at: r.created_at, last_accessed_at: r.last_accessed_at, metadata: r.metadata });
      }
    }
    let all = [...folders.values(), ...files];
    if (search) all = all.filter((x) => x.name.toLowerCase().includes(search));
    all.sort((a, b) => {
      const av = a[sortCol] == null ? '' : String(a[sortCol]);
      const bv = b[sortCol] == null ? '' : String(b[sortCol]);
      const c = av < bv ? -1 : av > bv ? 1 : 0;
      return sortDesc ? -c : c;
    });
    sendJson(res, 200, all.slice(offset, offset + limit));
  }

  // ── info ─────────────────────────────────────────────────────────────────
  async info(req, res, url, rest, method) {
    const who = this.authz.resolve(req, url);
    const { bucket: bucketId, name } = this.split(rest);
    const row = await this.db.transaction(this.ctxFor(req, url, who), async (client) => (await client.query('SELECT id, name, bucket_id, version, created_at, updated_at, last_accessed_at, metadata FROM storage.objects WHERE bucket_id = $1 AND name = $2', [bucketId, name])).rows[0]);
    if (!row) throw storageError(404, '404', 'not_found', 'Object not found');
    if (method === 'HEAD') {
      const meta = row.metadata || {};
      res.writeHead(200, { 'Content-Type': meta.mimetype || 'application/octet-stream', 'Content-Length': String(meta.size || 0), 'Cache-Control': meta.cacheControl || 'max-age=3600', ETag: meta.eTag || '', 'Last-Modified': new Date(row.updated_at).toUTCString() });
      res.end(); return;
    }
    sendJson(res, 200, { id: row.id, name: row.name, bucket_id: row.bucket_id, version: row.version, created_at: row.created_at, updated_at: row.updated_at, last_accessed_at: row.last_accessed_at, metadata: row.metadata, size: (row.metadata || {}).size, content_type: (row.metadata || {}).mimetype, etag: (row.metadata || {}).eTag, cache_control: (row.metadata || {}).cacheControl });
  }

  // ── remove ───────────────────────────────────────────────────────────────
  async removeMany(req, res, url, bucketId) {
    const who = this.authz.resolve(req, url);
    bucketId = decodePart(bucketId);
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    const names = (Array.isArray(body.prefixes) ? body.prefixes : []).map((p) => { try { return cleanName(p); } catch { return null; } }).filter(Boolean);
    const deleted = await this.db.transaction(this.ctxFor(req, url, who), async (client) => {
      const d = await client.query('DELETE FROM storage.objects WHERE bucket_id = $1 AND name = ANY($2::text[]) RETURNING id, name, bucket_id, owner, created_at, updated_at, last_accessed_at, metadata', [bucketId, names]);
      await client.query('RESET ROLE');
      await this.backend.remove(client, d.rows.map((r) => r.id));
      return d.rows;
    });
    sendJson(res, 200, deleted);
  }
  async removeOne(req, res, url, rest) {
    const who = this.authz.resolve(req, url);
    const { bucket: bucketId, name } = this.split(rest);
    const n = await this.db.transaction(this.ctxFor(req, url, who), async (client) => {
      const d = await client.query('DELETE FROM storage.objects WHERE bucket_id = $1 AND name = $2 RETURNING id', [bucketId, name]);
      await client.query('RESET ROLE');
      await this.backend.remove(client, d.rows.map((r) => r.id));
      return d.rows.length;
    });
    if (!n) throw storageError(404, '404', 'not_found', 'Object not found');
    sendJson(res, 200, { message: 'Successfully deleted' });
  }

  // ── move and copy ────────────────────────────────────────────────────────
  async moveOrCopy(req, res, url, kind) {
    const who = this.authz.resolve(req, url);
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    const bucketId = String(body.bucketId || '');
    const destBucket = String(body.destinationBucket || bucketId);
    const from = cleanName(body.sourceKey);
    const to = cleanName(body.destinationKey);
    await this.bucket(bucketId); await this.bucket(destBucket);
    const out = await this.db.transaction(this.ctxFor(req, url, who), async (client) => {
      const src = (await client.query('SELECT id, metadata, owner, owner_id FROM storage.objects WHERE bucket_id = $1 AND name = $2', [bucketId, from])).rows[0];
      if (!src) throw storageError(404, '404', 'not_found', 'Object not found');
      if (kind === 'move') {
        const u = await client.query('UPDATE storage.objects SET name = $3, bucket_id = $4, updated_at = now() WHERE bucket_id = $1 AND name = $2 RETURNING id', [bucketId, from, to, destBucket]);
        if (!u.rows[0]) throw storageError(400, '403', 'Unauthorized', 'new row violates row-level security policy');
        return { id: u.rows[0].id };
      }
      let ins;
      try {
        ins = await client.query('INSERT INTO storage.objects (bucket_id, name, owner, owner_id, metadata, version) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id', [destBucket, to, src.owner, src.owner_id, JSON.stringify(src.metadata || {}), crypto.randomUUID()]);
      } catch (e) {
        if (e.code === '42501') throw storageError(400, '403', 'Unauthorized', 'new row violates row-level security policy');
        if (e.code === '23505') throw storageError(400, '409', 'Duplicate', 'The resource already exists');
        throw e;
      }
      await client.query('RESET ROLE');
      await this.backend.copy(client, src.id, ins.rows[0].id);
      return { id: ins.rows[0].id };
    });
    if (kind === 'move') return sendJson(res, 200, { message: 'Successfully moved' });
    sendJson(res, 200, { Key: destBucket + '/' + to, Id: out.id });
  }
}

export { log };
