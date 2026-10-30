// RESUMABLE UPLOADS (TUS 1.0.0), the route the portal uses for appliance
// images: create, send parts, resume from the offset after a dropped line.
//
//   POST   upload/resumable        Upload-Length, Upload-Metadata (bucketName,
//                                  objectName, contentType, cacheControl),
//                                  x-upsert -> 201 Location
//   HEAD   upload/resumable/:id    Upload-Offset, Upload-Length
//   PATCH  upload/resumable/:id    Upload-Offset + application/offset+octet-stream
//   DELETE upload/resumable/:id
//
// The policies are consulted when the upload is created (the object insert
// is tried and rolled back, so a refusal comes before the first byte, not
// after the last) and again when it completes, as the person who started
// it. Parts wait in storage.upload_parts and are moved under the object at
// the end; an upload nobody finishes is dropped after a day.
import crypto from 'node:crypto';
import { HttpError, readBody } from '../http.js';
import { requestHeaders, requestIp } from '../rest/index.js';
import { log } from '../log.js';
import { storageError, cleanName } from './index.js';

const TUS_VERSION = '1.0.0';
// 1.10.0: a part is held in memory while it is written, so its size is a
// gateway's memory per upload. Supabase's clients, the portal's and the
// database move's send 6 MB parts; 16 MB leaves room and no more (it was 64).
const MAX_PATCH = 16 * 1024 * 1024;

function parseMetadata(h) {
  const out = {};
  for (const pair of String(h || '').split(',')) {
    const [k, v] = pair.trim().split(' ');
    if (!k) continue;
    out[k] = v ? Buffer.from(v, 'base64').toString('utf8') : '';
  }
  return out;
}

export class Tus {
  constructor(storage) {
    this.storage = storage;
    this.db = storage.db;
    this.cfg = storage.cfg;
    this._sweep = setInterval(() => this.sweep().catch(() => {}), 30 * 60 * 1000);
    if (this._sweep.unref) this._sweep.unref();
  }

  stop() { if (this._sweep) clearInterval(this._sweep); }

  headers(extra) {
    return { 'Tus-Resumable': TUS_VERSION, 'Tus-Version': TUS_VERSION, 'Tus-Extension': 'creation,creation-with-upload,termination,expiration', 'Tus-Max-Size': String(64 * 1024 * 1024 * 1024), ...(extra || {}) };
  }

  async handle(req, res, url, id) {
    const method = req.method.toUpperCase();
    if (method === 'OPTIONS') { res.writeHead(204, this.headers()); res.end(); return; }
    if (!id && method === 'POST') return this.create(req, res, url);
    if (!id) throw storageError(404, '404', 'not_found', 'No such upload');
    if (method === 'HEAD') return this.head(req, res, url, id);
    if (method === 'PATCH') return this.patch(req, res, url, id);
    if (method === 'DELETE') return this.remove(req, res, url, id);
    throw storageError(405, '405', 'MethodNotAllowed', 'Method not allowed');
  }

