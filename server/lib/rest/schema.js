// WHAT THE DATABASE LOOKS LIKE, CACHED.
//
// Tables, columns and primary keys of the exposed schemas, and the functions
// of `public`, read from the catalogue. Reloaded when the schema is applied
// or updated, when a NOTIFY pgrst 'reload schema' arrives (the portal schema
// sends one, as it does for PostgREST), when a query fails on a name this
// cache does not know, and every few minutes regardless.
import { log } from '../log.js';

export const EXPOSED_SCHEMAS = ['public', 'storage'];
const TTL_MS = 5 * 60 * 1000;

const Q_TABLES = `
  SELECT c.oid, n.nspname AS schema, c.relname AS name, c.relkind AS kind
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'v', 'm', 'p', 'f') AND n.nspname = ANY($1)`;
const Q_COLUMNS = `
  SELECT a.attrelid AS oid, a.attname AS name, a.attnum AS num, a.atthasdef AS has_default, a.attnotnull AS not_null,
         pg_catalog.format_type(a.atttypid, a.atttypmod) AS type, t.typname AS typname, t.typtype AS typtype, t.typcategory AS category,
         a.attgenerated <> '' AS generated, a.attidentity <> '' AS identity
  FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_type t ON t.oid = a.atttypid
  WHERE a.attnum > 0 AND NOT a.attisdropped AND c.relkind IN ('r', 'v', 'm', 'p', 'f') AND n.nspname = ANY($1)
  ORDER BY a.attrelid, a.attnum`;
const Q_PKS = `
  SELECT i.indrelid AS oid, array_agg(a.attname ORDER BY k.ord) AS cols
  FROM pg_index i
  JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
  JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
  JOIN pg_class c ON c.oid = i.indrelid JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE i.indisprimary AND n.nspname = ANY($1)
  GROUP BY i.indrelid`;
const Q_FUNCS = `
  SELECT p.oid, n.nspname AS schema, p.proname AS name, p.proargnames AS argnames, p.proargmodes AS argmodes,
         p.pronargs AS nargs, p.pronargdefaults AS ndefaults, p.proretset AS retset, p.provolatile AS volatility,
         pg_catalog.format_type(p.prorettype, NULL) AS rettype, rt.typtype AS rettyptype, rt.typname AS rettypname,
         (SELECT array_agg(pg_catalog.format_type(x.t, NULL) ORDER BY x.ord) FROM unnest(p.proargtypes) WITH ORDINALITY AS x(t, ord)) AS argtypes
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_type rt ON rt.oid = p.prorettype
  WHERE n.nspname = ANY($1) AND p.prokind = 'f'`;

export class SchemaCache {
  constructor(db) {
    this.db = db;
    this.tables = new Map();     // "schema.name" -> { oid, schema, name, kind, columns: Map, pk: [] }
    this.functions = new Map();  // "schema.name" -> [ overloads ]
    this.loadedAt = 0;
    this.loading = null;
  }

  async load() {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      const [t, c, p, f] = await Promise.all([
        this.db.query(Q_TABLES, [EXPOSED_SCHEMAS]),
        this.db.query(Q_COLUMNS, [EXPOSED_SCHEMAS]),
        this.db.query(Q_PKS, [EXPOSED_SCHEMAS]),
        this.db.query(Q_FUNCS, [['public']]),
      ]);
      const tables = new Map();
      const byOid = new Map();
      for (const r of t.rows) {
        const tb = { oid: r.oid, schema: r.schema, name: r.name, kind: r.kind, columns: new Map(), pk: [] };
        tables.set(r.schema + '.' + r.name, tb);
        byOid.set(String(r.oid), tb);
      }
      for (const r of c.rows) {
        const tb = byOid.get(String(r.oid));
        if (!tb) continue;
        tb.columns.set(r.name, { name: r.name, type: r.type, typname: r.typname, typtype: r.typtype, category: r.category, hasDefault: r.has_default, notNull: r.not_null, generated: r.generated, identity: r.identity, num: r.num });
      }
      for (const r of p.rows) { const tb = byOid.get(String(r.oid)); if (tb) tb.pk = r.cols; }
      const functions = new Map();
      for (const r of f.rows) {
        const key = r.schema + '.' + r.name;
        const names = Array.isArray(r.argnames) ? r.argnames : [];
        const modes = Array.isArray(r.argmodes) ? r.argmodes : null;
        // IN arguments only (modes i, b, v); with no modes every name is IN.
        const inNames = [];
        if (modes) { for (let i = 0; i < names.length; i++) if (['i', 'b', 'v'].includes(modes[i])) inNames.push(names[i]); }
        else inNames.push(...names);
        const argtypes = Array.isArray(r.argtypes) ? r.argtypes : [];
        const args = argtypes.map((type, i) => ({ name: inNames[i] || '', type, hasDefault: i >= argtypes.length - (r.ndefaults || 0) }));
        const fn = { oid: r.oid, schema: r.schema, name: r.name, args, retset: r.retset, rettype: r.rettype, rettyptype: r.rettyptype, rettypname: r.rettypname, volatility: r.volatility };
        if (!functions.has(key)) functions.set(key, []);
        functions.get(key).push(fn);
      }
      this.tables = tables;
      this.functions = functions;
      this.loadedAt = Date.now();
      log.debug('schema cache loaded', { tables: tables.size, functions: functions.size });
    })().finally(() => { this.loading = null; });
    return this.loading;
  }

  async ensure() {
    if (!this.loadedAt || Date.now() - this.loadedAt > TTL_MS) await this.load();
  }

  table(schema, name) { return this.tables.get(schema + '.' + name) || null; }
  overloads(schema, name) { return this.functions.get(schema + '.' + name) || []; }

  // Listen for the reload notice the portal schema and PostgREST share, on
  // the gateway's one listening connection (db.js, Listener, 1.10.0); and
  // read the schema again once that connection is made again after a loss,
  // since a notice may have come while it was down.
  async listen() {
    const reload = () => this.load().catch((e) => log.warn('schema reload failed', { error: e.message }));
    try {
      this._unlisten = await this.db.listener.listen('pgrst', reload, reload);
    } catch (e) {
      log.warn('could not LISTEN pgrst', { error: e.message });
    }
  }

  async stop() {
    const u = this._unlisten;
    this._unlisten = null;
    if (u) u();
  }
}
