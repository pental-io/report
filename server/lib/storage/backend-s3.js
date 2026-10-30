// FILE BYTES IN AN S3-COMPATIBLE BUCKET: AWS S3, Google Cloud Storage's
// interoperability mode, MinIO, Cloudflare R2, DigitalOcean Spaces.
//
// Signature Version 4 by hand (no SDK, nothing to update), one key per
// object id, so a rename in the portal never moves bytes. The database row
// stays the source of truth; a key with no row is garbage this never reads.
import crypto from 'node:crypto';
import { PART_BYTES } from './backend-pg.js';

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

export class S3Backend {
  constructor(cfg) {
    this.name = 's3';
    this.cfg = cfg;
    const endpoint = cfg.endpoint || `https://s3.${cfg.region}.amazonaws.com`;
    this.endpoint = new URL(endpoint);
    this.bucket = cfg.bucket;
    this.region = cfg.region || 'us-east-1';
    this.pathStyle = cfg.forcePathStyle !== false;
  }

  urlFor(key, query = '') {
    const u = new URL(this.endpoint.toString());
    if (this.pathStyle) u.pathname = '/' + enc(this.bucket) + '/' + key.split('/').map(enc).join('/');
    else { u.hostname = this.bucket + '.' + u.hostname; u.pathname = '/' + key.split('/').map(enc).join('/'); }
    u.search = query;
    return u;
  }

