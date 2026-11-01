import { api } from '/js/api.js';
import { html, useState, useEffect, useCallback, emitToast, todayStr, fmtHours } from '/js/ui.js';
import { runKind, toInputValue, fromInputValue, fmtRunStamp } from '/js/lib/runtimes.js';

// A compact line in the entry editor for the timer behind the entry:
// when its last run started and stopped, with both times editable. Meant for
// the "forgot to stop it" case — a running timer can be stopped at an earlier
// time; a stopped one can have either end corrected. The server re-files the
// entry total (and, for a run left on overnight, takes the extra time back
// out of yesterday's entry). Renders nothing when there is no timer run.
export function RunRow({ entryId, onApplied }) {
  const [info, setInfo] = useState(null);
  const [start, setStart] = useState('');
  const [stop, setStop] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const i = await api.get(`/api/timers/for-entry/${entryId}`);
      setInfo(i);
      if (!i) return;
      const kind = runKind(i.start, todayStr());
      setStart(toInputValue(i.start, kind));
      setStop(i.running ? '' : toInputValue(i.stop, kind));
    } catch {
      setInfo(null); // no timer behind this entry
    }
  }, [entryId]);

  useEffect(() => {
    load();
    window.addEventListener('tk:timers-changed', load);
    return () => window.removeEventListener('tk:timers-changed', load);
  }, [load]);

  if (!info || (!info.start && !info.stop)) return null;

  const today = todayStr();
  const kind = runKind(info.start, today);
  const startChanged = info.canEditStart && start !== toInputValue(info.start, kind);
  const stopChanged = info.canEditStop && stop !== '' && stop !== toInputValue(info.stop, kind);
  const dirty = startChanged || stopChanged;

  async function apply() {
    const body = {};
    if (startChanged) {
      const iso = fromInputValue(start, today);
      if (!iso) { emitToast('That start time is not valid.', { error: true }); return; }
      body.start = iso;
    }
    if (stopChanged) {
      const iso = fromInputValue(stop, today);
      if (!iso) { emitToast('That stop time is not valid.', { error: true }); return; }
      body.stop = iso;
    }
    setBusy(true);
    try {
      const r = await api.post(`/api/timers/${info.timer.id}/adjust`, body);
      emitToast(r.entry ? `Updated — entry is now ${fmtHours(r.entry.total)} h.` : 'Updated.');
      await load();
      if (onApplied) onApplied();
    } catch (e) {
      emitToast(e.message, { error: true });
    } finally {
      setBusy(false);
    }
  }

  const startBox = info.canEditStart
    ? html`<input type="${kind === 'datetime' ? 'datetime-local' : 'time'}" class="run-input" value=${start}
        aria-label="Timer start time" onInput=${(e) => setStart(e.target.value)} />`
    : html`<strong>${fmtRunStamp(info.start, today)}</strong>`;

  return html`
    <div class="run-row small" data-testid="run-row">
      <span class="muted">${info.running ? 'Timer running since' : 'Timer ran'}</span>
      ${startBox}
      <span class="muted">${info.running ? '· stop it at' : '→ stopped'}</span>
      ${info.canEditStop
        ? html`<input type="${kind === 'datetime' ? 'datetime-local' : 'time'}" class="run-input" value=${stop}
            aria-label="Timer stop time" onInput=${(e) => setStop(e.target.value)} />`
        : html`<strong>${fmtRunStamp(info.stop, today)}</strong>`}
      ${dirty ? html`
        <button type="button" class="btn btn-sm btn-primary" disabled=${busy} onClick=${apply}>
          ${info.running && stopChanged ? 'Stop at this time' : 'Save'}
        </button>` : null}
    </div>`;
}
