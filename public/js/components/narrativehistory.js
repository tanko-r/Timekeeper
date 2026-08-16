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
// MATTER FENCE (docs/ui/BRIEF.md, "Data integrity"). Everything in this dialog
// is a whole client-facing sentence, so every one of them is matter-bound. Two
// things follow, and both are here rather than at the call sites, because a
// third call site would otherwise have to remember them:
//
//   1. THE LIST IS EMPTIED THE INSTANT THE MATTER CHANGES. `cmId` is a prop; a
//      caller can change it under a mounted instance (the editor's matter
//      picker does exactly that). Without this the previous matter's sentences
//      stayed on screen — ticked, previewed and one "Use it" from an entry —
//      under the NEW matter's title, for the length of one fetch.
//   2. A FEED IS ONLY EVER RENDERED FOR THE MATTER IT WAS ASKED FOR. The
//      response carries `matter_id`; a late answer for a matter we are no
//      longer showing is dropped rather than displayed.
//
// …and `onInsert` hands the caller the matter the text came from, so the write
// itself can be stamped with it (`source_cm_id`) and refused by the server if
// the entry has moved meanwhile.
export function NarrativeHistory({
  cmId, cmLabel, onInsert, onClose, insertLabel = 'Insert', announce = true,
}) {
  const [rows, setRows] = useState(null);
  const [picked, setPicked] = useState([]); // entry ids, in pick order
  const [error, setError] = useState(null);
  // The matter the rows on screen actually belong to. Never read from the prop:
  // the prop is what we ASKED for, and the gap between the two is the leak.
  const [rowsCm, setRowsCm] = useState(null);

  useEffect(() => {
    let alive = true;
    // Nothing from the old matter survives the switch — not the rows, not the
    // ticks, not the preview the primary would write.
    setRows(null);
    setRowsCm(null);
    setPicked([]);
    setError(null);
    api.get(`/api/matters/${cmId}/recent-narratives?limit=20`)
      .then((r) => {
        if (!alive) return;
        // eslint-disable-next-line eqeqeq
        if (r.matter_id != null && r.matter_id != cmId) return; // another matter's feed
        setRows(r.entries);
        setRowsCm(r.matter_id != null ? r.matter_id : cmId);
      })
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
    // The second argument is the matter these sentences were read from, not the
    // matter currently asked for. They are the same in every shipped flow; if
    // they ever were not, the caller stamps the write with the wrong one and
    // the server would be the last thing standing between one client's sentence
    // and another client's bill.
    onInsert(preview, rowsCm);
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
