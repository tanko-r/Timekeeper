import { Router } from 'express';
import { execFile } from 'node:child_process';
import { repoRoot } from '../config.js';
import {
  AGENT_COMMAND, AGENT_SESSION, AGENT_WINDOW, agentWindowIn,
  hasSessionArgs, killWindowArgs, listPanesArgs, listWindowsArgs,
  newSessionArgs, newWindowArgs, paneIsRunningAgent,
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

  // Window presence alone doesn't mean a run is live: the window is kept
  // open after the command finishes (shellWrap's `exec bash -i`) so David
  // can review the transcript. `target` is set whenever the named window
  // exists at all; `running` additionally checks the pane's foreground
  // command to tell an active run apart from a finished, parked one.
  async function windowStatus() {
    const has = await runTmux(hasSessionArgs(AGENT_SESSION));
    if (has.code !== 0) return { target: null, running: false };
    const list = await runTmux(listWindowsArgs(AGENT_SESSION));
    if (list.code !== 0) return { target: null, running: false };
    const target = agentWindowIn(list.stdout, AGENT_SESSION);
    if (!target) return { target: null, running: false };
    const panes = await runTmux(listPanesArgs(target));
    return { target, running: panes.code === 0 && paneIsRunningAgent(panes.stdout) };
  }

  r.get('/todo', async (req, res, next) => {
    try {
      const { target, running } = await windowStatus();
      res.json({ running, target, attach });
    } catch (e) { next(e); }
  });

  r.post('/todo', async (req, res, next) => {
    try {
      const has = await runTmux(hasSessionArgs(AGENT_SESSION));
      if (has.code !== 0) {
        const made = await runTmux(newSessionArgs(AGENT_SESSION, repoRoot));
        if (made.code !== 0) return res.status(500).json({ error: made.stderr.trim() || 'tmux new-session failed' });
      }

      // One agent per repo: a second press while the first is still live
      // reports it instead of stacking another full-permission session on
      // the same working tree.
      const list = await runTmux(listWindowsArgs(AGENT_SESSION));
      if (list.code !== 0) return res.status(500).json({ error: list.stderr.trim() || 'tmux list-windows failed' });
      const existing = agentWindowIn(list.stdout, AGENT_SESSION);
      if (existing) {
        const panes = await runTmux(listPanesArgs(existing));
        if (panes.code === 0 && paneIsRunningAgent(panes.stdout)) {
          return res.json({ ok: true, started: false, target: existing, attach });
        }
        // Previous run finished but the window stuck around for its
        // transcript — clear it so a fresh run can claim the name.
        const killed = await runTmux(killWindowArgs(existing));
        if (killed.code !== 0) return res.status(500).json({ error: killed.stderr.trim() || 'tmux kill-window failed' });
      }

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
