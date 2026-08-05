import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_COMMAND, agentWindowIn, killWindowArgs, listPanesArgs, listWindowsArgs,
  newSessionArgs, newWindowArgs, paneIsRunningAgent, parseWindowList, shellWrap,
} from '../server/lib/agentsession.js';

// tmux prints one window per line as "<index>\t<name>". Index first so a
// window name containing a tab (possible — tmux allows it) can't shift the
// field we care about.
const LIST = '0\tbash\n3\tnanoclaw\n4\ttodo\n';

test('parseWindowList reads index and name off each line', () => {
  assert.deepEqual(parseWindowList(LIST), [
    { index: 0, name: 'bash' },
    { index: 3, name: 'nanoclaw' },
    { index: 4, name: 'todo' },
  ]);
});

test('parseWindowList tolerates empty and ragged output', () => {
  assert.deepEqual(parseWindowList(''), []);
  assert.deepEqual(parseWindowList('\n\n'), []);
  assert.deepEqual(parseWindowList('2\tmy\ttabbed\tname\n'),
    [{ index: 2, name: 'my\ttabbed\tname' }]);
});

test('agentWindowIn returns the session:index target when a run is live', () => {
  assert.equal(agentWindowIn(LIST, 'main'), 'main:4');
});

test('agentWindowIn returns null when no agent window exists', () => {
  assert.equal(agentWindowIn('0\tbash\n1\tvim\n', 'main'), null);
  assert.equal(agentWindowIn('', 'main'), null);
});

test('agentWindowIn does not match a window merely containing the name', () => {
  assert.equal(agentWindowIn('0\ttodo-notes\n1\tmy todo\n', 'main'), null);
});

test('shellWrap runs the command under a login shell and keeps the window alive', () => {
  // ~/.local/bin/claude is not on the systemd user service's PATH, so the
  // window has to source the login environment. `exec bash -i` afterwards
  // preserves the transcript for whenever David actually attaches.
  assert.deepEqual(shellWrap('echo hi'), ['bash', '-lc', 'echo hi; exec bash -i']);
});

test('newWindowArgs launches detached, named, in the repo, and reports its target', () => {
  const args = newWindowArgs({ session: 'main', window: 'todo', cwd: '/repo', command: 'run me' });
  assert.deepEqual(args, [
    'new-window', '-d', '-t', 'main', '-n', 'todo', '-c', '/repo',
    '-P', '-F', '#{session_name}:#{window_index}',
    '--', 'bash', '-lc', 'run me; exec bash -i',
  ]);
});

test('new window is detached so it never steals focus from an attached session', () => {
  const args = newWindowArgs({ session: 'main', window: 'todo', cwd: '/repo', command: 'x' });
  assert.ok(args.includes('-d'), '-d keeps David on the window he is looking at');
});

test('session and list argument builders target the named session', () => {
  assert.deepEqual(newSessionArgs('main', '/repo'), ['new-session', '-d', '-s', 'main', '-c', '/repo']);
  assert.deepEqual(listWindowsArgs('main'),
    ['list-windows', '-t', 'main', '-F', '#{window_index}\t#{window_name}']);
});

test('the launch command is a fixed constant, not built from input', () => {
  assert.equal(AGENT_COMMAND, 'claude --dangerously-skip-permissions /todo');
});

test('listPanesArgs asks tmux for the pane\'s foreground command', () => {
  assert.deepEqual(listPanesArgs('main:4'), ['list-panes', '-t', 'main:4', '-F', '#{pane_current_command}']);
});

test('paneIsRunningAgent is true only while claude is still the foreground command', () => {
  assert.equal(paneIsRunningAgent('claude\n'), true);
  // exec bash -i (see shellWrap) replaces claude once the run finishes, so
  // the pane reports `bash` even though the window itself lingers.
  assert.equal(paneIsRunningAgent('bash\n'), false);
  assert.equal(paneIsRunningAgent(''), false);
});

test('killWindowArgs targets the exact window', () => {
  assert.deepEqual(killWindowArgs('main:4'), ['kill-window', '-t', 'main:4']);
});
