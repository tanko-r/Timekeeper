import { Router } from 'express';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { parseImageDataUrl, feedbackTodoEntry, appendFeedbackTodo } from '../lib/feedback.js';

// Alt+drag UI feedback: the client sends an annotated tab screenshot (or
// nothing, when capture was declined/unsupported) plus a note. The image
// lands in FEEDBACK_DIR and a checkbox entry referencing it is appended to
// TODO_PATH — David reviews and clears these later (CLAUDE.md: delete the
// screenshot once addressed). Paths default under DATA_DIR so tests/e2e
// sandboxes never touch the real repo files; production config points them
// at the repo root.

export function feedbackRouter({ config, clock }) {
  const r = Router();

  r.post('/', (req, res) => {
    const b = req.body || {};
    const note = String(b.note || '').trim();
    if (!note) return res.status(400).json({ error: 'A note is required.' });
    const route = String(b.route || '').slice(0, 200);

    let img = null;
    if (b.image != null) {
      img = parseImageDataUrl(b.image);
      if (!img) return res.status(400).json({ error: 'Bad image (png/jpeg data URL, ≤8MB).' });
    }

    const dir = config.FEEDBACK_DIR || join(config.DATA_DIR, 'feedback');
    const todoPath = config.TODO_PATH || join(config.DATA_DIR, 'TODO.md');

    let file = null;
    if (img) {
      mkdirSync(dir, { recursive: true });
      const d = clock();
      const pad = (n) => String(n).padStart(2, '0');
      const name = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
        + `T${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}.${img.ext}`;
      file = join(dir, name);
      writeFileSync(file, img.buf);
    }

    const entry = feedbackTodoEntry({
      note,
      file: file ? `feedback/${basename(file)}` : null,
      route,
      when: clock(),
    });
    const existing = existsSync(todoPath) ? readFileSync(todoPath, 'utf8') : '# Backlog\n';
    writeFileSync(todoPath, appendFeedbackTodo(existing, entry));

    res.status(201).json({ ok: true, file: file ? basename(file) : null });
  });

  return r;
}
