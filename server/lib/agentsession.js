// Driving tmux from the app: pure argument builders and output parsers.
// Nothing here spawns anything — the route owns that — so the decisions
// (does a session exist, is a run already live, what gets launched) are
// unit-testable without a tmux server.

export const AGENT_SESSION = 'main';   // David's everyday tmux session
export const AGENT_WINDOW = 'todo';

// The only command this feature can ever run. Deliberately a constant: the
// HTTP endpoint accepts no parameters, so an attacker holding the app
// password can press this one button but cannot turn it into "run anything".
// `cldd` itself is an interactive-shell alias, so we spell it out.
export const AGENT_COMMAND = 'claude --dangerously-skip-permissions /todo';

// `#{window_index}` first: tmux permits tabs inside a window name, and putting
// the fixed-shape field first keeps the split unambiguous.
const LIST_FORMAT = '#{window_index}\t#{window_name}';

export function parseWindowList(stdout) {
  return String(stdout || '').split('\n').flatMap((line) => {
    const tab = line.indexOf('\t');
    if (tab < 0) return [];
    return [{ index: Number(line.slice(0, tab)), name: line.slice(tab + 1) }];
  });
}

// 'main:4' if an agent window is already open in this session, else null.
export function agentWindowIn(stdout, session, window = AGENT_WINDOW) {
  const hit = parseWindowList(stdout).find((w) => w.name === window);
  return hit ? `${session}:${hit.index}` : null;
}

// ~/.local/bin/claude is not on the systemd user service's PATH, and the tmux
// server may have been started from anywhere, so the window sources a login
// environment. `exec bash -i` afterwards leaves the finished transcript on
// screen for whenever David actually attaches.
export function shellWrap(command) {
  return ['bash', '-lc', `${command}; exec bash -i`];
}

export function hasSessionArgs(session) {
  return ['has-session', '-t', session];
}

export function newSessionArgs(session, cwd) {
  return ['new-session', '-d', '-s', session, '-c', cwd];
}

export function listWindowsArgs(session) {
  return ['list-windows', '-t', session, '-F', LIST_FORMAT];
}

// -d so an attached client stays on the window it was looking at; -P -F makes
// tmux print the new window's 'session:index' so the UI can say where it went.
export function newWindowArgs({ session, window, cwd, command }) {
  return [
    'new-window', '-d', '-t', session, '-n', window, '-c', cwd,
    '-P', '-F', '#{session_name}:#{window_index}',
    '--', ...shellWrap(command),
  ];
}