  async find(id) {
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(id)) throw storageError(404, '404', 'not_found', 'No such upload');
    const r = await this.db.query('SELECT * FROM storage.uploads WHERE id = $1 AND expires_at > now()', [id]);
    if (!r.rows[0]) throw storageError(404, '404', 'not_found', 'No such upload');
    return r.rows[0];
  }

  ownerCheck(who, up) {
    const sub = who.claims && who.claims.sub ? String(who.claims.sub) : '';
    if (who.role === 'owner') return;
    if (String(up.owner || '') !== sub) throw storageError(403, '403', 'Unauthorized', 'This upload belongs to somebody else');
  }

  async create(req, res, url) {
    const who = this.storage.authz.resolve(req, url);
    const size = parseInt(req.headers['upload-length'], 10);
    if (!(size >= 0)) throw storageError(400, '400', 'InvalidRequest', 'Upload-Length is required');
    const meta = parseMetadata(req.headers['upload-metadata']);
    const bucketId = String(meta.bucketName || '');
    const name = cleanName(meta.objectName || '');
    const bucket = await this.storage.bucket(bucketId);
    if (bucket.file_size_limit && size > Number(bucket.file_size_limit)) throw storageError(413, '413', 'Payload too large', 'The object exceeded the maximum allowed size');
    const upsert = String(req.headers['x-upsert'] || '').toLowerCase() === 'true';
    const owner = who.claims && who.claims.sub ? who.claims.sub : null;
    const ctx = { role: who.role, claims: who.claims, headers: requestHeaders(req), clientIp: requestIp(req, this.storage && this.storage.cfg && this.storage.cfg.proxyHops), method: 'POST', path: url.pathname };
    // Would the policies let this person put that name there? Tried and
    // rolled back, so the answer comes now.
    await this.db.transaction(ctx, async (client) => {
      const existing = await client.query('SELECT id FROM storage.objects WHERE bucket_id = $1 AND name = $2', [bucketId, name]);
      if (existing.rows[0]) {
        if (!upsert) throw storageError(400, '409', 'Duplicate', 'The resource already exists');
        const u = await client.query('UPDATE storage.objects SET updated_at = updated_at WHERE bucket_id = $1 AND name = $2 RETURNING id', [bucketId, name]);
        if (!u.rows[0]) throw storageError(400, '403', 'Unauthorized', 'new row violates row-level security policy');
      } else {
        try {
          await client.query('INSERT INTO storage.objects (bucket_id, name, owner, owner_id, metadata) VALUES ($1, $2, $3, $4, $5)', [bucketId, name, owner, owner ? String(owner) : null, '{}']);
        } catch (e) {
          if (e.code === '42501') throw storageError(400, '403', 'Unauthorized', 'new row violates row-level security policy');
          throw e;
        }
      }
      throw { rollback: true };
    }).catch((e) => { if (!(e && e.rollback)) throw e; });
    const id = crypto.randomBytes(24).toString('base64url');
    await this.db.query('INSERT INTO storage.uploads (id, bucket_id, name, owner, claims, size, metadata, upsert) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [id, bucketId, name, owner, JSON.stringify({ role: who.role, claims: who.claims }), size, JSON.stringify({ contentType: meta.contentType || 'application/octet-stream', cacheControl: meta.cacheControl || '3600' }), upsert]);
    const location = '/storage/v1/upload/resumable/' + id;
    // An empty file is whole on arrival: stored before the answer, so a
    // caller that reads it straight back finds it.
    if (size === 0) await this.completeOrFail(id);
    res.writeHead(201, this.headers({ Location: location, 'Upload-Offset': '0', 'Upload-Expires': new Date(Date.now() + 86400000).toUTCString() }));
    res.end();
  }

  // The last byte is only acknowledged once the file is stored: a caller told
  // 204 can read it at once, and one whose file could not be stored hears so
  // (the parts stay, and the same PATCH, with no body, tries again).
  async completeOrFail(id) {
    try { await this.complete(id); }
    catch (e) {
      log.error('upload completion failed', { id, error: e.message });
      if (e instanceof HttpError) throw e;
      throw storageError(500, '500', 'InternalError', 'The upload arrived but could not be stored; send the last part again');
    }
  }

  async head(req, res, url, id) {
    const who = this.storage.authz.resolve(req, url);
    const up = await this.find(id);
    this.ownerCheck(who, up);
    res.writeHead(200, this.headers({ 'Upload-Offset': String(up.received), 'Upload-Length': String(up.size), 'Cache-Control': 'no-store' }));
    res.end();
  }

  async patch(req, res, url, id) {
    const who = this.storage.authz.resolve(req, url);
    const up = await this.find(id);
    this.ownerCheck(who, up);
    const offset = parseInt(req.headers['upload-offset'], 10);
    if (!(offset >= 0)) throw storageError(400, '400', 'InvalidRequest', 'Upload-Offset is required');
    if (!/application\/offset\+octet-stream/i.test(String(req.headers['content-type'] || ''))) throw storageError(415, '415', 'InvalidRequest', 'Content-Type must be application/offset+octet-stream');
    if (offset !== Number(up.received)) { res.writeHead(409, this.headers({ 'Upload-Offset': String(up.received) })); res.end(); return; }
    const chunk = await readBody(req, { limit: MAX_PATCH });
    if (offset + chunk.length > Number(up.size)) throw storageError(400, '400', 'InvalidRequest', 'The upload would exceed its declared length');
    const next = await this.db.asOwner(async (client) => {
      const cur = await client.query('SELECT received FROM storage.uploads WHERE id = $1 FOR UPDATE', [id]);
      if (!cur.rows[0] || Number(cur.rows[0].received) !== offset) throw storageError(409, '409', 'Conflict', 'The offset moved');
      const part = (await client.query('SELECT coalesce(max(part), -1) + 1 AS p FROM storage.upload_parts WHERE upload_id = $1', [id])).rows[0].p;
      if (chunk.length) await client.query('INSERT INTO storage.upload_parts (upload_id, part, data) VALUES ($1, $2, $3)', [id, part, chunk]);
      const u = await client.query('UPDATE storage.uploads SET received = received + $2, updated_at = now() WHERE id = $1 RETURNING received', [id, chunk.length]);
      return Number(u.rows[0].received);
    });
    if (next >= Number(up.size)) await this.completeOrFail(id);
    res.writeHead(204, this.headers({ 'Upload-Offset': String(next) }));
    res.end();
  }

  // The last byte arrived: the object row as the person who started it,
  // then the parts under it.
  async complete(id) {
    const up = (await this.db.query('SELECT * FROM storage.uploads WHERE id = $1', [id])).rows[0];
    if (!up) return;
    const saved = up.claims || {};
    const ctx = { role: saved.role || 'authenticated', claims: saved.claims || {}, headers: {}, method: 'POST', path: '/storage/v1/upload/resumable/' + id };
    const meta = up.metadata || {};
    const size = Number(up.size);
    const etag = '"' + crypto.createHash('md5').update(id + ':' + size).digest('hex') + '"';
    const metadata = { eTag: etag, size, mimetype: meta.contentType || 'application/octet-stream', cacheControl: 'max-age=' + (meta.cacheControl || '3600'), lastModified: new Date().toISOString(), contentLength: size, httpStatusCode: 200 };
    await this.db.transaction(ctx, async (client) => {
      const existing = await client.query('SELECT id FROM storage.objects WHERE bucket_id = $1 AND name = $2', [up.bucket_id, up.name]);
      let objectId;
      if (existing.rows[0]) {
        if (!up.upsert) throw storageError(400, '409', 'Duplicate', 'The resource already exists');
        const u = await client.query('UPDATE storage.objects SET metadata = $3, updated_at = now(), version = $4 WHERE bucket_id = $1 AND name = $2 RETURNING id', [up.bucket_id, up.name, JSON.stringify(metadata), crypto.randomUUID()]);
        if (!u.rows[0]) throw storageError(400, '403', 'Unauthorized', 'new row violates row-level security policy');
        objectId = u.rows[0].id;
      } else {
        const ins = await client.query('INSERT INTO storage.objects (bucket_id, name, owner, owner_id, metadata, version) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id', [up.bucket_id, up.name, up.owner, up.owner ? String(up.owner) : null, JSON.stringify(metadata), crypto.randomUUID()]);
        objectId = ins.rows[0].id;
      }
      await client.query('RESET ROLE');
      await this.storage.backend.adoptUpload(client, id, objectId, metadata.mimetype);
      await client.query('DELETE FROM storage.uploads WHERE id = $1', [id]);
    });
    log.info('resumable upload completed', { bucket: up.bucket_id, size });
  }

  async remove(req, res, url, id) {
    const who = this.storage.authz.resolve(req, url);
    const up = await this.find(id);
    this.ownerCheck(who, up);
    await this.db.query('DELETE FROM storage.uploads WHERE id = $1', [id]);
    res.writeHead(204, this.headers());
    res.end();
  }

  async sweep() {
    const r = await this.db.query('DELETE FROM storage.uploads WHERE expires_at < now() RETURNING id');
    if (r.rows.length) log.info('expired uploads dropped', { n: r.rows.length });
  }
}

export { HttpError };
