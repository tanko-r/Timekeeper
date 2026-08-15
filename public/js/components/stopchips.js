import { api } from '/js/api.js';
import {
  html, useState, useEffect, useRef, useCallback, createPortal, fmtHours, emitToast, Icon,
} from '/js/ui.js';
import { useDismissLayer, overlayOpen } from '/js/components/overlay.js';
import { NarrativeHistory } from '/js/components/narrativehistory.js';
import { GhostInput } from '/js/components/ghosttext.js';
import { useShortcuts } from '/js/components/shortcuts.js';
import { expandShortcuts } from '/js/lib/expand.js';
import { containsTimeAmounts } from '/js/lib/timeamounts.js';
import { formatSuggestion } from '/js/lib/narrativesync.js';

// ---------------------------------------------------------------------------
// THE STOP CHIP FINISHES THE ENTRY  (teardown §17, E2, D4)
//
// The instant a timer stops, this offers 2–3 one-tap narratives drawn from
// that matter's own phrasebook (plus the model's suggested-on-start line), so
// the entry finishes itself. The teardown called it "the second-best idea in
// the product and one line away from being the best", and named three faults:
//
//   1. `pick()` PATCHed the narrative and then called `openEditor(...)`, so a
//      one-tap action became tap → a 25-control modal → Save & close. Three
//      interactions and a full context switch to confirm text you just chose.
//      NOW: the pick IS the commit. The row updates in place, no dialog opens,
//      and a toast carries **Undo** — the pattern the app already uses for
//      every other overwrite (entrylist.js).
//   2. A 15-second auto-dismiss threw the offer away while the lawyer took the
//      call he stopped the timer for. NOW: an offer with something to pick
//      never times out. Only a BARE stop — nothing to pick, nothing to warn
//      about — retires itself, after 30s, paused while the pointer or the
//      keyboard is inside it (component notes §6: Radix pauses on hover AND
//      focus, not hover alone).
//   3. It was a fixed slab at `top: 22%`, unanchored to the timer that had
//      stopped. NOW it renders INSIDE that timer's own row in the merged
//      Today list, as a state of the row rather than a layer over the page.
//      The floating panel survives only as the fallback for when the row is
//      not on screen (filtered out, or a stop fired from another surface) —
//      the offer must never be unreachable.
//
// …and the fourth, from the wave-1 review (D10): "The stop-chip empty state
// contradicts itself. With no history the surface reads 'Nothing on file for
// this matter yet — write the narrative on the row' while occupying the row
// and offering no field; you must Dismiss it first to reach 'Write narrative'.
// My E2 asked for a focused narrative field beneath the chips; there is none."
// So there is one now: whenever this entry still needs words, the field is
// part of the offer — under the chips when there are chips, and instead of the
// (removed) instruction when there are none. It carries the same ghost-text
// completion and shortcut expansion as every other narrative field in the app,
// and Save commits through exactly the path a chip does, Undo included.
//
// Every path is a real control: chips are buttons (44px on touch, per
// base.css's touch tier), Dismiss is a labelled button and not just an Esc
// hint, and "More from this matter" opens the full phrasebook. The 1/2/3 · e
// keys are a desktop layer on top, and the number caps are not drawn at phone
// width at all (component notes §7: omission, not translation).
//
// INTEGRATION SURFACE with the Today list, deliberately one selector wide:
// `.today-list .work-row[data-timer-id=…]` (or `[data-entry-id=…]`), which is
// how the row already addresses itself for focus, reveal and scroll-into-view.
// Nothing else about that component is assumed, and if the row is not found
// the floating fallback renders instead. That component is still being built
// in this wave — see the report.
// ---------------------------------------------------------------------------

// Only a stop with NOTHING to offer retires itself. Doubled from the old
// blanket 15s, and paused whenever the reader is in it.
const BARE_DISMISS_MS = 30_000;
// How long the bare number keys stay live while focus is on nothing at all —
// i.e. straight after a stop fired from a button click or a global shortcut.
// Once focus lands anywhere else they stop being magic, so `g e`, `1`, `2`
// and `3` mean what they always mean everywhere else in the app.
const HOT_KEYS_MS = 90_000;

// The inline slot is a flex child of `.work-row`, on its own line under the
// narrative (`.work-body` is order 2). `all: unset` first, so the slab styling
// on `.stop-chips` — position, inset, width, border, shadow, padding — cannot
// reach it whatever that rule grows into; the class is kept because the chips
// ARE the stop chips, at both placements, for CSS and for the smoke test.
const SLOT_CSS = 'all:unset;display:block;order:3;flex:1 1 100%;min-width:0';

