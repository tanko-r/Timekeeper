import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { createApp } from './app.js';
import { startJobs } from './jobs.js';

const config = loadConfig();
const db = openDb(config.DB_PATH);
const deps = { db, config, clock: () => new Date() };
const app = createApp(deps);

startJobs(deps);

app.listen(config.PORT, config.HOST, () => {
  console.log(`Timekeeper listening on http://${config.HOST}:${config.PORT}`);
});
