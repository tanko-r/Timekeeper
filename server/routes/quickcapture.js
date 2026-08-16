import { Router } from 'express';
import { getSetting } from '../db.js';
import { parseQuickCapture, rememberAiNarrative } from '../lib/quickcapture.js';
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
        // topic is '' (never null) on a deterministic miss — empty counts as fillable.
        for (const k of ['hours', 'task_code', 'person', 'topic']) {
          const fillable = parsed[k] == null || (k === 'topic' && !parsed[k]);
          if (!fillable || filled[k] == null) continue;
          if (k === 'hours') {
            // Mirror parseDuration's bounds: finite, 0 < h <= 12.
            const h = Number(filled.hours);
            if (Number.isFinite(h) && h > 0 && h <= 12) parsed.hours = h;
          } else {
            parsed[k] = filled[k];
          }
        }
        if (filled.narrative && !containsTimeAmounts(filled.narrative)
            && (!parsed.narrative || parsed.missing.includes('action'))) {
          parsed.narrative = String(filled.narrative).slice(0, 300);
          // The MODEL wrote the client-facing sentence, and quick capture
          // files it with no chance to edit it. Mark it as the model's so it
          // never re-enters the pool the model learns "the attorney's voice"
          // from. The flag rides the response for clients that can relay it,
          // and the ledger carries it for the one that cannot.
          parsed.narrative_ai = 1;
          parsed.ai_brief = line.slice(0, 500);
          rememberAiNarrative(db, parsed.narrative, line);
        }
        if (parsed.task_code) {
          // Case-insensitive validation, normalized to the canonical code.
          const canon = taskCodes.find(
            (c) => c.toLowerCase() === String(parsed.task_code).toLowerCase());
          parsed.task_code = canon || null;
        }
        if (parsed.matches.length === 0) {
          // Prefer the LLM's topic for the rematch: when the line had no
          // re-marker, the deterministic topic is the same text that already
          // failed to match, so retrying it verbatim would be a no-op.
          const rematchTopic = filled.topic || parsed.topic;
          if (rematchTopic) {
            const re = parseQuickCapture(`re ${rematchTopic}`, { matters, taskCodes });
            parsed.matches = re.matches;
          }
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

export function buildLlmFillMessages(line, parsed, taskCodes) {
  const system = `You extract structured billing data from an attorney's shorthand line.
Respond with ONLY JSON: {"hours": number|null, "task_code": string|null, "person": string|null, "topic": string|null, "narrative": string|null}.
task_code MUST be one of: ${taskCodes.join(', ')} (or null).
Never include time amounts or parentheticals like "(0.5)" inside the narrative.`;
  return [
    { role: 'system', content: system },
    { role: 'user', content: `Line: ${line}\nAlready determined (do not change): ${JSON.stringify({ hours: parsed.hours, task_code: parsed.task_code })}` },
  ];
}

async function llmFill(cfg, line, parsed, taskCodes) {
  const messages = buildLlmFillMessages(line, parsed, taskCodes);
  const resp = await fetch(`${cfg.url}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: cfg.model, stream: false, format: 'json', options: { temperature: 0.2 },
      messages,
    }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!resp.ok) throw new Error(`ollama ${resp.status}`);
  const data = await resp.json();
  try { return JSON.parse(data.message.content); } catch { return {}; }
}
