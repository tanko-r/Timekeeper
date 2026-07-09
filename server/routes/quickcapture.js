import { Router } from 'express';
import { getSetting } from '../db.js';
import { parseQuickCapture } from '../lib/quickcapture.js';
import { containsTimeAmounts } from '../lib/timeAmounts.js';

// Bill from a sentence (spec §6): deterministic parse first (pure lib);
// optional single non-streaming LLM pass fills ONLY the fields the parser
// couldn't — deterministic results are never overwritten. The UI files the
// approved entry itself via POST /api/entries.
const MATTER_COLS = `m.id, m.cm_number, m.matter_number, m.short_name,
  m.favorite, m.last_used_at, c.name AS client_name, c.client_number`;

export function quickCaptureRouter({ db }) {
  const r = Router();

  r.post('/quickcapture', async (req, res) => {
    const line = String((req.body || {}).line || '').trim();
    if (!line) return res.status(400).json({ error: 'Type something first.' });
    const matters = db.prepare(`SELECT ${MATTER_COLS} FROM matters m
      LEFT JOIN clients c ON c.id = m.client_id
      WHERE m.status != 'archived'`).all();
    const taskCodes = db.prepare(
      'SELECT name FROM task_codes WHERE active=1 ORDER BY sort_order, id').all().map((x) => x.name);

    const parsed = parseQuickCapture(line, { matters, taskCodes });

    const cfg = getSetting(db, 'ai') || {};
    if ((req.body || {}).ai && cfg.enabled && parsed.missing.length > 0) {
      try {
        const filled = await llmFill(cfg, line, parsed, taskCodes);
        for (const k of ['hours', 'task_code', 'person', 'topic']) {
          if (parsed[k] == null && filled[k] != null) parsed[k] = filled[k];
        }
        if (filled.narrative && !containsTimeAmounts(filled.narrative)
            && (!parsed.narrative || parsed.missing.includes('action'))) {
          parsed.narrative = String(filled.narrative).slice(0, 300);
        }
        if (parsed.task_code && !taskCodes.includes(parsed.task_code)) parsed.task_code = null;
        if (parsed.matches.length === 0 && parsed.topic) {
          const re = parseQuickCapture(`re ${parsed.topic}`, { matters, taskCodes });
          parsed.matches = re.matches;
        }
        parsed.missing = [];
        if (parsed.matches.length === 0) parsed.missing.push('matter');
        if (parsed.hours == null) parsed.missing.push('hours');
        if (!parsed.task_code) parsed.missing.push('action');
      } catch { /* model down: deterministic result stands */ }
    }

    parsed.matches = parsed.matches.map((m) => ({
      id: m.id, cm_number: m.cm_number, short_name: m.short_name, client_name: m.client_name,
    }));
    res.json(parsed);
  });

  return r;
}

async function llmFill(cfg, line, parsed, taskCodes) {
  const system = `You extract structured billing data from an attorney's shorthand line.
Respond with ONLY JSON: {"hours": number|null, "task_code": string|null, "person": string|null, "topic": string|null, "narrative": string|null}.
task_code MUST be one of: ${taskCodes.join(', ')} (or null).
Never include time amounts or parentheticals like "(0.5)" inside the narrative.`;
  const resp = await fetch(`${cfg.url}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: cfg.model, stream: false, format: 'json', options: { temperature: 0.2 },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: `Line: ${line}\nAlready determined (do not change): ${JSON.stringify({ hours: parsed.hours, task_code: parsed.task_code })}` },
      ],
    }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!resp.ok) throw new Error(`ollama ${resp.status}`);
  const data = await resp.json();
  try { return JSON.parse(data.message.content); } catch { return {}; }
}
