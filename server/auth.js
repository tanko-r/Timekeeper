import { Router } from 'express';
import { randomBytes, createHash, scryptSync, timingSafeEqual } from 'node:crypto';
import { getSetting, setSetting } from './db.js';

const SESSION_COOKIE = 'tk_session';
const SESSION_DAYS = 30;
const SCRYPT_N = 32768;
const MAX_FAILS = 10;
const FAIL_WINDOW_MS = 15 * 60 * 1000;

// ---------- password hashing ----------

const SCRYPT_OPTS = { r: 8, p: 1, maxmem: 128 * 1024 * 1024 };

export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64, { ...SCRYPT_OPTS, N: SCRYPT_N });
  return `scrypt:${SCRYPT_N}:${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  try {
    const [algo, n, saltHex, hashHex] = String(stored).split(':');
    if (algo !== 'scrypt') return false;
    const hash = scryptSync(password, Buffer.from(saltHex, 'hex'), 64, { ...SCRYPT_OPTS, N: Number(n) });
    return timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
  } catch {
    return false;
  }
}

// ---------- remote detection ----------

const PRIVATE_V4 = [
  /^127\./, /^10\./, /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
];

function isPrivateIp(ip) {
  if (!ip) return false;
  let v = ip;
  if (v.startsWith('::ffff:')) v = v.slice(7);
  if (v === '::1' || v === 'localhost') return true;
  if (/^fe80:/i.test(v) || /^f[cd]/i.test(v)) return true; // link-local / ULA
  return PRIVATE_V4.some((re) => re.test(v));
}

export function isRemote(req) {
  // Anything that came through the Cloudflare tunnel carries CF headers; the
  // only other way in is the LAN (no router port-forwarding to this app).
  if (req.headers['cf-ray'] || req.headers['cf-connecting-ip']) return true;
  const candidates = [req.ip, req.socket && req.socket.remoteAddress].filter(Boolean);
  return !candidates.every(isPrivateIp);
}

// ---------- sessions ----------

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

function readCookie(req) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === SESSION_COOKIE) return rest.join('=');
  }
  return null;
}

function sessionFor(db, req, clock) {
  const token = readCookie(req);
  if (!token) return null;
  const row = db.prepare('SELECT * FROM sessions WHERE token_hash=?').get(sha256(token));
  if (!row) return null;
  const now = clock().toISOString();
  if (row.expires_at < now) {
    db.prepare('DELETE FROM sessions WHERE token_hash=?').run(row.token_hash);
    return null;
  }
  // rolling expiry
  const expires = new Date(clock().getTime() + SESSION_DAYS * 86400_000).toISOString();
  db.prepare('UPDATE sessions SET last_seen_at=?, expires_at=? WHERE token_hash=?')
    .run(now, expires, row.token_hash);
  return row;
}

function createSession(db, req, res, clock) {
  const token = randomBytes(32).toString('hex');
  const now = clock().toISOString();
  const expires = new Date(clock().getTime() + SESSION_DAYS * 86400_000).toISOString();
  db.prepare(
    'INSERT INTO sessions (token_hash, created_at, last_seen_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)'
  ).run(sha256(token), now, now, expires, String(req.headers['user-agent'] || ''));
  setSessionCookie(req, res, token, SESSION_DAYS * 86400);
  return token;
}

function setSessionCookie(req, res, value, maxAgeSeconds) {
  const secure = String(req.headers['x-forwarded-proto'] || '').includes('https');
  res.setHeader('Set-Cookie',
    `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`);
}

// ---------- middleware ----------

function passwordHash(db) {
  return (getSetting(db, 'auth') || {}).passwordHash || null;
}

// Reject cross-site mutations. Same-host and the public tunnel hostname pass.
export function originCheck(config) {
  return (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const origin = req.headers.origin;
    if (!origin) return next();
    let host;
    try { host = new URL(origin).host; } catch { return res.status(403).json({ error: 'bad_origin' }); }
    const allowed = [req.headers.host, config.PUBLIC_HOSTNAME].filter(Boolean);
    if (!allowed.includes(host)) return res.status(403).json({ error: 'origin_mismatch' });
    next();
  };
}

export function authGuard({ db, clock }) {
  return (req, res, next) => {
    const mode = (getSetting(db, 'auth') || {}).mode || 'remote-only';
    if (mode === 'off') return next();
    if (mode === 'remote-only' && !isRemote(req)) return next();
    if (sessionFor(db, req, clock)) return next();
    if (!passwordHash(db)) {
      return res.status(403).json({
        error: 'no_password_set',
        message: 'Remote access is disabled until a password is set from the LAN (Settings → Remote access).',
      });
    }
    return res.status(401).json({ error: 'auth_required' });
  };
}

export function authRouter({ db, clock }) {
  const r = Router();
  const fails = new Map(); // ip → {count, resetAt}

  function limited(ip, nowMs) {
    const f = fails.get(ip);
    if (!f) return false;
    if (nowMs > f.resetAt) { fails.delete(ip); return false; }
    return f.count >= MAX_FAILS;
  }

  function recordFail(ip, nowMs) {
    const f = fails.get(ip);
    if (!f || nowMs > f.resetAt) {
      fails.set(ip, { count: 1, resetAt: nowMs + FAIL_WINDOW_MS });
    } else {
      f.count += 1;
    }
  }

  r.get('/status', (req, res) => {
    const mode = (getSetting(db, 'auth') || {}).mode || 'remote-only';
    const remote = isRemote(req);
    const loggedIn = !!sessionFor(db, req, clock);
    res.json({
      mode,
      remote,
      loggedIn,
      passwordSet: !!passwordHash(db),
      authRequired: mode === 'always' || (mode === 'remote-only' && remote),
      sessionCount: db.prepare('SELECT COUNT(*) c FROM sessions').get().c,
    });
  });

  r.post('/login', (req, res) => {
    const ip = req.headers['cf-connecting-ip'] || req.ip || 'unknown';
    const nowMs = clock().getTime();
    if (limited(ip, nowMs)) {
      return res.status(429).json({ error: 'too_many_attempts', message: 'Too many failed logins — try again later.' });
    }
    const stored = passwordHash(db);
    if (!stored) return res.status(403).json({ error: 'no_password_set' });
    const password = String((req.body || {}).password || '');
    if (!verifyPassword(password, stored)) {
      recordFail(ip, nowMs);
      return res.status(401).json({ error: 'wrong_password' });
    }
    fails.delete(ip);
    createSession(db, req, res, clock);
    res.json({ ok: true });
  });

  r.post('/logout', (req, res) => {
    const token = readCookie(req);
    if (token) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sha256(token));
    setSessionCookie(req, res, '', 0);
    res.json({ ok: true });
  });

  // Set or change the password. Allowed from the LAN, or with a valid session.
  r.post('/password', (req, res) => {
    const hasSession = !!sessionFor(db, req, clock);
    if (isRemote(req) && !hasSession) {
      return res.status(401).json({ error: 'auth_required' });
    }
    const { current, next } = req.body || {};
    const stored = passwordHash(db);
    if (stored && !verifyPassword(String(current || ''), stored)) {
      return res.status(401).json({ error: 'wrong_current_password' });
    }
    if (!next || String(next).length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }
    const auth = getSetting(db, 'auth') || {};
    setSetting(db, 'auth', { ...auth, passwordHash: hashPassword(String(next)) });
    // Changing the password revokes every existing session.
    if (stored) db.prepare('DELETE FROM sessions').run();
    res.json({ ok: true });
  });

  r.post('/sessions/revoke', (req, res) => {
    if (isRemote(req) && !sessionFor(db, req, clock)) {
      return res.status(401).json({ error: 'auth_required' });
    }
    db.prepare('DELETE FROM sessions').run();
    setSessionCookie(req, res, '', 0);
    res.json({ ok: true });
  });

  return r;
}