export function StopChips({ popup, openEditor, onFiled, onClose, onClockDeduct }) {
  const { result } = popup;
  const entry = result.entry;
  const timer = result.timer || popup.timer; // stop payload carries the fresh row
  const [chips, setChips] = useState(null);  // null = loading
  const [busy, setBusy] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [typed, setTyped] = useState('');    // the field under the chips
  const [writing, setWriting] = useState(false);
  const wide = useWideViewport();
  const shortcuts = useShortcuts();
  const expand = useCallback((t, caret) => expandShortcuts(t, caret, shortcuts), [shortcuts]);

  const doneRef = useRef(false);   // one commit per stop, whatever fires first
  const rootRef = useRef(null);    // the element the dismissal stack ranks
  const hotUntil = useRef(Date.now() + HOT_KEYS_MS);
  const dismissRef = useRef(null);

  // never clobber: chips only when the narrative is blank and not auto-generated
  const offerChips = !entry.narrative_auto && String(entry.narrative || '').trim() === '';
  const cmId = timer.cm_id || entry.cm?.id || null;
  const cmLabel = entry.cm ? entry.cm.short_name : (timer.cm_short_name || null);

  // The narrative as the SERVER has it right now. It seeds from the stop
  // payload and re-reads on every entry write, which is what makes Undo honest
  // once the offer can stand for ten minutes: if the lawyer wrote the
  // narrative himself in the meantime, this is what a pick would overwrite and
  // what Undo puts back. Costs one GET per entry write, only while the offer
  // is up, and never a round trip on the fast path itself.
  const liveRef = useRef({
    narrative: entry.narrative || '',
    narrative_ai: entry.narrative_ai ? 1 : 0,
  });

  const finish = (changed) => {
    if (doneRef.current) return;
    doneRef.current = true;
    onClose(changed);
  };

  useEffect(() => {
    // matterless stop: no phrasebook to draw from — the entry still filed
    if (!offerChips || !cmId) { setChips([]); return undefined; }
    let alive = true;
    // The suggested-on-start line may have been refined by the local model
    // (timers.js: refineSuggestedNarrative); the phrasebook chips are the
    // attorney's own past phrases. Picking one has to record which, so AI text
    // never enters the pool the model learns its voice from (spec §5) — and
    // the chip says so, with its leading glyph.
    const build = (phrases) => dedupe(clean([timer.suggested_narrative, ...phrases])
      .map(formatSuggestion))
      .map((text) => ({ text, ai: text === formatSuggestion(timer.suggested_narrative || '') }));
    api.get(`/api/matters/${cmId}/suggestions`)
      .then((r) => { if (alive) setChips(build(r.phrases.map((p) => p.text))); })
      .catch(() => { if (alive) setChips(build([])); });
    return () => { alive = false; };
  }, []); // eslint-disable-line

  // The offer is spent the moment the entry gets a narrative some other way —
  // the row's own "Write narrative" field, the editor, the close-out sweep.
  // `tk:entries-changed` is fired by api.js on every entry write.
  useEffect(() => {
    let alive = true;
    const refresh = () => {
      if (doneRef.current) return;
      api.get(`/api/entries/${entry.id}`).then((e) => {
        if (!alive || doneRef.current) return;
        liveRef.current = {
          narrative: e.narrative || '', narrative_ai: e.narrative_ai ? 1 : 0,
        };
        if (String(e.narrative || '').trim() || e.status !== 'draft') finish(false);
      }).catch(() => { /* offline or deleted — leave the offer standing */ });
    };
    window.addEventListener('tk:entries-changed', refresh);
    return () => { alive = false; window.removeEventListener('tk:entries-changed', refresh); };
  }, [entry.id]); // eslint-disable-line

  // ---- placement: the stopped row, or the floating fallback ----
  const slot = useRowSlot(timer ? timer.id : null, entry.id);
  const inline = !!slot;
  // The dismissal stack ranks layers by their root element; inline that root
  // is the slot itself, floating it is the panel's own ref callback below.
  useEffect(() => { if (slot) rootRef.current = slot; }, [slot]);

  // Escape goes through the app's ONE dismissal stack, not a private capture
  // listener: a dialog opened over the chips (the phrasebook) then answers
  // Escape first and leaves the offer standing, which is exactly what the
  // stack is for.
  useDismissLayer(true, () => finish(false), rootRef);

  // ---- the field: always on a matter with no phrasebook, on request otherwise ----
  const noHistory = offerChips && chips !== null && chips.length === 0;
  const showField = offerChips && chips !== null && (writing || noHistory);
  // Focus follows the ASK. A field the lawyer opened himself takes the caret;
  // one that merely appeared with the offer does not, because stealing focus
  // into a textarea after a stop would eat the next `t`, `c` or `q` he types
  // and, on a phone, throw the soft keyboard over the row he just filed.
  useEffect(() => {
    if (!writing) return;
    const root = rootRef.current;
    const el = root && root.querySelector('.stop-chips-write textarea');
    if (el) el.focus();
  }, [writing]);

  // ---- the bare stop: nothing to pick, nothing to WRITE, nothing to warn ----
  //
  // An entry that still needs a narrative always has something to do here now
  // — the field is part of the offer — so only a pure confirmation retires
  // itself: a stop on an entry that already says what the work was (chipped
  // earlier, typed on the row, AUTO from task lines).
  const bare = !offerChips && !result.relinked;
  const clearDismiss = () => { clearTimeout(dismissRef.current); dismissRef.current = null; };
  const armDismiss = () => {
    clearDismiss();
    if (!bare) return;
    dismissRef.current = setTimeout(() => finish(false), BARE_DISMISS_MS);
  };
  useEffect(() => { armDismiss(); return clearDismiss; }, [bare]); // eslint-disable-line

  async function pick(chip) {
    if (busy || doneRef.current) return;
    const before = liveRef.current;
    setBusy(true);
    try {
      await api.patch(`/api/entries/${entry.id}`, {
        narrative: chip.text, narrative_ai: chip.ai ? 1 : 0,
      });
      doneRef.current = true;
      // The row is the confirmation — it redraws with the narrative on it and
      // its "needs a narrative" rail cleared. The toast only carries the way
      // back, because a pick overwrites.
      emitToast('Narrative saved', {
        actionLabel: 'Undo',
        action: () => api.patch(`/api/entries/${entry.id}`, {
          narrative: before.narrative, narrative_ai: before.narrative_ai,
        }).then(() => { emitToast('Narrative put back'); onFiled(); })
          .catch((err) => emitToast(err.message, { error: true })),
      });
      onFiled();
    } catch (e) {
      setBusy(false);
      emitToast(e.message, { error: true });
    }
  }

  function edit() { finish(false); openEditor({ id: entry.id }); }

  // 1/2/3 pick · e edit. Scoped, because the offer no longer expires: keys
  // this cheap may not stay captured forever, or `g e` (go to Entries) and
  // every future digit binding would be dead for as long as a draft sits
  // unnarrated. They are live while the reader is in the offer or on its row,
  // and — for the moment right after a stop, when focus is on nothing at all —
  // for HOT_KEYS_MS.
  useEffect(() => {
    const live = () => {
      if (overlayOpen()) return false;
      const root = rootRef.current;
      const a = document.activeElement;
      if (root && a && root.contains(a)) return true;
      const row = root && root.closest ? root.closest('.work-row') : null;
      if (row && a && row.contains(a)) return true;
      if (!a || a === document.body || a === document.documentElement) {
        return Date.now() < hotUntil.current;
      }
      return false;
    };
    // `g` opens the app's navigation chord (`g` then d/c/s/e), and its `e`
    // branch is the Entries ledger. A capture-phase listener that swallowed a
    // bare `e` would break that key for as long as an unnarrated draft sat on
    // the board — which, now that the offer never expires, could be all day.
    // So a `g` seen in the last 900ms (app.js's own chord window) hands the
    // next `e` back to the chord.
    let lastG = 0;
    const onKey = (e) => {
      const tag = (e.target.tagName || '').toLowerCase();
      if (['input', 'textarea', 'select'].includes(tag) || e.target.isContentEditable) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'g') { lastG = Date.now(); return; }
      if (!live()) return;
      if (e.key === 'e') {
        if (Date.now() - lastG < 900) return; // the chord owns it
        e.preventDefault(); e.stopPropagation(); edit();
      } else if (['1', '2', '3'].includes(e.key) && chips && chips[Number(e.key) - 1]) {
        e.preventDefault();
        e.stopPropagation();
        pick(chips[Number(e.key) - 1]);
      }
    };
    // Capture phase: the stopped row usually keeps DOM focus, so these keys
    // would otherwise route through the Today list's own handlers first.
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [chips, busy]); // eslint-disable-line

  const hoursFiled = fmtHours(result.hours);
  const body = html`
    <div class="stop-chips-inner"
      onMouseEnter=${clearDismiss} onMouseLeave=${armDismiss}
      onFocus=${clearDismiss} onBlur=${armDismiss}>

      <div class="stop-chips-head" style=${{ flexWrap: 'wrap' }}>
        <${Icon} name="check" size=${14} />
        <strong>${hoursFiled}h filed</strong>
        <span class="muted" style=${TRUNCATE}>— ${cmLabel || 'no matter yet'}</span>
      </div>

      ${result.relinked ? html`
        <div class="stop-chips-warn">
          The entry this timer was filling got finalized, so the full day clock
          (${hoursFiled}h) went to a <strong>new</strong> entry.
          ${result.previousTotal ? html`
            <button type="button" class="btn btn-sm"
              onClick=${() => { onClockDeduct(result.previousTotal); finish(true); }}>
              Deduct ${fmtHours(result.previousTotal)}h from the clock
            </button>` : null}
        </div>` : null}

      ${offerChips && chips === null ? html`
        <p class="muted small stop-chips-note">Looking for what you wrote last time…</p>` : null}

      ${offerChips && chips && chips.length > 0 ? html`
        <div class="stop-chips-list">
          ${/* A chip carries a leading visual, the way every filter/assist chip
                in a mature system does — without one a full-width bordered box
                of prose reads as a field, not an action, and at phone width
                the number cap that used to be the only leading mark is not
                drawn at all. It doubles as provenance: ⟲ is something the
                attorney wrote on this matter before, ✦ is the model's
                suggested-on-start line. He should be able to tell which he is
                accepting — the app already tracks it (narrative_ai) so that AI
                text never re-enters the pool the model learns his voice from,
                and that distinction is worth showing rather than hiding. */''}
          ${chips.map((chip, i) => html`
            <button type="button" key=${chip.text} class="chip-btn" disabled=${busy}
              style=${{ alignItems: 'center' }}
              title=${chip.ai
                ? `Suggested when this timer started — finish the entry with: ${chip.text}`
                : `You wrote this on this matter before — finish the entry with: ${chip.text}`}
              onClick=${() => pick(chip)}>
              ${wide ? html`<kbd>${i + 1}</kbd>` : null}
              <${Icon} name=${chip.ai ? 'sparkles' : 'history'} size=${14} />
              <span>${chip.text}</span>
            </button>`)}
        </div>` : null}

      ${/* THE FIELD. Not a fallback and not a second thought: it is where a
            narrative nobody has written before comes from, and on a matter
            with no phrasebook it is the ONLY thing this offer can usefully be
            — so there it stands in place of the instruction that used to point
            at a control this surface was covering.

            With chips on offer it starts as one line ("Write your own"), which
            costs the same single tap the field would have cost to focus and
            keeps the offer the size of the decision it is asking for. Either
            way Save commits down exactly the path a chip does — same PATCH,
            same toast, same Undo — and leaving it alone still leaves a clean
            draft for close-out. */''}
      ${showField ? html`
        <div class="stop-chips-write" style=${WRITE}>
          ${noHistory ? html`
            <p class="muted small stop-chips-note" style=${{ margin: 0 }}>
              Nothing on file for this matter yet — say what you did:
            </p>` : null}
          <${GhostInput} multiline rows=${2} value=${typed}
            suggestions=${chips.map((c) => c.text)} expand=${expand}
            aria-label="Narrative for this entry"
            placeholder="What did you do?"
            style=${WRITE_FIELD}
            onChange=${setTyped} />
          <div class="stop-chips-write-act" style=${WRITE_ACT}>
            <button type="button" class="btn btn-sm btn-primary"
              disabled=${busy || !typed.trim()}
              onClick=${() => pick({ text: typed.trim(), ai: false })}>
              <${Icon} name="check" size=${14} /> Save
            </button>
          </div>
        </div>` : null}

      ${offerChips && chips && chips.length > 0 && !writing ? html`
        <div style=${WRITE}>
          <button type="button" class="btn btn-sm" onClick=${() => setWriting(true)}>
            <${Icon} name="edit" size=${14} /> Write your own
          </button>
        </div>` : null}

      <div class="stop-chips-foot" style=${FOOT}>
        <button type="button" class="btn btn-sm"
          title="Dismiss — the draft is saved either way"
          onClick=${() => finish(false)}>
          <${Icon} name="x" size=${14} /> Dismiss
        </button>
        ${cmId ? html`
          <button type="button" class="btn btn-sm" onClick=${() => setHistoryOpen(true)}>
            <${Icon} name="history" size=${14} /> More from this matter
          </button>` : null}
        <button type="button" class="btn btn-sm" onClick=${edit}>
          <${Icon} name="edit" size=${14} /> Edit entry ${wide ? html`<kbd>e</kbd>` : null}
        </button>
      </div>

      ${historyOpen && cmId ? html`
        <${NarrativeHistory} cmId=${cmId} cmLabel=${cmLabel || 'this matter'}
          insertLabel="Use it" announce=${false}
          onInsert=${(text) => pick({ text, ai: false })}
          onClose=${() => setHistoryOpen(false)} />` : null}
    </div>`;

  if (inline) return createPortal(body, slot);
  // Fallback: the row is not on screen, so the offer floats — but it is still
  // the same markup, the same keys and the same one-tap commit.
  return createPortal(html`
    <div class="stop-chips" ref=${(el) => { rootRef.current = el; }}
      role="group" aria-label="Finish this entry" aria-live="polite">${body}</div>`, document.body);
}