  sign(method, url, headers, payloadHash) {
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const date = amzDate.slice(0, 8);
    const h = { ...headers, host: url.host, 'x-amz-date': amzDate, 'x-amz-content-sha256': payloadHash };
    const names = Object.keys(h).map((k) => k.toLowerCase()).sort();
    const canonicalHeaders = names.map((k) => k + ':' + String(h[k] ?? h[Object.keys(h).find((x) => x.toLowerCase() === k)]).trim().replace(/\s+/g, ' ') + '\n').join('');
    const signedHeaders = names.join(';');
    const query = [...url.searchParams.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => enc(k) + '=' + enc(v)).join('&');
    const canonical = [method, url.pathname, query, canonicalHeaders, signedHeaders, payloadHash].join('\n');
    const scope = `${date}/${this.region}/s3/aws4_request`;
    const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
    const kDate = hmac('AWS4' + this.cfg.secretAccessKey, date);
    const kRegion = hmac(kDate, this.region);
    const kService = hmac(kRegion, 's3');
    const kSigning = hmac(kService, 'aws4_request');
    const signature = crypto.createHmac('sha256', kSigning).update(toSign).digest('hex');
    h.authorization = `AWS4-HMAC-SHA256 Credential=${this.cfg.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    return h;
  }

  // 1.10.0: AN ANSWER IN TIME. A bucket that never answered held the request
  // for good, and an upload's call is made inside its transaction, so the
  // pool connection under it stayed open too ("idle in transaction"). A call
  // has two minutes to begin answering, and two seconds more for each
  // megabyte it sends.
  async request(method, key, { query = '', headers = {}, body = null, stream = false } = {}) {
    const url = this.urlFor(key, query);
    const payloadHash = body && Buffer.isBuffer(body) ? sha256(body) : 'UNSIGNED-PAYLOAD';
    const signed = this.sign(method, url, headers, payloadHash);
    const ms = (this.cfg.answerMs || 120000) + (body && body.length ? Math.ceil(body.length / 1048576) * 2000 : 0);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error(`S3 ${method} ${key} had no answer in ${Math.round(ms / 1000)}s`)), ms);
    let r;
    try {
      r = await fetch(url, { method, headers: signed, body: body || undefined, duplex: body && !Buffer.isBuffer(body) ? 'half' : undefined, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!r.ok && !(method === 'DELETE' && r.status === 404)) {
      const text = await r.text().catch(() => '');
      throw new Error(`S3 ${method} ${key} failed: ${r.status} ${text.slice(0, 300)}`);
    }
    return r;
  }

  async put(client, objectId, buffer, contentType) {
    await this.request('PUT', objectId, { body: buffer, headers: { 'content-type': contentType || 'application/octet-stream', 'content-length': String(buffer.length) } });
  }

  async adoptUpload(client, uploadId, objectId, contentType) {
    const init = await this.request('POST', objectId, { query: 'uploads=', headers: { 'content-type': contentType || 'application/octet-stream' } });
    const initText = await init.text();
    const uploadIdS3 = /<UploadId>([^<]+)<\/UploadId>/.exec(initText);
    if (!uploadIdS3) throw new Error('S3 did not return an upload id');
    const s3Upload = uploadIdS3[1];
    const parts = await client.query('SELECT part FROM storage.upload_parts WHERE upload_id = $1 ORDER BY part', [uploadId]);
    // S3 parts must be at least 5 MB except the last: pieces are gathered
    // to 8 MB before each is sent.
    const etags = [];
    let carry = Buffer.alloc(0);
    let n = 1;
    const send = async (buf) => {
      const r = await this.request('PUT', objectId, { query: `partNumber=${n}&uploadId=${enc(s3Upload)}`, body: buf, headers: { 'content-length': String(buf.length) } });
      etags.push({ n, etag: r.headers.get('etag') });
      n++;
    };
    for (const p of parts.rows) {
      const r = await client.query('SELECT data FROM storage.upload_parts WHERE upload_id = $1 AND part = $2', [uploadId, p.part]);
      carry = carry.length ? Buffer.concat([carry, r.rows[0].data]) : r.rows[0].data;
      while (carry.length >= 2 * PART_BYTES) { await send(carry.subarray(0, 2 * PART_BYTES)); carry = carry.subarray(2 * PART_BYTES); }
    }
    if (carry.length || etags.length === 0) await send(carry);
    const xml = '<CompleteMultipartUpload>' + etags.map((e) => `<Part><PartNumber>${e.n}</PartNumber><ETag>${e.etag}</ETag></Part>`).join('') + '</CompleteMultipartUpload>';
    await this.request('POST', objectId, { query: `uploadId=${enc(s3Upload)}`, body: Buffer.from(xml), headers: { 'content-type': 'application/xml' } });
    await client.query('DELETE FROM storage.upload_parts WHERE upload_id = $1', [uploadId]);
  }

  async copy(client, fromId, toId) {
    await this.request('PUT', toId, { headers: { 'x-amz-copy-source': '/' + this.bucket + '/' + fromId } });
  }

  async remove(client, objectIds) {
    for (const id of objectIds) await this.request('DELETE', id).catch(() => {});
  }

  // 1.10.0: a download the person stopped (the tab closed) stops here too:
  // it waited for a 'drain' that never came, holding the bucket's connection,
  // for good. A reader that stops reading, or a bucket that stops sending,
  // part-way is given up after a minute of nothing.
  async stream(objectId, res, { start = 0, end = null } = {}) {
    const headers = {};
    if (start > 0 || end != null) headers.range = `bytes=${start}-${end == null ? '' : end}`;
    const r = await this.request('GET', objectId, { headers, stream: true });
    const reader = r.body.getReader();
    let gone = false;
    const onClose = () => { gone = true; };
    res.once('close', onClose);
    try {
      while (!gone) {
        let idle;
        const next = await Promise.race([reader.read(), new Promise((resolve) => { idle = setTimeout(() => resolve({ stalled: true }), this.cfg.idleMs || 60000); })]);
        clearTimeout(idle);
        if (next.stalled) { gone = true; res.destroy(new Error('the bucket stopped sending')); break; }
        if (next.done) break;
        if (!res.write(Buffer.from(next.value))) {
          // Read on, or gone, or a reader that stopped reading for a minute.
          const drained = await new Promise((resolve) => {
            const fin = (v) => { clearTimeout(t); res.off('drain', go); res.off('close', go); resolve(v); };
            const go = () => fin(true);
            const t = setTimeout(() => fin(false), this.cfg.idleMs || 60000);
            res.once('drain', go); res.once('close', go);
          });
          if (!drained) { gone = true; res.destroy(new Error('the download was not being read')); }
        }
      }
    } finally {
      res.off('close', onClose);
      if (gone) reader.cancel().catch(() => { /* already ended */ });
    }
    if (!gone) res.end();
  }

  async size(objectId) {
    const r = await this.request('HEAD', objectId);
    return parseInt(r.headers.get('content-length') || '0', 10) || 0;
  }
}
