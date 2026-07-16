import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadConfig } from '../../server/config.js';
import { openDb, getSetting } from '../../server/db.js';
import { todayLocal } from '../../server/lib/dates.js';
import { DEFAULT_AI_INSTRUCTIONS, matterAiContext, checkOllamaReachable } from '../../server/routes/ai.js';

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

const PORT = Number(process.env.AI_AUDIT_PORT || 4748);
app.listen(PORT, '127.0.0.1', () => {
  console.log(`AI prompt audit tool listening on http://127.0.0.1:${PORT}`);
});
