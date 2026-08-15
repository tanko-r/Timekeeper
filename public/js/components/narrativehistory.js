import { api } from '/js/api.js';
import {
  html, useState, useEffect, Modal, Spinner, Icon, fmtHours, fmtDateLong, emitToast,
} from '/js/ui.js';
import { joinNarratives } from '/js/lib/narrativejoin.js';

// "What did I write last time?" (2026-08-14 feedback: a button to pop up the
// last 10 or 20 entries with narratives for this matter, and import the
// narrative from one or more of them).
//
// Picking several is the point, not a nicety — an afternoon is often last
// week's call plus yesterday's review — so rows are checkboxes and the chosen
// ones join into one clause list, in the order they were picked, exactly as a
// multi-line entry's narrative reads.
//
// WAVE-1: this dialog now has a second caller. When none of the stop chips'
// 2–3 one-tap suggestions fit, "More from this matter" opens the whole
// phrasebook here rather than sending the lawyer through the entry editor to
// find it — so the deep path costs one tap from the row, at any width, and
// the same list serves the editor's `Reuse` button unchanged.
//
// `insertLabel` names the commit for that caller ("Use it" reads better than
// "Insert" when the text goes straight onto the entry), and `announce=false`
// lets it stay quiet because the stop chips raise their own toast — the one
// carrying **Undo**, since applying a narrative over an entry overwrites.
export function NarrativeHistory({
  cmId, cmLabel, onInsert, onClose, insertLabel = 'Insert', announce = true,
}) {
  const [rows, setRows] = useState(null);
  const [picked, setPicked] = useState([]); // entry ids, in pick order
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    api.get(`/api/matters/${cmId}/recent-narratives?limit=20`)
      .then((r) => { if (alive) setRows(r.entries); })
      .catch((e) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [cmId]);

  const toggle = (id) => setPicked((cur) => (
    cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  const chosen = picked
    .map((id) => (rows || []).find((r) => r.id === id))
    .filter(Boolean);
  const preview = joinNarratives(chosen.map((r) => r.narrative));

  function insert() {
    if (!preview) return;
    onInsert(preview);
    if (announce) {
      emitToast(`Narrative from ${chosen.length} ${chosen.length === 1 ? 'entry' : 'entries'} inserted`);
    }
    onClose();
  }

  return html`
    <${Modal} title=${`Reuse a narrative — ${cmLabel}`} onClose=${onClose} wide=${true}>
      ${error ? html`<div class="error-box">${error}</div>` : null}
      ${rows === null && !error ? html`<${Spinner} />` : null}
      ${rows && rows.length === 0 ? html`
        <div class="card muted">No narratives on this matter yet — this list fills up as you write entries.</div>` : null}
      ${rows && rows.length > 0 ? html`
        <div class="narrative-history">
          ${rows.map((r) => {
            const n = picked.indexOf(r.id);
            return html`
              <label key=${r.id} class=${'narrative-history-row' + (n >= 0 ? ' picked' : '')}>
                <input type="checkbox" checked=${n >= 0} onChange=${() => toggle(r.id)} />
                <div class="narrative-history-body">
                  <div class="narrative-history-meta">
                    <span class="mono">${fmtDateLong(r.date)}</span>
                    <span class="mono">${fmtHours(r.total)}h</span>
                    ${r.status === 'finalized'
                      ? html`<span class="chip chip-finalized"><${Icon} name="lock" size=${12} /> finalized</span>`
                      : html`<span class="chip chip-draft">draft</span>`}
                    ${r.uses > 1 ? html`
                      <span class="chip" title=${`Used on ${r.uses} entries — most recently this one`}>×${r.uses}</span>` : null}
                    ${n >= 0 ? html`<span class="chip chip-running">#${n + 1}</span>` : null}
                  </div>
                  <p class="narrative">${r.narrative}</p>
                </div>
              </label>`;
          })}
        </div>` : null}
      ${preview ? html`
        <div class="narrative-history-preview">
          <span class="muted small">Inserts:</span>
          <p class="narrative">${preview}</p>
        </div>` : null}
      <div class="row-end">
        <button type="button" class="btn" onClick=${onClose}>Cancel</button>
        <button type="button" class="btn btn-primary" disabled=${!preview} onClick=${insert}>
          <${Icon} name="check" size=${16} /> ${insertLabel}${chosen.length > 1 ? ` ${chosen.length}` : ''}
        </button>
      </div>
    <//>`;
}
