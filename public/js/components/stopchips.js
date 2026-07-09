import { api } from '/js/api.js';
import { html, useState, useEffect, useRef, createPortal, fmtHours, emitToast, Icon } from '/js/ui.js';

// Non-blocking stop affordance (spec §6): replaces the per-stop StopPopup
// modal. The stop has ALREADY filed the draft entry when this appears — it
// offers 2–3 one-tap narratives for this matter (suggested-on-start first,
// then the phrasebook); dismissing or ignoring it costs nothing, the draft
// waits for Phase 4's close-out. Keys: 1–3 pick · e edit · Esc dismiss.

const AUTO_DISMISS_MS = 15_000;

export function StopChips({ popup, openEditor, onFiled, onClose, onClockDeduct }) {
  const { result } = popup;
  const entry = result.entry;
  const timer = result.timer || popup.timer; // stop payload carries the fresh row
  const [chips, setChips] = useState(null); // null = loading
  const dismissRef = useRef(null);

  // never clobber: chips only when the narrative is blank and not auto-generated
  const offerChips = !entry.narrative_auto && String(entry.narrative || '').trim() === '';

  useEffect(() => {
    if (!offerChips) { setChips([]); return undefined; }
    let alive = true;
    api.get(`/api/matters/${timer.cm_id}/suggestions`)
      .then((r) => { if (alive) setChips(dedupe([timer.suggested_narrative, ...r.phrases.map((p) => p.text)])); })
      .catch(() => { if (alive) setChips(dedupe([timer.suggested_narrative])); });
    return () => { alive = false; };
  }, []); // eslint-disable-line

  // auto-dismiss (hover pauses) — non-blocking must also mean non-nagging
  const startDismiss = () => {
    clearTimeout(dismissRef.current);
    dismissRef.current = setTimeout(() => onClose(false), AUTO_DISMISS_MS);
  };
  const pauseDismiss = () => clearTimeout(dismissRef.current);
  useEffect(() => { startDismiss(); return () => clearTimeout(dismissRef.current); }, []); // eslint-disable-line

  async function pick(text) {
    try {
      await api.patch(`/api/entries/${entry.id}`, { narrative: text });
      emitToast('Narrative filed ✓');
      onFiled();
    } catch (e) {
      emitToast(e.message, { error: true });
    }
  }

  function edit() { onClose(false); openEditor({ id: entry.id }); }

  useEffect(() => {
    const onKey = (e) => {
      const tag = (e.target.tagName || '').toLowerCase();
      if (['input', 'textarea', 'select'].includes(tag) || e.target.isContentEditable) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'Escape') { e.stopPropagation(); onClose(false); }
      else if (e.key === 'e') { e.preventDefault(); e.stopPropagation(); edit(); }
      else if (['1', '2', '3'].includes(e.key) && chips && chips[Number(e.key) - 1]) {
        e.preventDefault();
        e.stopPropagation();
        pick(chips[Number(e.key) - 1]);
      }
    };
    // Capture phase: the stopped card usually keeps DOM focus, so these keys
    // would otherwise route through the timer board's React handlers first.
    // The board no longer eats printable keys (filtering moved to the `/`
    // search bar), but capture is still the right choice — it guarantees the
    // chips keys (1/2/3/e/Esc) win over any focused-card handling, now and if
    // the board grows new key bindings. The input/textarea guard above keeps
    // normal typing (e.g. the editor) unaffected.
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [chips]); // eslint-disable-line

  return createPortal(html`
    <div class="stop-chips" onMouseEnter=${pauseDismiss} onMouseLeave=${startDismiss}>
      <div class="stop-chips-head">
        <${Icon} name="check" size=${14} />
        <strong>${fmtHours(result.hours)}h filed</strong>
        <span class="muted">— ${entry.cm.short_name}</span>
        <span class="spacer" style=${{ flex: 1 }}></span>
        <button class="btn btn-ghost btn-sm" title="Dismiss (Esc) — the draft is saved either way"
          onClick=${() => onClose(false)}><${Icon} name="x" size=${14} /></button>
      </div>
      ${result.relinked ? html`
        <div class="stop-chips-warn">
          The entry this timer was filling got finalized, so the full day clock
          (${fmtHours(result.hours)}h) went to a <strong>new</strong> entry.
          ${result.previousTotal ? html`
            <button class="btn btn-sm" onClick=${() => { onClockDeduct(result.previousTotal); onClose(true); }}>
              Deduct ${fmtHours(result.previousTotal)}h from the clock
            </button>` : null}
        </div>` : null}
      ${offerChips ? (chips === null ? null : chips.length > 0 ? html`
        <div class="stop-chips-list">
          ${chips.map((text, i) => html`
            <button key=${text} class="chip-btn" title=${text} onClick=${() => pick(text)}>
              <kbd>${i + 1}</kbd> <span>${text}</span>
            </button>`)}
        </div>` : html`
        <div class="muted small" style=${{ padding: '2px 0 6px' }}>
          No narrative yet — it’ll wait as a draft.
        </div>`) : null}
      <div class="stop-chips-foot">
        <button class="btn btn-sm" onClick=${edit}><${Icon} name="edit" size=${14} /> Edit entry <kbd>e</kbd></button>
      </div>
    </div>`, document.body);
}

function dedupe(list) {
  const seen = new Set();
  const out = [];
  for (const t of list) {
    const text = String(t || '').trim();
    if (!text) continue;
    const k = text.toLowerCase();
    if (!seen.has(k)) { seen.add(k); out.push(text); }
    if (out.length === 3) break;
  }
  return out;
}
