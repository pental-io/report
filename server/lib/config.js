// PENTAL REPORTER'S SETTINGS, FROM ITS ENVIRONMENT.
//
// Everything a deployment needs is here. The three secrets (JWT_SECRET,
// VAULT_KEY, SETUP_TOKEN) are made once by `setup.sh` (or `node bin/keys.js`)
// and kept in `.env`; the publishable key the app is given is derived from
// JWT_SECRET (lib/jwt.js), so it is never a fourth thing to keep.
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const bool = (v, d = false) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(String(v)));
const int = (v, d, lo, hi) => {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return d;
  return Math.min(hi, Math.max(lo, n));
};

export function loadConfig(env = process.env) {
  const problems = [];
  const need = (k, min = 1) => {
    const v = String(env[k] || '').trim();
    if (v.length < min) problems.push(`${k} is not set${min > 1 ? ` (at least ${min} characters)` : ''}`);
    return v;
  };
  const cfg = {
    // The PostgreSQL the reports are kept in. The role in it owns everything
    // the server creates; it is the only database credential the server holds.
    databaseUrl: need('DATABASE_URL'),
    // The address people open Pental Report at (https://reports.yourfirm.com), no
    // path. Optional: without it the address a request arrived at is used.
    publicUrl: String(env.PUBLIC_URL || '').trim().replace(/\/+$/, ''),
    port: int(env.PORT, 8080, 1, 65535),
    host: String(env.HOST || '0.0.0.0'),
    // At least 32 characters: everything a sign-in proves rests on it.
    jwtSecret: need('JWT_SECRET', 32),
    jwtExpiry: int(env.JWT_EXPIRY, 3600, 300, 86400 * 7),
    // The sealed secrets in the database (the AI key, this instance's signing
    // keys) are encrypted under this. Losing it means setting up again.
    vaultKey: need('VAULT_KEY', 32),
    // Asked for once, when the first administrator is made, so nobody else
    // who can reach a new server can make themselves its administrator.
    setupToken: need('SETUP_TOKEN', 24),
    // Files: in the database (nothing else to run) or an S3-compatible bucket.
    storage: {
      backend: (String(env.STORAGE_BACKEND || 'postgres').toLowerCase() === 's3') ? 's3' : 'postgres',
      s3: {
        endpoint: String(env.S3_ENDPOINT || '').trim().replace(/\/+$/, ''),
        region: String(env.S3_REGION || 'us-east-1').trim(),
        bucket: String(env.S3_BUCKET || '').trim(),
        accessKeyId: String(env.S3_ACCESS_KEY_ID || '').trim(),
        secretAccessKey: String(env.S3_SECRET_ACCESS_KEY || '').trim(),
        forcePathStyle: bool(env.S3_FORCE_PATH_STYLE, true),
      },
      maxUploadBytes: int(env.MAX_UPLOAD_MB, 50, 1, 1024) * 1024 * 1024,
      maxLargeUploads: int(env.MAX_LARGE_UPLOADS, 4, 1, 64),
    },
    // The app is served from this server, so it is the only place a single
    // sign-on may send a browser back to (set from PUBLIC_URL, or the request).
    portalUrl: String(env.PUBLIC_URL || '').trim().replace(/\/+$/, ''),
    allowedRedirectOrigins: String(env.ALLOWED_REDIRECT_ORIGINS || '').split(',').map((x) => x.trim().replace(/\/+$/, '')).filter(Boolean),
    sso: {
      google: {
        clientId: String(env.SSO_GOOGLE_CLIENT_ID || '').trim(), clientSecret: String(env.SSO_GOOGLE_CLIENT_SECRET || '').trim(),
        domain: String(env.SSO_GOOGLE_DOMAIN || '').trim().toLowerCase(),
      },
      azure: {
        clientId: String(env.SSO_MICROSOFT_CLIENT_ID || '').trim(), clientSecret: String(env.SSO_MICROSOFT_CLIENT_SECRET || '').trim(),
        tenant: String(env.SSO_MICROSOFT_TENANT || '').trim(),
      },
    },
    statementTimeoutMs: int(env.STATEMENT_TIMEOUT_MS, 30000, 1000, 600000),
    ownerStatementTimeoutMs: int(env.OWNER_STATEMENT_TIMEOUT_MS, 600000, 1000, 3600000),
    realtime: {
      maxConnections: int(env.REALTIME_MAX_CONNECTIONS, 2000, 10, 100000),
      maxPerClient: int(env.REALTIME_MAX_PER_CLIENT, 100, 1, 10000),
      maxTopicsPerSocket: int(env.REALTIME_MAX_TOPICS, 100, 1, 1000),
    },
    // Where the app's built files are (web/dist in this repository; /app/web
    // in the image).
    webDir: path.resolve(String(env.WEB_DIR || path.join(here, '..', '..', 'web', 'dist'))),
    // The database setup this server applies to its database (db/ in this
    // repository; /app/db in the image).
    dbDir: path.resolve(String(env.DB_DIR || path.join(here, '..', '..', 'db'))),
    logLevel: String(env.LOG_LEVEL || 'info'),
    trustProxy: !/^(0|false|no|off)$/i.test(String(env.TRUST_PROXY ?? 'true')),
    proxyHops: /^\d+$/.test(String(env.TRUST_PROXY ?? '')) ? int(env.TRUST_PROXY, 1, 0, 10) : (/^(0|false|no|off)$/i.test(String(env.TRUST_PROXY ?? 'true')) ? 0 : 1),
    // A link to the paid product, tagged so its visits show up in Pental's own
    // counts. Not a setting anybody needs to change.
    pentalUrl: 'https://pental.io',
  };
  if (cfg.publicUrl && !/^https?:\/\/[^/]+$/.test(cfg.publicUrl)) problems.push('PUBLIC_URL must be an origin such as https://reports.yourfirm.com (no path)');
  if (cfg.storage.backend === 's3') {
    for (const k of ['bucket', 'accessKeyId', 'secretAccessKey']) if (!cfg.storage.s3[k]) problems.push(`STORAGE_BACKEND=s3 needs S3_${k.replace(/([A-Z])/g, '_$1').toUpperCase()}`);
  }
  return { cfg, problems };
}

// New secrets, in the shape `.env` keeps them.
export function generateSecrets() {
  return {
    JWT_SECRET: crypto.randomBytes(48).toString('base64url'),
    VAULT_KEY: crypto.randomBytes(32).toString('base64url'),
    SETUP_TOKEN: 'prs_' + crypto.randomBytes(24).toString('base64url'),
  };
}
