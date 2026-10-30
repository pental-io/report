// THE QUERY STRING, READ THE WAY POSTGREST READS IT.
//
// select=id,name,alias:col,col::text,data->>key
// col=eq.value   col=not.eq.value   col=in.(a,b,"c d")   col=is.null
// or=(a.eq.1,b.eq.2)   and=(...)   not.or=(...)
// order=col.asc.nullsfirst,other.desc   limit=10   offset=20
// on_conflict=col1,col2   columns=a,b
//
// Nothing here touches the database: the result is a plain description
// (sql.js turns it into SQL with bound parameters). Embedded resources
// (`select=*,client:clients(*)`) are refused with a clear message: the portal
// never asks for one.
import { HttpError } from '../http.js';

const RESERVED = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'columns', 'or', 'and', 'not.or', 'not.and']);

export const OPS = {
  eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=',
  like: 'LIKE', ilike: 'ILIKE', match: '~', imatch: '~*',
  cs: '@>', cd: '<@', ov: '&&', sl: '<<', sr: '>>', nxr: '&<', nxl: '&>', adj: '-|-',
  in: 'IN', is: 'IS', isdistinct: 'IS DISTINCT FROM',
  fts: '@@', plfts: '@@', phfts: '@@', wfts: '@@',
};

function bad(message, details = null, hint = null) {
  return new HttpError(400, { code: 'PGRST100', message, details, hint });
}

// "a,b,\"c,d\",(e,f)" -> ['a', 'b', 'c,d', '(e,f)'] at depth 0.
export function splitTop(s, sep = ',') {
  const out = [];
  let cur = '';
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '\\' && i + 1 < s.length) { cur += s[++i]; continue; }
      if (c === '"') { quoted = false; continue; }
      cur += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === sep && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

// A column reference with an optional JSON path: name, name->key, name->>key.
export function parseField(raw) {
  const s = String(raw || '').trim();
  const m = /^([A-Za-z_][A-Za-z0-9_]*|\*)((?:->>?[A-Za-z0-9_]+)*)$/.exec(s);
  if (!m) throw bad(`Unexpected field "${s}"`);
  const name = m[1];
  const path = [];
  const rest = m[2] || '';
  const re = /->(>?)([A-Za-z0-9_]+)/g;
  let k;
  while ((k = re.exec(rest))) path.push({ text: k[1] === '>', key: k[2] });
  return { name, path };
}

// 1.10.0: A CAST NAMES A TYPE, AND ONLY A TYPE. The pattern it was held to
// let spaces through, and with them words: `id::text from other union select
// id` read as a type and went into the query as written. Row security still
// held (the query runs as the caller), but it was SQL from the address. Now
// the type is one of these, written back in this form.
const CASTS = new Set(['text', 'varchar', 'character varying', 'char', 'character', 'name', 'citext',
  'int', 'int2', 'int4', 'int8', 'integer', 'smallint', 'bigint', 'numeric', 'decimal', 'real', 'float4', 'float8', 'double precision',
  'bool', 'boolean', 'json', 'jsonb', 'uuid', 'date', 'time', 'timetz', 'timestamp', 'timestamptz',
  'timestamp with time zone', 'timestamp without time zone', 'time with time zone', 'time without time zone',
  'interval', 'bytea', 'inet', 'cidr', 'macaddr', 'money', 'oid', 'tsvector', 'xml']);
function castType(raw) {
  const arr = /\[\]\s*$/.test(raw);
  const base = String(raw).replace(/\[\]\s*$/, '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!CASTS.has(base)) throw bad(`Unexpected cast "${raw}"`);
  return base + (arr ? '[]' : '');
}

export function parseSelect(select) {
  const s = String(select == null ? '' : select).trim();
  if (!s) return [{ star: true }];
  const items = splitTop(s);
  const out = [];
  for (const raw of items) {
    const item = raw.trim();
    if (!item) continue;
    if (item.includes('(')) {
      throw new HttpError(400, { code: 'PGRST100', message: `Embedded resources are not supported by the Pental gateway: "${item}"`, details: null, hint: 'Query the related table separately.' });
    }
    if (item === '*') { out.push({ star: true }); continue; }
    let alias = null;
    let body = item;
    const colon = body.indexOf(':');
    // alias:col (a single colon; "::" is a cast)
    if (colon > 0 && body[colon + 1] !== ':') { alias = body.slice(0, colon).trim(); body = body.slice(colon + 1).trim(); }
    let cast = null;
    const dc = body.indexOf('::');
    if (dc > 0) { cast = body.slice(dc + 2).trim(); body = body.slice(0, dc).trim(); }
    if (cast) cast = castType(cast);
    const field = parseField(body);
    out.push({ field, alias, cast });
  }
  return out.length ? out : [{ star: true }];
}

// "eq.5", "not.eq.5", "in.(a,b)", "is.null", "like(any).{a,b}", "fts(english).x"
export function parseOperator(rawValue) {
  let s = String(rawValue);
  let negate = false;
  if (/^not\./.test(s)) { negate = true; s = s.slice(4); }
  const m = /^([a-z]+)(?:\(([^)]*)\))?\.([\s\S]*)$/.exec(s);
  if (!m) throw bad(`Unexpected filter "${rawValue}"`);
  const op = m[1];
  const modifier = m[2] || '';
  const value = m[3];
  if (!OPS[op]) throw bad(`Unknown operator "${op}"`);
  const out = { op, negate, value, modifier: '' , quantifier: '' };
  if (op === 'fts' || op === 'plfts' || op === 'phfts' || op === 'wfts') out.modifier = modifier;
  else if (modifier === 'any' || modifier === 'all') out.quantifier = modifier;
  else if (modifier) throw bad(`Unknown modifier "${modifier}" for ${op}`);
  if (op === 'in') {
    if (!/^\(.*\)$/s.test(value)) throw bad('"in" needs a parenthesised list: in.(a,b)');
    out.list = splitTop(value.slice(1, -1)).map((x) => x.trim()).filter((x, i, a) => !(a.length === 1 && x === ''));
  }
  if (out.quantifier) {
    if (!/^\{.*\}$/s.test(value)) throw bad(`${op}(${out.quantifier}) needs a braced list: {a,b}`);
    out.list = splitTop(value.slice(1, -1)).map((x) => x.trim());
  }
  if (op === 'is') {
    const v = value.toLowerCase();
    if (!['null', 'true', 'false', 'unknown', 'not_null'].includes(v)) throw bad(`"is" accepts null, not_null, true, false or unknown, not "${value}"`);
    out.value = v;
  }
  return out;
}

