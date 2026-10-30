// FROM THE PARSED REQUEST TO SQL WITH BOUND PARAMETERS.
//
// Values are bound as parameters of unspecified type, which Postgres coerces
// to the column's type exactly as it coerces PostgREST's quoted literals, so
// `id=eq.<uuid>` and `count=gt.5` read the same here as there. Results are
// serialised by Postgres itself (json_agg, to_json), so numbers, timestamps
// and json come out as PostgREST sends them, never through JavaScript.
import { HttpError } from '../http.js';
import { OPS } from './parse.js';

const ident = (s) => '"' + String(s).replace(/"/g, '""') + '"';
const lit = (s) => "'" + String(s).replace(/'/g, "''") + "'";

export class Params {
  constructor() { this.values = []; }
  add(v) { this.values.push(v); return '$' + this.values.length; }
}

function columnOf(table, name, { forWrite = false } = {}) {
  const col = table.columns.get(name);
  if (!col) {
    if (forWrite) throw new HttpError(400, { code: 'PGRST204', message: `Could not find the '${name}' column of '${table.name}' in the schema cache`, details: null, hint: null });
    throw new HttpError(400, { code: '42703', message: `column ${table.name}.${name} does not exist`, details: null, hint: null });
  }
  return col;
}

// "col", "col"->>'key'
export function fieldSql(field, table, prefix = '') {
  if (field.name === '*') return prefix + '*';
  columnOf(table, field.name);
  let s = prefix + ident(field.name);
  for (const step of field.path) {
    const key = /^\d+$/.test(step.key) ? step.key : lit(step.key);
    s += (step.text ? '->>' : '->') + key;
  }
  return s;
}

// The select list, as columns and as an output list with aliases and casts.
export function selectList(select, table, prefix = '') {
  if (select.length === 1 && select[0].star) return { sql: prefix + '*', returning: '*' };
  const parts = [];
  const returning = new Set();
  for (const item of select) {
    if (item.star) { parts.push(prefix + '*'); returning.add('*'); continue; }
    let expr = fieldSql(item.field, table, prefix);
    if (item.cast) expr = expr + '::' + item.cast;
    const last = item.field.path.length ? item.field.path[item.field.path.length - 1].key : item.field.name;
    const name = item.alias || last;
    parts.push(expr + ' AS ' + ident(name));
    returning.add(item.field.name);
  }
  const ret = returning.has('*') ? '*' : [...returning].map(ident).join(', ');
  return { sql: parts.join(', '), returning: ret };
}

const TS = { fts: 'to_tsquery', plfts: 'plainto_tsquery', phfts: 'phraseto_tsquery', wfts: 'websearch_to_tsquery' };

function likeValue(v) { return String(v).replace(/\*/g, '%'); }

export function filterSql(node, table, params, prefix = '') {
  if (node.kind === 'and' || node.kind === 'or') {
    const parts = node.children.map((c) => filterSql(c, table, params, prefix));
    const joined = parts.length ? '(' + parts.join(node.kind === 'and' ? ' AND ' : ' OR ') + ')' : 'TRUE';
    return node.negate ? 'NOT ' + joined : joined;
  }
  const col = fieldSql(node.field, table, prefix);
  let sql;
  const op = node.op;
  if (op === 'is') {
    if (node.value === 'null') sql = `${col} IS NULL`;
    else if (node.value === 'not_null') sql = `${col} IS NOT NULL`;
    else sql = `${col} IS ${node.value.toUpperCase()}`;
  } else if (op === 'in') {
    if (!node.list.length) sql = 'FALSE';
    else sql = `${col} IN (${node.list.map((v) => params.add(v)).join(', ')})`;
  } else if (node.quantifier) {
    const arr = '{' + node.list.map((v) => '"' + String(op === 'like' || op === 'ilike' ? likeValue(v) : v).replace(/(["\\])/g, '\\$1') + '"').join(',') + '}';
    sql = `${col} ${OPS[op]} ${node.quantifier.toUpperCase()}(${params.add(arr)})`;
  } else if (TS[op]) {
    const lang = node.modifier ? lit(node.modifier) + ', ' : '';
    sql = `${col} @@ ${TS[op]}(${lang}${params.add(node.value)})`;
  } else if (op === 'like' || op === 'ilike') {
    sql = `${col} ${OPS[op]} ${params.add(likeValue(node.value))}`;
  } else if (op === 'isdistinct') {
    sql = `${col} IS DISTINCT FROM ${params.add(node.value)}`;
  } else {
    sql = `${col} ${OPS[op]} ${params.add(node.value)}`;
  }
  return node.negate ? `NOT (${sql})` : sql;
}

export function whereSql(filters, table, params, prefix = '') {
  if (!filters.length) return '';
  return ' WHERE ' + filters.map((f) => filterSql(f, table, params, prefix)).join(' AND ');
}

export function orderSql(order, table, prefix = '') {
  if (!order.length) return '';
  return ' ORDER BY ' + order.map((o) => fieldSql(o.field, table, prefix) + (o.desc ? ' DESC' : ' ASC') + (o.nulls ? ' NULLS ' + o.nulls : '')).join(', ');
}

export function limitSql(q, range) {
  let limit = q.limit;
  let offset = q.offset;
  if (range) {
    if (range.offset != null && offset == null) offset = range.offset;
    if (range.limit != null && limit == null) limit = range.limit;
  }
  let s = '';
  if (limit != null) s += ' LIMIT ' + parseInt(limit, 10);
  if (offset != null) s += ' OFFSET ' + parseInt(offset, 10);
  return s;
}

const qualified = (table) => ident(table.schema) + '.' + ident(table.name);

// SELECT: the rows as one JSON text, and the count query for Prefer count.
export function buildSelect(q, table, range) {
  const params = new Params();
  const sel = selectList(q.select, table);
  const inner = `SELECT ${sel.sql} FROM ${qualified(table)}${whereSql(q.filters, table, params)}${orderSql(q.order, table)}${limitSql(q, range)}`;
  const sql = `SELECT coalesce(json_agg(_r), '[]'::json)::text AS body FROM (${inner}) _r`;
  const countParams = new Params();
  const countSql = `SELECT count(*)::text AS n FROM ${qualified(table)}${whereSql(q.filters, table, countParams)}`;
  return { sql, params: params.values, countSql, countParams: countParams.values };
}

// The columns a JSON payload names, checked against the table.
export function payloadColumns(rows, table, columnsParam) {
  const keys = new Set(columnsParam || []);
  if (!columnsParam) for (const r of rows) for (const k of Object.keys(r)) keys.add(k);
  const cols = [...keys];
  for (const k of cols) columnOf(table, k, { forWrite: true });
  return cols;
}

export function buildInsert(q, table, rows, prefer) {
  const params = new Params();
  const cols = payloadColumns(rows, table, q.columns);
  const sel = selectList(q.select, table);
  const body = params.add(JSON.stringify(rows));
  let sql = `INSERT INTO ${qualified(table)}`;
  if (!cols.length) {
    sql += ' DEFAULT VALUES';
  } else {
    const list = cols.map(ident).join(', ');
    sql += ` (${list}) SELECT ${list} FROM json_populate_recordset(NULL::${qualified(table)}, ${body}::json) AS _payload`;
  }
  const resolution = prefer.resolution || '';
  if (resolution === 'merge-duplicates' || resolution === 'ignore-duplicates') {
    const target = (q.onConflict && q.onConflict.length ? q.onConflict : table.pk);
    if (!target || !target.length) throw new HttpError(400, { code: 'PGRST100', message: `No primary key or on_conflict columns for an upsert on '${table.name}'`, details: null, hint: null });
    for (const c of target) columnOf(table, c, { forWrite: true });
    sql += ` ON CONFLICT (${target.map(ident).join(', ')})`;
    if (resolution === 'ignore-duplicates') sql += ' DO NOTHING';
    else {
      const sets = cols.filter((c) => !target.includes(c)).map((c) => `${ident(c)} = EXCLUDED.${ident(c)}`);
      sql += sets.length ? ' DO UPDATE SET ' + sets.join(', ') : ' DO NOTHING';
    }
  }
  const wantRows = (prefer.return || 'minimal') === 'representation';
  if (wantRows) {
    sql = `WITH _w AS (${sql} RETURNING ${sel.returning}) SELECT coalesce(json_agg(_r), '[]'::json)::text AS body FROM (SELECT ${sel.sql} FROM _w) _r`;
  }
  return { sql, params: params.values, wantRows };
}

// 1.10.0: AN UPDATE OR A DELETE NAMES ITS ROWS. PATCH or DELETE with no
// filter changed or removed every row the caller's row security let it
// reach; Supabase refuses one (pg-safeupdate), in these words, and so does
// this now. A limit alone is a choice of rows, as there.
function namesItsRows(q, range, verb) {
  const limited = q.limit != null || (range && range.limit != null);
  if (!(q.filters && q.filters.length) && !limited) throw new HttpError(400, { code: '21000', message: verb + ' requires a WHERE clause', details: null, hint: null });
}

export function buildUpdate(q, table, row, prefer, range) {
  namesItsRows(q, range, 'UPDATE');
  const params = new Params();
  const cols = payloadColumns([row], table, q.columns);
  const sel = selectList(q.select, table);
  if (!cols.length) throw new HttpError(400, { code: 'PGRST102', message: 'Empty or invalid json', details: null, hint: null });
  const body = params.add(JSON.stringify(row));
  const sets = cols.map((c) => `${ident(c)} = _payload.${ident(c)}`).join(', ');
  let where = whereSql(q.filters, table, params, qualified(table) + '.');
  const limited = q.limit != null || (range && range.limit != null);
  if (limited) {
    // The rows the filter, order and limit pick, by ctid.
    const sub = `SELECT ctid FROM ${qualified(table)}${whereSql(q.filters, table, params)}${orderSql(q.order, table)}${limitSql(q, range)}`;
    where = ` WHERE ${qualified(table)}.ctid IN (${sub})`;
  }
  let sql = `UPDATE ${qualified(table)} SET ${sets} FROM (SELECT * FROM json_populate_record(NULL::${qualified(table)}, ${body}::json)) _payload${where}`;
  const wantRows = (prefer.return || 'minimal') === 'representation';
  if (wantRows) {
    const ret = sel.returning === '*' ? qualified(table) + '.*' : sel.returning.split(', ').map((c) => qualified(table) + '.' + c).join(', ');
    sql = `WITH _w AS (${sql} RETURNING ${ret}) SELECT coalesce(json_agg(_r), '[]'::json)::text AS body FROM (SELECT ${sel.sql} FROM _w) _r`;
  }
  return { sql, params: params.values, wantRows };
}

export function buildDelete(q, table, prefer, range) {
  namesItsRows(q, range, 'DELETE');
  const params = new Params();
  const sel = selectList(q.select, table);
  let where = whereSql(q.filters, table, params);
  const limited = q.limit != null || (range && range.limit != null);
  if (limited) {
    const sub = `SELECT ctid FROM ${qualified(table)}${whereSql(q.filters, table, params)}${orderSql(q.order, table)}${limitSql(q, range)}`;
    where = ` WHERE ctid IN (${sub})`;
  }
  let sql = `DELETE FROM ${qualified(table)}${where}`;
  const wantRows = (prefer.return || 'minimal') === 'representation';
  if (wantRows) {
    sql = `WITH _w AS (${sql} RETURNING ${sel.returning}) SELECT coalesce(json_agg(_r), '[]'::json)::text AS body FROM (SELECT ${sel.sql} FROM _w) _r`;
  }
  return { sql, params: params.values, wantRows };
}

// Which overload the arguments name, PostgREST's way: the one whose
// parameters cover every given key and whose required parameters are all
// given; the tightest fit when several do.
export function pickOverload(overloads, args) {
  const keys = Object.keys(args);
  let best = null;
  for (const fn of overloads) {
    const names = fn.args.map((a) => a.name);
    if (!keys.every((k) => names.includes(k))) continue;
    if (!fn.args.every((a) => a.hasDefault || keys.includes(a.name))) continue;
    const spare = names.length - keys.length;
    if (!best || spare < best.spare) best = { fn, spare };
  }
  return best ? best.fn : null;
}

const SCALAR_TYPTYPES = new Set(['b', 'e', 'd', 'r', 'm', 'p']);

export function buildRpc(fn, args, q, range) {
  const params = new Params();
  const keys = Object.keys(args);
  let from = '';
  let call = `${ident(fn.schema)}.${ident(fn.name)}(`;
  if (keys.length) {
    const cols = keys.map((k) => {
      const a = fn.args.find((x) => x.name === k);
      return `${ident(k)} ${a.type}`;
    }).join(', ');
    from = `pgrst_args AS (SELECT * FROM json_to_record(${params.add(JSON.stringify(args))}::json) AS _(${cols}))`;
    call += keys.map((k) => `${ident(k)} := pgrst_args.${ident(k)}`).join(', ');
  }
  call += ')';
  const tableLike = fn.retset || !SCALAR_TYPTYPES.has(fn.rettyptype);
  if (fn.rettype === 'void') {
    const sql = (from ? `WITH ${from} ` : '') + `SELECT ${call}${from ? ' FROM pgrst_args' : ''}`;
    return { sql, params: params.values, kind: 'void' };
  }
  if (!tableLike) {
    const sql = (from ? `WITH ${from} ` : '') + `SELECT to_json(${call})::text AS body${from ? ' FROM pgrst_args' : ''}`;
    return { sql, params: params.values, kind: 'scalar' };
  }
  // Rows: a pseudo-table whose columns are the function's result columns.
  // Filters and the select list refer to them as _f.
  const fake = { schema: fn.schema, name: fn.name, columns: null, pk: [] };
  const sel = q.select.length === 1 && q.select[0].star ? { sql: '_f.*' } : { sql: q.select.map((it) => {
    if (it.star) return '_f.*';
    let expr = '_f.' + ident(it.field.name);
    for (const step of it.field.path) expr += (step.text ? '->>' : '->') + (/^\d+$/.test(step.key) ? step.key : lit(step.key));
    if (it.cast) expr += '::' + it.cast;
    const last = it.field.path.length ? it.field.path[it.field.path.length - 1].key : it.field.name;
    return expr + ' AS ' + ident(it.alias || last);
  }).join(', ') };
  // Filters on function results use a permissive table (any name), since the
  // result columns are not in the cache.
  const anyTable = { name: fn.name, columns: { get: (n) => ({ name: n }) } };
  const inner = `SELECT ${sel.sql} FROM ${from ? 'pgrst_args, ' : ''}${call} AS _f${whereSql(q.filters, anyTable, params, '_f.')}${orderSql(q.order, anyTable, '_f.')}${limitSql(q, range)}`;
  const sql = (from ? `WITH ${from} ` : '') + `SELECT coalesce(json_agg(_r), '[]'::json)::text AS body FROM (${inner}) _r`;
  void fake;
  return { sql, params: params.values, kind: 'rows' };
}
