import { Router } from 'express';
import { getSetting, setSetting } from '../db.js';

// Keys the UI may read/write. auth is intentionally excluded — it has its own
// endpoints with password-change rules.
const KEYS = [
  'validation', 'rounding', 'targets', 'idleNudgeHours',
  'backup', 'theme', 'ai', 'tim',
];

export function allSettings(db) {
  const out = {};
  for (const k of KEYS) out[k] = getSetting(db, k);
  return out;
}

export function settingsRouter({ db }) {
  const r = Router();

  r.get('/', (req, res) => res.json(allSettings(db)));

  r.patch('/', (req, res) => {
    const body = req.body || {};
    for (const [key, value] of Object.entries(body)) {
      if (!KEYS.includes(key)) {
        return res.status(400).json({ error: `Unknown setting "${key}".` });
      }
      const current = getSetting(db, key);
      const merged =
        current && typeof current === 'object' && !Array.isArray(current) &&
        value && typeof value === 'object' && !Array.isArray(value)
          ? { ...current, ...value }
          : value;
      setSetting(db, key, merged);
    }
    res.json(allSettings(db));
  });

  return r;
}
