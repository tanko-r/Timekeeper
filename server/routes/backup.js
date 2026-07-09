import { Router } from 'express';
import { mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { todayLocal } from '../lib/dates.js';
import { getSetting } from '../db.js';

export function backupRouter({ db, config, clock }) {
  const r = Router();

  r.get('/backup/db', (req, res) => {
    const tmp = join(tmpdir(), `tk-backup-${randomBytes(6).toString('hex')}.db`);
    db.prepare('VACUUM INTO ?').run(tmp);
    res.download(tmp, `timekeeper-${todayLocal(clock())}.db`, (err) => {
      try { unlinkSync(tmp); } catch { /* already gone */ }
      if (err && !res.headersSent) res.status(500).json({ error: 'backup failed' });
    });
  });

  r.get('/backup/json', (req, res) => {
    const dump = {
      exported_at: clock().toISOString(),
      clients: db.prepare('SELECT * FROM clients ORDER BY id').all(),
      matters: db.prepare('SELECT * FROM matters ORDER BY id').all(),
      matter_people: db.prepare('SELECT * FROM matter_people ORDER BY matter_id, id').all(),
      shortcuts: db.prepare('SELECT * FROM shortcuts ORDER BY id').all(),
      task_codes: db.prepare('SELECT * FROM task_codes ORDER BY sort_order, id').all(),
      entries: db.prepare('SELECT * FROM entries ORDER BY id').all().map((e) => ({
        ...e,
        tasks: db.prepare('SELECT * FROM entry_tasks WHERE entry_id=? ORDER BY sort_order, id').all(e.id),
      })),
      timers: db.prepare('SELECT * FROM timers ORDER BY sort_order, id').all(),
      audit_log: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
      settings: db.prepare('SELECT key, value FROM settings ORDER BY key').all()
        .filter((s) => s.key !== 'auth' && s.key !== 'jobs_state')
        .map((s) => ({ key: s.key, value: JSON.parse(s.value) })),
    };
    res.setHeader('Content-Disposition',
      `attachment; filename="timekeeper-${todayLocal(clock())}.json"`);
    res.json(dump);
  });

  r.get('/backup/list', (req, res) => {
    const dir = join(config.DATA_DIR, 'backups');
    mkdirSync(dir, { recursive: true });
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.db'))
      .sort()
      .reverse()
      .map((f) => ({ name: f, bytes: statSync(join(dir, f)).size }));
    res.json(files);
  });

  return r;
}
