import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

// The /todo launcher. tmux is faked here — the route's job is deciding which
// tmux calls to make, and no test should spawn a real agent.

// Records every tmux invocation and answers from a scripted window list.
// `pane` is the todo window's foreground command — 'claude' while a run is
// actually live, 'bash' once it finished and shellWrap's `exec bash -i`
// parked the window for its transcript.
function fakeTmux({
  hasSession = true, windows = '0\tbash\n', target = 'main:4', pane = 'claude', fail = null,
} = {}) {
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    if (fail && args[0] === fail) return { code: 1, stdout: '', stderr: 'tmux: boom' };
    if (args[0] === 'has-session') return { code: hasSession ? 0 : 1, stdout: '', stderr: '' };
    if (args[0] === 'list-windows') return { code: 0, stdout: windows, stderr: '' };
    if (args[0] === 'list-panes') return { code: 0, stdout: `${pane}\n`, stderr: '' };
    if (args[0] === 'new-window') return { code: 0, stdout: `${target}\n`, stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  run.calls = calls;
  run.verbs = () => calls.map((a) => a[0]);
  return run;
}

async function withServer(runTmux, fn, config) {
  const t = await startTestServer({ deps: { runTmux }, config });
  try { await fn(t); } finally { await t.close(); }
}

// Reads a fetch ReadableStream's raw text until it contains `needle`, or
// throws if `budgetMs` passes first — a broken push must fail the test
// quickly, not hang it.
async function readUntil(reader, needle, budgetMs = 2000) {
  const decoder = new TextDecoder();
  let buf = '';
  const deadline = Date.now() + budgetMs;
  while (!buf.includes(needle)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${JSON.stringify(needle)}; got ${JSON.stringify(buf)}`);
    const { value, done } = await reader.read();
    if (done) throw new Error('stream ended before ' + JSON.stringify(needle));
    buf += decoder.decode(value, { stream: true });
  }
  return buf;
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

test('a second press does not stack a second agent while the first is still live', () => {
  const tmux = fakeTmux({ windows: '0\tbash\n4\ttodo\n', pane: 'claude' });
  return withServer(tmux, async (t) => {
    const { status, body } = await t.fetchJson('POST', '/api/agent/todo');
    assert.equal(status, 200);
    assert.equal(body.started, false);
    assert.equal(body.target, 'main:4');
    assert.equal(tmux.verbs().includes('new-window'), false, 'nothing was launched');
  });
});

test('a second press after the previous run finished closes the parked window and starts fresh', () => {
  const tmux = fakeTmux({ windows: '0\tbash\n4\ttodo\n', pane: 'bash', target: 'main:9' });
  return withServer(tmux, async (t) => {
    const { status, body } = await t.fetchJson('POST', '/api/agent/todo');
    assert.equal(status, 201);
    assert.equal(body.started, true);
    assert.equal(body.target, 'main:9');
    assert.deepEqual(tmux.verbs(), ['has-session', 'list-windows', 'list-panes', 'kill-window', 'new-window']);
    assert.deepEqual(tmux.calls.find((a) => a[0] === 'kill-window'), ['kill-window', '-t', 'main:4']);
  });
});

test('a kill-window failure while clearing a finished run surfaces as an error', () => {
  const tmux = fakeTmux({ windows: '0\tbash\n4\ttodo\n', pane: 'bash', fail: 'kill-window' });
  return withServer(tmux, async (t) => {
    const { status, body } = await t.fetchJson('POST', '/api/agent/todo');
    assert.equal(status, 500);
    assert.match(body.error, /boom/);
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
  const tmux = fakeTmux({ windows: '0\tbash\n7\ttodo\n', pane: 'claude' });
  return withServer(tmux, async (t) => {
    const { status, body } = await t.fetchJson('GET', '/api/agent/todo');
    assert.equal(status, 200);
    assert.deepEqual(body, { running: true, target: 'main:7', attach: 'tmux attach -t main' });
  });
});

test('GET /api/agent/todo reports idle once the run finishes, even though the window lingers', () => {
  const tmux = fakeTmux({ windows: '0\tbash\n7\ttodo\n', pane: 'bash' });
  return withServer(tmux, async (t) => {
    const { status, body } = await t.fetchJson('GET', '/api/agent/todo');
    assert.equal(status, 200);
    assert.deepEqual(body, { running: false, target: 'main:7', attach: 'tmux attach -t main' });
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

test('POST /api/agent/todo points the parked window at this server\'s completion hook', () => {
  const tmux = fakeTmux();
  return withServer(tmux, async (t) => {
    await t.fetchJson('POST', '/api/agent/todo');
    const launch = tmux.calls.find((a) => a[0] === 'new-window');
    const wrapped = launch[launch.length - 1];
    assert.match(wrapped, /curl -fsS -m 5 -X POST http:\/\/127\.0\.0\.1:4747\/api\/agent\/todo\/done >\/dev\/null 2>&1 \|\| true; exec bash -i$/);
  }, { PORT: 4747 });
});

test('GET /api/agent/todo/events opens an SSE stream', () => {
  const tmux = fakeTmux();
  return withServer(tmux, async (t) => {
    const res = await fetch(t.base + '/api/agent/todo/events');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    await res.body.cancel();
  });
});

test('POST /api/agent/todo/done pushes a done event to open SSE listeners', () => {
  const tmux = fakeTmux();
  return withServer(tmux, async (t) => {
    const res = await fetch(t.base + '/api/agent/todo/events');
    const reader = res.body.getReader();

    // Wait for the initial ':ok' comment so the listener is registered
    // before firing the notification — otherwise the POST could race ahead
    // of the server adding this connection to its client set.
    await readUntil(reader, '\n\n');

    const [, payload] = await Promise.all([
      t.fetchJson('POST', '/api/agent/todo/done'),
      readUntil(reader, 'event: done'),
    ]);
    assert.match(payload, /event: done\ndata: \{\}/);
    await reader.cancel();
  });
});

test('POST /api/agent/todo/done is harmless with no listeners connected', () => {
  const tmux = fakeTmux();
  return withServer(tmux, async (t) => {
    const { status } = await t.fetchJson('POST', '/api/agent/todo/done');
    assert.equal(status, 204);
  });
});
