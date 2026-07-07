import { Router } from 'express';
import { getSetting } from '../db.js';
import { allocateTenths } from '../lib/allocate.js';

// Local-LLM narrative assist via Ollama (localhost only — no cloud calls).
// Brief description in → professional narrative + optional task split out.

function parseJsonLoose(s) {
  try { return JSON.parse(s); } catch { /* fall through */ }
  const m = String(s).match(/\{[\s\S]*\}/);
  if (m) {
    try { return JSON.parse(m[0]); } catch { /* fall through */ }
  }
  return null;
}

// The editable part of the prompt (Settings → AI). The format contract below
// is ALWAYS appended so custom instructions can't break response parsing.
export const DEFAULT_AI_INSTRUCTIONS = `You are a legal billing assistant for an attorney. The user gives a brief, informal description of legal work performed. You expand it into (1) a professional billing narrative and (2) its component tasks.

Rules for the narrative:
- Specific, professional billing language with concrete action verbs (reviewed, drafted, revised, analyzed, telephone conference with, correspondence with).
- Never use vague phrases like "work on", "attention to", or "review file".
- No client-confidential embellishment: only expand on what the user said; do not invent facts, names, or documents.
- 1–3 sentences.`;

function formatContract(codes) {
  return `Rules for tasks:
- Break the work into 1–5 component tasks.
- task_code MUST be one of: ${codes.join(', ')}.
- fragment: a short lowercase action phrase for that task suitable for parenthetical task-billing, e.g. "review lease agreement".
- share: fraction of the total time for that task; all shares sum to 1.

Respond with ONLY this JSON, no other text:
{"narrative": "...", "tasks": [{"task_code": "...", "fragment": "...", "share": 0.5}]}`;
}

function systemPrompt(codes, custom) {
  const instructions = String(custom || '').trim() || DEFAULT_AI_INSTRUCTIONS;
  return `${instructions}\n\n${formatContract(codes)}`;
}

export function aiRouter({ db }) {
  const r = Router();

  r.get('/ai/status', async (req, res) => {
    const cfg = getSetting(db, 'ai') || {};
    let reachable = false;
    let models = [];
    try {
      const resp = await fetch(`${cfg.url}/api/tags`, { signal: AbortSignal.timeout(2500) });
      if (resp.ok) {
        const data = await resp.json();
        models = (data.models || []).map((m) => m.name);
        reachable = true;
      }
    } catch { /* ollama down — reported below */ }
    res.json({
      enabled: !!cfg.enabled, model: cfg.model, url: cfg.url, reachable, models,
      systemPrompt: cfg.systemPrompt || '',
      defaultPrompt: DEFAULT_AI_INSTRUCTIONS,
    });
  });

  r.post('/ai/expand', async (req, res) => {
    const cfg = getSetting(db, 'ai') || {};
    if (!cfg.enabled) return res.status(400).json({ error: 'ai_disabled' });
    const b = req.body || {};
    const brief = String(b.brief || '').trim();
    if (!brief) return res.status(400).json({ error: 'Describe the work first.' });
    const totalHours = b.totalHours != null ? Number(b.totalHours) : null;

    const codes = db.prepare(
      'SELECT name FROM task_codes WHERE active=1 ORDER BY sort_order, id').all().map((x) => x.name);

    let content;
    try {
      const resp = await fetch(`${cfg.url}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: cfg.model,
          stream: false,
          format: 'json',
          options: { temperature: 0.3 },
          messages: [
            { role: 'system', content: systemPrompt(codes, cfg.systemPrompt) },
            {
              role: 'user',
              content: totalHours
                ? `Total time: ${totalHours} hours.\nWork done: ${brief}`
                : `Work done: ${brief}`,
            },
          ],
        }),
        // 12B on CPU can be slow — generous timeout.
        signal: AbortSignal.timeout(180_000),
      });
      if (!resp.ok) throw new Error(`ollama returned ${resp.status}`);
      const data = await resp.json();
      content = data.message && data.message.content;
    } catch (e) {
      return res.status(502).json({
        error: 'ollama_unreachable',
        message: `Could not reach the local model: ${e.message}`,
      });
    }

    const parsed = parseJsonLoose(content);
    if (!parsed || typeof parsed.narrative !== 'string') {
      return res.status(502).json({ error: 'ai_bad_response', message: 'Model returned unusable output — try again.' });
    }
    const rawTasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
    const tasks = rawTasks.slice(0, 8).map((t) => ({
      task_code: codes.includes(t.task_code) ? t.task_code : (codes[0] || ''),
      fragment: String(t.fragment || '').trim().slice(0, 200),
      share: Number(t.share) > 0 ? Number(t.share) : 0,
    }));
    const hours = totalHours && tasks.length
      ? allocateTenths(totalHours, tasks.map((t) => t.share))
      : null;

    res.json({
      narrative: parsed.narrative.trim(),
      tasks: tasks.map((t, i) => ({
        task_code: t.task_code,
        fragment: t.fragment,
        hours: hours ? hours[i] : null,
      })),
    });
  });

  return r;
}