const TRUNCATE = { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
const FOOT = { flexWrap: 'wrap', gap: 'var(--space-2)', justifyContent: 'flex-start' };
// Written here rather than in overlays.css for the same reason SLOT_CSS is:
// this wave hands the close-out rules of that file to this agent and the rest
// of it to another, so the offer's own layout travels with the component.
// Every value is a token — nothing raw enters the DOM.
const WRITE = { display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', margin: 'var(--space-1) 0 var(--space-2)' };
const WRITE_FIELD = {
  // two lines of body text plus the shared field padding — a narrative is a
  // sentence, and this sits inside a list row
  minHeight: 'calc(2 * var(--lh-body) + 2 * var(--pad-control-y) + 2 * var(--border-w))',
};
const WRITE_ACT = { display: 'flex', justifyContent: 'flex-end' };

// ---------------------------------------------------------------------------
// The row slot.
//
// Returns a plain element appended to the stopped timer's row in the Today
// list, or null when that row is not on screen. It re-resolves on a slow
// interval rather than once, because the stop is followed by a reload and an
// entries refetch: the row may be re-keyed, re-sorted or briefly absent in the
// frames right after a stop, and an offer that mounted into a stale node would
// be an offer nobody can see. Cheap, self-healing, and it touches exactly one
// attribute of a component another agent owns.
// ---------------------------------------------------------------------------
function useRowSlot(timerId, entryId) {
  const [slot, setSlot] = useState(null);
  useEffect(() => {
    let el = null;
    let row = null;
    const find = () => (
      (timerId != null
        && document.querySelector(`.today-list .work-row[data-timer-id="${timerId}"]`))
      || (entryId != null
        && document.querySelector(`.today-list .work-row[data-entry-id="${entryId}"]`))
      || null);
    const sync = () => {
      const found = find();
      if (found === row && el && el.isConnected && el.parentElement === row) return;
      if (el) el.remove();
      row = found;
      if (!row) { el = null; setSlot(null); return; }
      el = document.createElement('div');
      el.className = 'stop-chips stop-chips-inline';
      el.style.cssText = SLOT_CSS;
      el.setAttribute('role', 'group');
      el.setAttribute('aria-label', 'Finish this entry');
      // The offer arrives without the reader having asked for it, so it is
      // announced the way a non-modal offer should be: politely, at the next
      // natural pause, never interrupting.
      el.setAttribute('aria-live', 'polite');
      row.appendChild(el);
      setSlot(el);
      // The list re-sorts on stop (a running row outranks a stopped one), so
      // the offer can land off-screen. `nearest` is a no-op when it did not.
      try { row.scrollIntoView({ block: 'nearest' }); } catch { /* not supported */ }
    };
    sync();
    const iv = setInterval(sync, 400);
    return () => { clearInterval(iv); if (el) el.remove(); };
  }, [timerId, entryId]);
  return slot;
}

// Key caps are a desktop layer. Gated on the app's own phone breakpoint rather
// than on `hover`/`pointer`, which headless Chromium reports as coarse at
// every width — a media query nothing in this overhaul could photograph.
function useWideViewport() {
  const [wide, setWide] = useState(() => (
    typeof window.matchMedia === 'function' ? window.matchMedia('(min-width: 768px)').matches : true));
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const mq = window.matchMedia('(min-width: 768px)');
    const on = () => setWide(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return wide;
}

// Suggested narratives must never invent time amounts (spec: the app records
// duration separately) — a stored free-text narrative can carry baked-in
// amounts like "(0.5)" and still rank as a phrasebook hit, so drop those
// before they ever become a one-tap chip.
function clean(list) {
  return list.filter((t) => !containsTimeAmounts(t));
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
