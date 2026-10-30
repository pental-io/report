// 1807: WHETHER AN SQL FILE CARRIES TRANSACTION CONTROL OF ITS OWN.
//
// The same scanner as the self-hosted kit's updater
// (website/self-hosted-kit/pental-updater/update.mjs), kept identical (a test
// compares the two). The setup SQL is applied in one request, which
// PostgreSQL runs as one transaction; a BEGIN or COMMIT of its own would make
// part of it stick however the rest went, so such SQL is refused.

// Whether a bundle carries transaction control of its own: a statement, at
// the top level, that begins, ends or splits a transaction. One that did
// would commit part of itself however the rest went; none of Pental's does
// (from 2025092909). Read the way PostgreSQL reads it: comments, quoted
// strings, quoted names and dollar-quoted bodies (where a function's own
// BEGIN and END live) are stepped over.
const TX = /^(BEGIN|COMMIT|ROLLBACK|ABORT|END|START\s+TRANSACTION|SAVEPOINT|RELEASE|PREPARE\s+TRANSACTION)\b/i;
export function hasTransactionControl(sql) {
  const s = String(sql || '');
  const n = s.length;
  let i = 0;
  let start = true;
  while (i < n) {
    const ch = s[i];
    if (ch === '-' && s[i + 1] === '-') { const j = s.indexOf('\n', i); i = j < 0 ? n : j + 1; continue; }
    if (ch === '/' && s[i + 1] === '*') {
      let depth = 1; i += 2;
      while (i < n && depth) { if (s[i] === '/' && s[i + 1] === '*') { depth++; i += 2; } else if (s[i] === '*' && s[i + 1] === '/') { depth--; i += 2; } else i++; }
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f') { i++; continue; }
    if (start) {
      if (TX.test(s.slice(i, i + 40))) return true;
      start = false;
    }
    if (ch === "'") {
      // E'...' strings take backslash escapes; others double their quotes.
      const esc = i > 0 && /[eE]/.test(s[i - 1]) && !/[A-Za-z0-9_]/.test(s[i - 2] || '');
      i++;
      while (i < n) {
        if (esc && s[i] === '\\') { i += 2; continue; }
        if (s[i] === "'") { if (s[i + 1] === "'") { i += 2; continue; } i++; break; }
        i++;
      }
      continue;
    }
    if (ch === '"') { const j = s.indexOf('"', i + 1); i = j < 0 ? n : j + 1; continue; }
    if (ch === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(s.slice(i, i + 80));
      if (m) { const j = s.indexOf(m[0], i + m[0].length); i = j < 0 ? n : j + m[0].length; continue; }
    }
    if (ch === ';') { start = true; i++; continue; }
    i++;
  }
  return false;
}
