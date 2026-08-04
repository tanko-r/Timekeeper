import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

// The /todo launcher. tmux is faked here — the route's job is deciding which
// tmux calls to make, and no test should spawn a real agent.

// Records every tmux invocation and answers from a scripted window list.
function fakeTmux({ hasSession = true, windows = '0\tbash\n', target = 'main:4', fail = null } = {}) {
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    if (fail && args[0] === fail) return { code: 1, stdout: '', stderr: 'tmux: boom' };
    if (args[0] === 'has-session') return { code: hasSession ? 0 : 1, stdout: '', stderr: '' };
    if (args[0] === 'list-windows') return { code: 0, stdout: windows, stderr: '' };
    if (args[0] === 'new-window') return { code: 0, stdout: `${target}\n`, stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  run.calls = calls;
  run.verbs = () => calls.map((a) => a[0]);
  return run;
}

async function withServer(runTmux, fn) {
  const t = await startTestServer({ deps: { runTmux } });
  try { await fn(t); } finally { await t.close(); }
}

test('POST /api/agent/todo opens a named window and returns where it went', () => {
  const tmux = fakeTmux();
  return withServer(tmux, async (t) => {
    const { status, body } = await t.fetchJson('POST', '/api/agent/todo');
    assert.equal(status, 201);
    assert.equal(body.started, true);
    assert.equal(body.target, 'main:4');
    assert.equal(body.attach, 'tmux attach -t main');

    const launch = tmux.calls.find((a) => a[0] === 'new-window');
    assert.ok(launch, 'a window was opened');
    assert.ok(launch.includes('-d'), 'detached — does not steal focus');
    assert.ok(launch.join(' ').includes('claude --dangerously-skip-permissions /todo'));
  });
});

test('a second press does not stack a second agent on the repo', () => {
  const tmux = fakeTmux({ windows: '0\tbash\n4\ttodo\n' });
  return withServer(tmux, async (t) => {
    const { status, body } = await t.fetchJson('POST', '/api/agent/todo');
    assert.equal(status, 200);
    assert.equal(body.started, false);
    assert.equal(body.target, 'main:4');
    assert.equal(tmux.verbs().includes('new-window'), false, 'nothing was launched');
  });
});

test('a missing tmux session is created before the window', () => {
  const tmux = fakeTmux({ hasSession: false });
  return withServer(tmux, async (t) => {
    const { status } = await t.fetchJson('POST', '/api/agent/todo');
    assert.equal(status, 201);
    assert.deepEqual(tmux.verbs(), ['has-session', 'new-session', 'list-windows', 'new-window']);
  });
});

test('a tmux failure surfaces as an error, not a false success', () => {
  const tmux = fakeTmux({ fail: 'new-window' });
  return withServer(tmux, async (t) => {
    const { status, body } = await t.fetchJson('POST', '/api/agent/todo');
    assert.equal(status, 500);
    assert.match(body.error, /boom/);
  });
});

test('the endpoint ignores any body the client sends', () => {
  const tmux = fakeTmux();
  return withServer(tmux, async (t) => {
    await t.fetchJson('POST', '/api/agent/todo', { command: 'rm -rf ~', window: 'x; whoami' });
    const launch = tmux.calls.find((a) => a[0] === 'new-window');
    const flat = launch.join(' ');
    assert.ok(!flat.includes('rm -rf'), 'client command ignored');
    assert.ok(!flat.includes('whoami'), 'client window name ignored');
    assert.ok(flat.includes('-n todo'), 'window name is the constant');
  });
});

test('GET /api/agent/todo reports whether a run is live', () => {
  const tmux = fakeTmux({ windows: '0\tbash\n7\ttodo\n' });
  return withServer(tmux, async (t) => {
    const { status, body } = await t.fetchJson('GET', '/api/agent/todo');
    assert.equal(status, 200);
    assert.deepEqual(body, { running: true, target: 'main:7', attach: 'tmux attach -t main' });
  });
});

test('GET /api/agent/todo reports idle without creating anything', () => {
  const tmux = fakeTmux({ hasSession: false });
  return withServer(tmux, async (t) => {
    const { body } = await t.fetchJson('GET', '/api/agent/todo');
    assert.equal(body.running, false);
    assert.equal(body.target, null);
    assert.deepEqual(tmux.verbs(), ['has-session'], 'a status check never starts a session');
  });
});