// or=(a.eq.1,b.eq.2,and(c.eq.3,d.eq.4))
function parseLogic(kind, body, negate) {
  const s = String(body || '').trim();
  if (!/^\(.*\)$/s.test(s)) throw bad(`"${kind}" needs a parenthesised list`);
  const items = splitTop(s.slice(1, -1)).map((x) => x.trim()).filter(Boolean);
  const children = items.map((item) => {
    const m = /^(not\.)?(and|or)(\(.*\))$/s.exec(item);
    if (m) return parseLogic(m[2], m[3], !!m[1]);
    // col.op.value
    const dot = item.indexOf('.');
    if (dot < 0) throw bad(`Unexpected filter "${item}"`);
    const field = parseField(item.slice(0, dot));
    return { kind: 'filter', field, ...parseOperator(item.slice(dot + 1)) };
  });
  return { kind, negate, children };
}

// Everything the query string says, for one request.
export function parseQuery(searchParams) {
  const q = { select: [{ star: true }], filters: [], order: [], limit: null, offset: null, onConflict: null, columns: null };
  for (const [key, value] of searchParams.entries()) {
    if (key === 'select') { q.select = parseSelect(value); continue; }
    if (key === 'order') {
      for (const part of splitTop(value)) {
        const bits = part.trim().split('.');
        if (!bits[0]) continue;
        const field = parseField(bits[0]);
        const o = { field, desc: false, nulls: '' };
        for (const b of bits.slice(1)) {
          if (b === 'asc') o.desc = false;
          else if (b === 'desc') o.desc = true;
          else if (b === 'nullsfirst') o.nulls = 'FIRST';
          else if (b === 'nullslast') o.nulls = 'LAST';
          else throw bad(`Unexpected order modifier "${b}"`);
        }
        q.order.push(o);
      }
      continue;
    }
    if (key === 'limit') { const n = parseInt(value, 10); if (!(n >= 0)) throw bad('limit must be a non-negative integer'); q.limit = n; continue; }
    if (key === 'offset') { const n = parseInt(value, 10); if (!(n >= 0)) throw bad('offset must be a non-negative integer'); q.offset = n; continue; }
    if (key === 'on_conflict') { q.onConflict = splitTop(value).map((x) => x.trim()).filter(Boolean); continue; }
    if (key === 'columns') { q.columns = splitTop(value).map((x) => x.trim()).filter(Boolean); continue; }
    if (key === 'or' || key === 'and' || key === 'not.or' || key === 'not.and') {
      const neg = key.startsWith('not.');
      q.filters.push(parseLogic(neg ? key.slice(4) : key, value, neg));
      continue;
    }
    if (RESERVED.has(key)) continue;
    // A column filter. Keys with a dot before "->" are embedded-resource
    // filters, which are not supported; a plain column may have a JSON path.
    if (key.includes('.') && !key.split('.')[0].includes('->')) {
      throw new HttpError(400, { code: 'PGRST100', message: `Embedded filters are not supported by the Pental gateway: "${key}"`, details: null, hint: null });
    }
    const field = parseField(key);
    q.filters.push({ kind: 'filter', field, ...parseOperator(value) });
  }
  return q;
}

// The RPC's arguments from a GET query string: every non-reserved key.
export function rpcArgsFromQuery(searchParams) {
  const args = {};
  for (const [key, value] of searchParams.entries()) {
    if (RESERVED.has(key) || key === 'apikey') continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) args[key] = value;
  }
  return args;
}
