import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadConfig } from '../../server/config.js';
import { openDb, getSetting, setSetting } from '../../server/db.js';
import { todayLocal } from '../../server/lib/dates.js';
import { allocateTenths } from '../../server/lib/allocate.js';
import { containsTimeAmounts } from '../../server/lib/timeAmounts.js';
import { parseQuickCapture } from '../../server/lib/quickcapture.js';
import {
  DEFAULT_AI_INSTRUCTIONS, matterAiContext, systemPrompt,
  NAME_RESOLUTION_RULE, timeGroundingRule, buildNarrateMessages, checkOllamaReachable,
} from '../../server/routes/ai.js';
import { buildLlmFillMessages } from '../../server/routes/quickcapture.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const config = loadConfig();
const db = openDb(config.DB_PATH);

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

app.get('/api/seed/entries', (req, res) => {
  const rows = db.prepare(`
    SELECT e.id, e.date, e.narrative, e.total_override, e.cm_id, m.short_name
    FROM entries e
    JOIN matters m ON m.id = e.cm_id
    WHERE e.deleted_at IS NULL AND e.narrative != ''
    ORDER BY e.date DESC, e.id DESC
    LIMIT 200
  `).all();
  res.json(rows);
});

app.get('/api/seed/matters', (req, res) => {
  const rows = db.prepare(`
    SELECT m.id, m.cm_number, m.short_name, c.name AS client_name
    FROM matters m
    LEFT JOIN clients c ON c.id = m.client_id
    WHERE m.status != 'archived'
    ORDER BY m.short_name
  `).all();
  res.json(rows);
});

app.get('/api/context/:matterId', (req, res) => {
  const cmId = Number(req.params.matterId);
  const context = matterAiContext(db, cmId, todayLocal(new Date()));
  res.json({ context });
});

app.get('/api/settings/ai', async (req, res) => {
  const cfg = getSetting(db, 'ai') || {};
  const { reachable, models } = await checkOllamaReachable(cfg.url);
  res.json({
    enabled: !!cfg.enabled, model: cfg.model, url: cfg.url, reachable, models,
    systemPrompt: cfg.systemPrompt || '',
    defaultPrompt: DEFAULT_AI_INSTRUCTIONS,
  });
});

app.post('/api/run/expand', async (req, res) => {
  const cfg = getSetting(db, 'ai') || {};
  const b = req.body || {};
  const brief = String(b.brief || '').trim();
  if (!brief) return res.status(400).json({ error: 'brief is required' });
  const totalHours = b.totalHours != null ? Number(b.totalHours) : null;
  const codes = db.prepare(
    'SELECT name FROM task_codes WHERE active=1 ORDER BY sort_order, id').all().map((x) => x.name);
  const matterCtx = b.cmId ? matterAiContext(db, Number(b.cmId), todayLocal(new Date())) : null;
  const system = systemPrompt(codes, b.instructions) + timeGroundingRule(totalHours)
    + (matterCtx ? NAME_RESOLUTION_RULE : '');
  const user = [
    matterCtx,
    totalHours ? `Total time: ${totalHours} hours.\nWork done: ${brief}` : `Work done: ${brief}`,
  ].filter(Boolean).join('\n\n');
  const messages = [{ role: 'system', content: system }, { role: 'user', content: user }];

  let raw;
  try {
    const resp = await fetch(`${cfg.url}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: cfg.model, stream: false, format: 'json', options: { temperature: 0.3 }, messages }),
      signal: AbortSignal.timeout(180_000),
    });
    if (!resp.ok) throw new Error(`ollama returned ${resp.status}`);
    raw = await resp.json();
  } catch (e) {
    return res.status(502).json({ error: 'ollama_unreachable', message: e.message, request: { messages } });
  }

  let parsed = null;
  try { parsed = JSON.parse(raw.message?.content); } catch { /* leave null */ }
  let tasks = [];
  if (parsed && Array.isArray(parsed.tasks)) {
    tasks = parsed.tasks.slice(0, 8).map((t) => ({
      task_code: codes.includes(t.task_code) ? t.task_code : (codes[0] || ''),
      fragment: String(t.fragment || '').trim().slice(0, 400),
      share: Number(t.share) > 0 ? Number(t.share) : 0,
    }));
  }
  const hours = totalHours && tasks.length ? allocateTenths(totalHours, tasks.map((t) => t.share)) : null;

  res.json({
    request: { messages, model: cfg.model, options: { temperature: 0.3 }, format: 'json' },
    raw,
    parsed: {
      narrative: parsed?.narrative ?? null,
      tasks: tasks.map((t, i) => ({ task_code: t.task_code, fragment: t.fragment, hours: hours ? hours[i] : null })),
    },
  });
});

app.post('/api/run/narrate', async (req, res) => {
  const cfg = getSetting(db, 'ai') || {};
  const b = req.body || {};
  const mode = ['draft', 'regenerate', 'shorter', 'longer'].includes(b.mode) ? b.mode : 'draft';
  const brief = String(b.brief || '').trim();
  const narrative = String(b.narrative || '').trim();
  const matterCtx = b.cmId ? matterAiContext(db, Number(b.cmId), todayLocal(new Date())) : null;
  const messages = buildNarrateMessages({
    instructions: b.instructions, brief, narrative, mode,
    totalHours: b.totalHours, context: matterCtx,
  });
  const temperature = mode === 'regenerate' ? 0.8 : 0.3;

  let raw;
  try {
    const resp = await fetch(`${cfg.url}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: cfg.model, stream: false, options: { temperature }, messages }),
      signal: AbortSignal.timeout(180_000),
    });
    if (!resp.ok) throw new Error(`ollama returned ${resp.status}`);
    raw = await resp.json();
  } catch (e) {
    return res.status(502).json({ error: 'ollama_unreachable', message: e.message, request: { messages } });
  }

  res.json({
    request: { messages, model: cfg.model, options: { temperature } },
    raw,
    narrative: (raw.message?.content || '').trim(),
  });
});

