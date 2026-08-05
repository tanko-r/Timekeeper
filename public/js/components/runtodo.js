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

  // The run happens in a detached tmux window with nothing pushing status
  // back to the browser, so this has to poll — otherwise the button is only
  // ever as fresh as the last full page load.
  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 5000);
    return () => clearInterval(id);
  }, [refresh]);
  useEffect(() => () => clearTimeout(disarm.current), []);

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

  const running = live && live.running;
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
