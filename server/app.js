import express from 'express';
import { join } from 'node:path';
import { repoRoot } from './config.js';
import { cmsRouter } from './routes/cms.js';
import { taskCodesRouter } from './routes/taskcodes.js';
import { settingsRouter } from './routes/settings.js';

// App factory. deps = { db, config, clock } — clock injectable for tests.
export function createApp(deps) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  app.use(express.json({ limit: '2mb' }));

  app.get('/api/health', (req, res) => res.json({ ok: true }));
  app.use('/api/cms', cmsRouter(deps));
  app.use('/api/task-codes', taskCodesRouter(deps));
  app.use('/api/settings', settingsRouter(deps));

  // JSON 404 for unknown API routes (registered after real routes are mounted).
  app.use('/api', (req, res) => res.status(404).json({ error: 'not_found' }));

  app.use(express.static(join(repoRoot, 'public')));
  // SPA fallback: non-API GETs get the shell (hash routing needs only '/').
  app.get('/{*any}', (req, res) =>
    res.sendFile(join(repoRoot, 'public', 'index.html')));

  // JSON error handler for API paths.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || (err.type === 'entity.parse.failed' ? 400 : 500);
    if (status >= 500) console.error(err);
    res.status(status).json({ error: err.expose || status < 500 ? String(err.message) : 'internal_error' });
  });

  return app;
}
