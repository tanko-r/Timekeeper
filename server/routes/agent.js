import { Router } from 'express';
import { execFile } from 'node:child_process';
import { repoRoot } from '../config.js';
import {
  AGENT_COMMAND, AGENT_SESSION, AGENT_WINDOW, agentWindowIn,
  hasSessionArgs, listWindowsArgs, newSessionArgs, newWindowArgs,
} from '../lib/agentsession.js';

// Sidebar "Run /todo": opens a Claude session on this repo in a tmux window
// David can attach to later. The route takes NO input — the command, session,
// and window name are all constants in lib/agentsession.js — so the endpoint
// is a single fixed action rather than a remote shell. execFile (not exec)
// means there is no shell between us and tmux either.

// Never rejects on a non-zero exit: `has-session` returning 1 is a normal
// answer, not a failure.
function spawnTmux(args) {
  return new Promise((resolve) => {
    execFile('tmux', args, { timeout: 10_000 }, (err, stdout, stderr) => {
      resolve({
        code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        stdout: String(stdout || ''),
        stderr: String(stderr || err?.message || ''),
      });
    });
  });
}

export function agentRouter({ runTmux = spawnTmux } = {}) {
  const r = Router();

  const attach = `tmux attach -t ${AGENT_SESSION}`;

  // Returns the live window target, or null. Never creates anything.
  async function liveTarget() {
    const has = await runTmux(hasSessionArgs(AGENT_SESSION));
    if (has.code !== 0) return null;
    const list = await runTmux(listWindowsArgs(AGENT_SESSION));
    if (list.code !== 0) return null;
    return agentWindowIn(list.stdout, AGENT_SESSION);
  }

  r.get('/todo', async (req, res, next) => {
    try {
      const target = await liveTarget();
      res.json({ running: Boolean(target), target, attach });
    } catch (e) { next(e); }
  });

  r.post('/todo', async (req, res, next) => {
    try {
      const has = await runTmux(hasSessionArgs(AGENT_SESSION));
      if (has.code !== 0) {
        const made = await runTmux(newSessionArgs(AGENT_SESSION, repoRoot));
        if (made.code !== 0) return res.status(500).json({ error: made.stderr.trim() || 'tmux new-session failed' });
      }

      // One agent per repo: a second press reports the first one instead of
      // stacking another full-permission session on the same working tree.
      const list = await runTmux(listWindowsArgs(AGENT_SESSION));
      if (list.code !== 0) return res.status(500).json({ error: list.stderr.trim() || 'tmux list-windows failed' });
      const existing = agentWindowIn(list.stdout, AGENT_SESSION);
      if (existing) return res.json({ ok: true, started: false, target: existing, attach });

      const launched = await runTmux(newWindowArgs({
        session: AGENT_SESSION, window: AGENT_WINDOW, cwd: repoRoot, command: AGENT_COMMAND,
      }));
      if (launched.code !== 0) return res.status(500).json({ error: launched.stderr.trim() || 'tmux new-window failed' });

      res.status(201).json({
        ok: true, started: true, target: launched.stdout.trim() || AGENT_SESSION, attach,
      });
    } catch (e) { next(e); }
  });

  return r;
}
