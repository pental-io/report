// One line per event, JSON, to stdout: what every container platform
// collects. Never a token, a password or a row.
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
let threshold = LEVELS.info;

export function setLogLevel(name) { threshold = LEVELS[String(name || '').toLowerCase()] || LEVELS.info; }

function line(level, msg, fields) {
  if (LEVELS[level] < threshold) return;
  const rec = { t: new Date().toISOString(), level, msg, ...(fields || {}) };
  const out = JSON.stringify(rec);
  if (level === 'error' || level === 'warn') process.stderr.write(out + '\n');
  else process.stdout.write(out + '\n');
}

export const log = {
  debug: (m, f) => line('debug', m, f),
  info: (m, f) => line('info', m, f),
  warn: (m, f) => line('warn', m, f),
  error: (m, f) => line('error', m, f),
};