app.post('/api/run/timer-suggest', async (req, res) => {
  const cfg = getSetting(db, 'ai') || {};
  const b = req.body || {};
  const cmId = Number(b.cmId);
  const matter = db.prepare('SELECT short_name FROM matters WHERE id=?').get(cmId);
  if (!matter) return res.status(400).json({ error: 'unknown matter id' });
  const timerName = String(b.timerName || matter.short_name);
  const matterCtx = matterAiContext(db, cmId, todayLocal(new Date()));
  const brief = `Matter: ${matter.short_name}. Timer label: ${timerName}. Draft the single most likely billing narrative for today's work session on this matter.`;
  const messages = buildNarrateMessages({ instructions: b.instructions, brief, context: matterCtx });

  let raw;
  try {
    const resp = await fetch(`${cfg.url}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: cfg.model, stream: false, options: { temperature: 0.3 }, messages }),
      signal: AbortSignal.timeout(180_000),
    });
    if (!resp.ok) throw new Error(`ollama returned ${resp.status}`);
    raw = await resp.json();
  } catch (e) {
    return res.status(502).json({ error: 'ollama_unreachable', message: e.message, request: { messages } });
  }

  const text = String(raw.message?.content || '').trim().replace(/^["']|["']$/g, '').slice(0, 300);
  const accepted = !!text && !text.includes('{') && !containsTimeAmounts(text);
  const rejectReason = accepted ? null
    : (!text ? 'empty response' : text.includes('{') ? 'JSON-ish output' : 'contains invented time amounts');

  res.json({
    request: { messages, model: cfg.model, options: { temperature: 0.3 } },
    raw, narrative: text, accepted, rejectReason,
  });
});

app.post('/api/run/quickcapture', async (req, res) => {
  const cfg = getSetting(db, 'ai') || {};
  const b = req.body || {};
  const line = String(b.line || '').trim();
  if (!line) return res.status(400).json({ error: 'line is required' });
  const matters = db.prepare(`SELECT m.id, m.cm_number, m.matter_number, m.short_name,
      m.favorite, m.last_used_at, c.name AS client_name, c.client_number
    FROM matters m LEFT JOIN clients c ON c.id = m.client_id WHERE m.status != 'archived'`).all();
  const taskCodes = db.prepare(
    'SELECT name FROM task_codes WHERE active=1 ORDER BY sort_order, id').all().map((x) => x.name);
  const parsed = parseQuickCapture(line, { matters, taskCodes });
  const messages = buildLlmFillMessages(line, parsed, taskCodes);

  let raw;
  try {
    const resp = await fetch(`${cfg.url}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: cfg.model, stream: false, format: 'json', options: { temperature: 0.2 }, messages }),
      signal: AbortSignal.timeout(180_000),
    });
    if (!resp.ok) throw new Error(`ollama returned ${resp.status}`);
    raw = await resp.json();
  } catch (e) {
    return res.status(502).json({ error: 'ollama_unreachable', message: e.message, request: { messages } });
  }

  let filled = {};
  try { filled = JSON.parse(raw.message?.content); } catch { /* leave {} */ }

  res.json({
    request: { messages, model: cfg.model, options: { temperature: 0.2 }, format: 'json' },
    raw, deterministic: parsed, filled,
  });
});

const PORT = Number(process.env.AI_AUDIT_PORT || 4748);
app.listen(PORT, '127.0.0.1', () => {
  console.log(`AI prompt audit tool listening on http://127.0.0.1:${PORT}`);
});
