import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { createApp } from './app.js';

const config = loadConfig();
const db = openDb(config.DB_PATH);
const app = createApp({ db, config, clock: () => new Date() });

app.listen(config.PORT, config.HOST, () => {
  console.log(`Timekeeper listening on http://${config.HOST}:${config.PORT}`);
});
