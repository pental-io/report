// FILE BYTES IN THE DATABASE ITSELF, IN PARTS.
//
// Every managed Postgres holds bytea, so this works everywhere with nothing
// else to run. A file is rows of storage.blobs (object_id, part, data), 4 MB
// each, so a gigabyte appliance image is never one value and a download can
// start at any byte. Only the owner touches these tables; the row policies
// on storage.objects have already decided.
export const PART_BYTES = 4 * 1024 * 1024;

export class PgBackend {
  constructor(db) { this.db = db; this.name = 'postgres'; }

  // Store a whole buffer for an object, replacing what was there.
  async put(client, objectId, buffer) {
    await client.query('DELETE FROM storage.blobs WHERE object_id = $1', [objectId]);
    for (let i = 0, part = 0; i < buffer.length || (part === 0 && buffer.length === 0); i += PART_BYTES, part++) {
      await client.query('INSERT INTO storage.blobs (object_id, part, data) VALUES ($1, $2, $3)', [objectId, part, buffer.subarray(i, i + PART_BYTES)]);
      if (buffer.length === 0) break;
    }
  }

  // Move a finished resumable upload's parts under the object, re-chunked.
  async adoptUpload(client, uploadId, objectId) {
    await client.query('DELETE FROM storage.blobs WHERE object_id = $1', [objectId]);
    const parts = await client.query('SELECT part FROM storage.upload_parts WHERE upload_id = $1 ORDER BY part', [uploadId]);
    let carry = Buffer.alloc(0);
    let out = 0;
    for (const p of parts.rows) {
      const r = await client.query('SELECT data FROM storage.upload_parts WHERE upload_id = $1 AND part = $2', [uploadId, p.part]);
      carry = carry.length ? Buffer.concat([carry, r.rows[0].data]) : r.rows[0].data;
      while (carry.length >= PART_BYTES) {
        await client.query('INSERT INTO storage.blobs (object_id, part, data) VALUES ($1, $2, $3)', [objectId, out++, carry.subarray(0, PART_BYTES)]);
        carry = carry.subarray(PART_BYTES);
      }
    }
    if (carry.length || out === 0) await client.query('INSERT INTO storage.blobs (object_id, part, data) VALUES ($1, $2, $3)', [objectId, out++, carry]);
    await client.query('DELETE FROM storage.upload_parts WHERE upload_id = $1', [uploadId]);
  }

  async copy(client, fromId, toId) {
    await client.query('DELETE FROM storage.blobs WHERE object_id = $1', [toId]);
    await client.query('INSERT INTO storage.blobs (object_id, part, data) SELECT $2, part, data FROM storage.blobs WHERE object_id = $1', [fromId, toId]);
  }

  async remove(client, objectIds) {
    if (!objectIds.length) return;
    await client.query('DELETE FROM storage.blobs WHERE object_id = ANY($1::uuid[])', [objectIds]);
  }

  // Stream [start, end] (inclusive, end optional) of an object into `res`.
  //
  // Each part is read on a connection of its own that goes straight back to
  // the pool: a client reading slowly holds a socket, never a database
  // connection, so slow downloads cannot starve every other request. A
  // client that stops reading altogether is dropped after a minute.
  async stream(objectId, res, { start = 0, end = null } = {}) {
    const firstPart = Math.floor(start / PART_BYTES);
    const lastPart = end == null ? null : Math.floor(end / PART_BYTES);
    const meta = await this.db.query('SELECT part FROM storage.blobs WHERE object_id = $1 ORDER BY part', [objectId]);
    for (const row of meta.rows) {
      const part = row.part;
      if (part < firstPart) continue;
      if (lastPart != null && part > lastPart) break;
      if (res.destroyed) return;
      const r = await this.db.query('SELECT data FROM storage.blobs WHERE object_id = $1 AND part = $2', [objectId, part]);
      if (!r.rows[0]) break;
      let data = r.rows[0].data;
      const base = part * PART_BYTES;
      let from = 0, to = data.length;
      if (start > base) from = start - base;
      if (end != null && end < base + data.length - 1) to = end - base + 1;
      if (from > 0 || to < data.length) data = data.subarray(from, to);
      if (!res.write(data)) {
        const drained = await new Promise((resolve) => {
          const t = setTimeout(() => resolve(false), 60000);
          res.once('drain', () => { clearTimeout(t); resolve(true); });
          res.once('close', () => { clearTimeout(t); resolve(false); });
        });
        if (!drained) { res.destroy(); return; }
      }
    }
    res.end();
  }

  async size(objectId) {
    const r = await this.db.query('SELECT coalesce(sum(octet_length(data)), 0)::bigint AS n FROM storage.blobs WHERE object_id = $1', [objectId]);
    return parseInt(r.rows[0].n, 10) || 0;
  }
}
