import express from 'express';
import { join } from 'node:path';
import { repoRoot } from './config.js';
import { cmsRouter } from './routes/cms.js';
import { clientsRouter } from './routes/clients.js';
import { mattersRouter } from './routes/matters.js';
import { shortcutsRouter } from './routes/shortcuts.js';
import { quickCaptureRouter } from './routes/quickcapture.js';
import { taskCodesRouter } from './routes/taskcodes.js';
import { settingsRouter } from './routes/settings.js';
import { entriesRouter, finalizeDayRouter } from './routes/entries.js';
import { timersRouter, timerGroupsRouter } from './routes/timers.js';
import { exportRouter } from './routes/export.js';
import { statsRouter } from './routes/stats.js';
import { dashboardRouter } from './routes/dashboard.js';
import { authRouter, authGuard, originCheck } from './auth.js';
import { backupRouter } from './routes/backup.js';
import { aiRouter } from './routes/ai.js';
import { feedbackRouter } from './routes/feedback.js';

// App factory. deps = { db, config, clock } — clock injectable for tests.
export function createApp(deps) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  // Screenshot data URLs on the feedback route need more headroom than the
  // global cap; this parser claims that body first, so the 2mb one skips it.
  app.use('/api/feedback', express.json({ limit: '12mb' }));
  app.use(express.json({ limit: '2mb' }));

  app.get('/api/health', (req, res) => res.json({ ok: true }));
  app.use('/api', originCheck(deps.config));
  app.use('/api/auth', authRouter(deps));
  app.use('/api', authGuard(deps));
  app.use('/api/cms', cmsRouter(deps));
  app.use('/api/clients', clientsRouter(deps));
  app.use('/api/matters', mattersRouter(deps));
  app.use('/api/shortcuts', shortcutsRouter(deps));
  app.use('/api', quickCaptureRouter(deps));
  app.use('/api/task-codes', taskCodesRouter(deps));
  app.use('/api/settings', settingsRouter(deps));
  app.use('/api/entries', entriesRouter(deps));
  app.use('/api', finalizeDayRouter(deps));
  app.use('/api/timer-groups', timerGroupsRouter(deps));
  app.use('/api/timers', timersRouter(deps));
  app.use('/api', exportRouter(deps));
  app.use('/api', statsRouter(deps));
  app.use('/api', dashboardRouter(deps));
  app.use('/api', backupRouter(deps));
  app.use('/api', aiRouter(deps));
  app.use('/api/feedback', feedbackRouter(deps));

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
    res.status(status).json({ error: (err.expose || status < 500) ? String(err.message) : 'internal_error' });
  });

  return app;
}
