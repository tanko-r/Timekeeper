import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

export function loadConfig(env = process.env) {
  const dataDir = env.TK_DATA_DIR || join(repoRoot, 'data');
  return {
    PORT: Number(env.TK_PORT || 4747),
    HOST: env.TK_HOST || '0.0.0.0',
    DATA_DIR: dataDir,
    DB_PATH: env.TK_DB_PATH || join(dataDir, 'timekeeper.db'),
    // Hostname the app is reachable at through the tunnel (Origin allow-list).
    PUBLIC_HOSTNAME: env.TK_PUBLIC_HOSTNAME || 'time.example.com',
    // Alt+drag UI-feedback capture: screenshots and the TODO that indexes
    // them live in the REPO (not data/) so review happens alongside the code.
    FEEDBACK_DIR: env.TK_FEEDBACK_DIR || join(repoRoot, 'feedback'),
    TODO_PATH: env.TK_TODO_PATH || join(repoRoot, 'TODO.md'),
  };
}

export { repoRoot };
