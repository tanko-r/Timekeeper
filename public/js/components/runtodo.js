import { api } from '/js/api.js';
import { html, useState, useEffect, useRef, useCallback, emitToast, Icon } from '/js/ui.js';

// Sidebar "Run /todo": opens a Claude session on this repo in a tmux window
// David attaches to on his own time. Two clicks to fire — the launched agent
// runs with permissions skipped and will commit and push, so a stray tap on a
// phone must not be enough to start one.

const CONFIRM_MS = 3000;

export function RunTodo() {
  const [live, setLive] = useState(null);   // { running, target, attach } | null
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const disarm = useRef(null);

  const refresh = useCallback(
    () => api.get('/api/agent/todo').then(setLive).catch(() => {}), []);
  const running = live ? live.running : false;

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => () => clearTimeout(disarm.current), []);

  // The launched command pings the server the moment it exits (see
  // server/routes/agent.js's /todo/done), which pushes a 'done' event over
  // this stream — no polling needed to notice a finished run. The connection
  // is only held open while a run is actually live: there's nothing to watch
  // for otherwise, and it keeps this from being a standing connection for
  // the app's whole session. `onopen` also re-checks on every (re)connect,
  // since that's the one moment a push could have been missed. visibility-
  // change is the last-resort fallback for anything that misses even that,
  // e.g. a backgrounded tab whose network the OS suspended.
  useEffect(() => {
    if (!running) return undefined;
    const events = new EventSource('/api/agent/todo/events');
    events.addEventListener('done', refresh);
    events.onopen = refresh;
    const onVisible = () => { if (document.visibilityState === 'visible') refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      events.close();
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [running, refresh]);

  function arm() {
    setArmed(true);
    clearTimeout(disarm.current);
    disarm.current = setTimeout(() => setArmed(false), CONFIRM_MS);
  }

  async function launch() {
    clearTimeout(disarm.current);
    setArmed(false);
    setBusy(true);
    try {
      const r = await api.post('/api/agent/todo');
      setLive({ running: true, target: r.target, attach: r.attach });
      emitToast(r.started
        ? `Started in ${r.target} — attach with ${r.attach}`
        : `Already running in ${r.target} — attach with ${r.attach}`);
    } catch (e) {
      emitToast(String(e.message || e), { error: true });
      refresh();
    } finally {
      setBusy(false);
    }
  }

  const label = busy ? 'Starting…' : armed ? 'Confirm?' : running ? '/todo running' : 'Run /todo';
  const title = running
    ? `A backlog session is open in ${live.target} — attach with ${live.attach}`
    : 'Open a Claude session on this repo in tmux and run /todo (two clicks)';

  return html`
    <button class=${'navlink' + (armed ? ' armed' : '') + (running ? ' agent-live' : '')}
      title=${title} disabled=${busy}
      onClick=${() => (running || armed ? launch() : arm())}>
      <${Icon} name="wand" size=${18} /> ${label}
    </button>`;
}
