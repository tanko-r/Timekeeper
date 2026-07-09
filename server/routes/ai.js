import { Router } from 'express';
import { getSetting } from '../db.js';
import { allocateTenths } from '../lib/allocate.js';
import { matterSuggestions } from './matters.js';
import { todayLocal } from '../lib/dates.js';

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

// Plain-text narrative prompt (NO JSON contract — unlike /ai/expand) shared
// by the background suggested-narrative refinement and the streaming
// /api/ai/narrate endpoint (Task 6 / spec §6 "faster AI narration").
export function buildNarrateMessages({ instructions, brief, narrative, mode = 'draft', context }) {
  const base = String(instructions || '').trim() || DEFAULT_AI_INSTRUCTIONS;
  const system = `${base}\n\nRespond with ONLY the billing narrative itself — plain text. No JSON, no quotes, no preamble, no explanations.`;
  let user;
  if (mode === 'shorter') {
    user = `Rewrite this billing narrative to be tighter and shorter while keeping every distinct piece of work:\n\n${narrative}`;
  } else if (mode === 'longer') {
    user = `Rewrite this billing narrative with slightly more specific detail. Do not invent facts, names, or documents:\n\n${narrative}`;
  } else {
    user = [context, `Work done: ${brief}`].filter(Boolean).join('\n\n');
  }
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

// Background refinement of a timer's pre-computed narrative (spec §6,
// "suggested narrative on timer start": phrasebook first, "optional async
// llama3.1 pass"). FIRE-AND-FORGET: callers must never block a request on
// this — timers.js calls it as `refineSuggestedNarrative(deps, id).catch(...)`.
// No-op when AI is disabled (the default, so tests without a stub are
// unaffected). The UPDATE is guarded by running=1 so a refinement finishing
// after the stop (llama3.1:8b can take minutes) can't clobber anything.
export async function refineSuggestedNarrative({ db, clock }, timerId) {
  const cfg = getSetting(db, 'ai') || {};
  if (!cfg.enabled) return;
  const timer = db.prepare(
    'SELECT t.id, t.name, t.cm_id, m.short_name FROM timers t JOIN matters m ON m.id = t.cm_id WHERE t.id=?'
  ).get(timerId);
  if (!timer) return;
  const sugg = matterSuggestions(db, timer.cm_id, todayLocal(clock ? clock() : new Date()));
  const recent = (sugg ? sugg.phrases : []).slice(0, 5).map((p) => `- ${p.text}`).join('\n');
  const messages = buildNarrateMessages({
    instructions: cfg.systemPrompt,
    brief: `Matter: ${timer.short_name || timer.name}. Timer label: ${timer.name}. Draft the single most likely billing narrative for today's work session on this matter.`,
    context: recent ? `The attorney's recent recurring work on this matter:\n${recent}` : null,
  });
  const resp = await fetch(`${cfg.url}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: cfg.model, stream: false, options: { temperature: 0.3 }, messages }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!resp.ok) return;
  const data = await resp.json();
  const text = String((data.message && data.message.content) || '')
    .trim().replace(/^["']|["']$/g, '').slice(0, 300);
  if (!text || text.includes('{')) return; // refuse JSON-ish garbage
  db.prepare('UPDATE timers SET suggested_narrative=? WHERE id=? AND running=1').run(text, timerId);
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

  // Streamed narrative (spec §6 "faster AI narration"): plain-text tokens as
  // NDJSON lines — {"token":"…"} per chunk, then {"done":true,"narrative":…}
  // — so the UI renders while llama3.1:8b grinds (~180s on CPU). Fails as
  // normal JSON before the first byte; as an {"error":…} line after.
  // Unlike /ai/expand this never asks for JSON output — token streams of a
  // JSON document aren't displayable, so the structured task-split flow keeps
  // the blocking endpoint and this one owns narrative-only generation.
  r.post('/ai/narrate', async (req, res) => {
    const cfg = getSetting(db, 'ai') || {};
    if (!cfg.enabled) return res.status(400).json({ error: 'ai_disabled' });
    const b = req.body || {};
    const mode = ['draft', 'regenerate', 'shorter', 'longer'].includes(b.mode) ? b.mode : 'draft';
    const brief = String(b.brief || '').trim();
    const narrative = String(b.narrative || '').trim();
    if ((mode === 'shorter' || mode === 'longer') ? !narrative : !brief) {
      return res.status(400).json({ error: 'Describe the work first.' });
    }
    const messages = buildNarrateMessages({
      instructions: cfg.systemPrompt, brief, narrative, mode,
      context: b.context ? String(b.context).slice(0, 2000) : null,
    });

    // If the client goes away mid-stream (navigated off, or a regenerate
    // superseded this request), stop pulling tokens — otherwise Ollama keeps
    // generating for up to 180s with nobody reading. ServerResponse 'close'
    // fires on premature disconnect AND on normal completion; the
    // writableEnded guard limits the abort to the former.
    const upstream = new AbortController();
    res.on('close', () => { if (!res.writableEnded) upstream.abort(); });

    let resp;
    try {
      resp = await fetch(`${cfg.url}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: cfg.model, stream: true,
          // regenerate wants a *different* sample; rewrites stay conservative
          options: { temperature: mode === 'regenerate' ? 0.8 : 0.3 },
          messages,
        }),
        signal: AbortSignal.any([upstream.signal, AbortSignal.timeout(180_000)]),
      });
      if (!resp.ok || !resp.body) throw new Error(`ollama returned ${resp.status}`);
    } catch (e) {
      if (res.writableEnded || res.destroyed) return; // client already gone
      return res.status(502).json({
        error: 'ollama_unreachable',
        message: `Could not reach the local model: ${e.message}`,
      });
    }

    res.setHeader('content-type', 'application/x-ndjson');
    res.setHeader('cache-control', 'no-store');
    const send = (obj) => res.write(JSON.stringify(obj) + '\n');
    let full = '';
    try {
      let buf = '';
      // Stateful decoder: a multi-byte UTF-8 sequence (em dash, curly quote)
      // can straddle two network chunks; per-chunk toString() would corrupt
      // it to U+FFFD.
      const decoder = new TextDecoder('utf-8');
      for await (const chunk of resp.body) {
        buf += decoder.decode(chunk, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let data;
          try { data = JSON.parse(line); } catch { continue; }
          const token = data.message && data.message.content;
          if (token) { full += token; send({ token }); }
        }
      }
      decoder.decode(); // flush (NDJSON ends with \n, so nothing pending)
      send({ done: true, narrative: full.trim() });
    } catch (e) {
      // Client-gone aborts land here too — never write to a dead socket.
      if (!res.writableEnded && !res.destroyed) {
        send({ error: 'ai_stream_failed', message: e.message });
      }
    }
    if (!res.writableEnded) res.end();
  });

  return r;
}
