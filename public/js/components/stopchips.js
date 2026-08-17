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
// THE MATTER IS THE AXIS  (wave-2c — the data-integrity fence; read first)
//
// docs/ui/BRIEF.md, "Data integrity", outranks everything else in this file:
// a NARRATIVE — the client-facing sentence that lands on a bill — may never be
// shown as belonging to, suggested for, pre-filled into or written onto an
// entry for a different matter. Not across clients, and not between two
// matters of the SAME client. Reusable WORDING (the phrasebook as a concept,
// ghost text, text expansions, task-line fragments) is shared by design and
// stays shared. Three things in here crossed that line, and all three are
// fenced below — each one is marked "MATTER FENCE" where it lives:
//
//   1. THE OFFER OUTLIVED ITS MATTER. Everything here was keyed to the ENTRY,
//      and an entry's matter can change while the offer is still mounted (row
//      menu → Open entry… → change the matter → Done). Nothing re-derived: the
//      heading still named the old matter, the caption still said "already
//      saved", and the old matter's second sentence was still on offer under
//      key cap 1. The matter is captured at mount now and re-read on every
//      entry write; if it no longer matches, the offer dismisses itself.
//   2. A BORROWED SENTENCE WAS A CHIP, AND CLAIMED PROVENANCE. On a thin
//      matter the suggestions endpoint blends in the client's OTHER matters
//      (`source: 'client'`); those arrived here as chips wearing the ⟲ history
//      icon and the title "You wrote this on this matter before", which was
//      false. They are dropped from the chip list entirely now.
//   3. NO WRITE NAMED ITS MATTER. Every PATCH from this surface now carries
//      `source_cm_id` — the matter the suggestion was built for — and the
//      server refuses (409) if the entry has moved since. A conflict says so
//      and writes nothing.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// WHAT THE STOP OFFER IS FOR  (wave-2b — read this before the history below)
//
// Measured on a five-entry day at 390×844, after wave 2a:
//
//   leave every stop alone, let close-out pre-fill    12 interactions
//   tap a chip on every stop                          17 interactions
//
// The chip cost five taps and bought nothing, because close-out pre-fills from
// the SAME phrasebook the chip draws from: an entry left alone at stop time
// arrives at close-out with the identical sentence already in its box, and the
// primary writes it. So the app's headline one-tap feature was buying a choice
// between two or three phrasings, at one tap per entry, and the fast path made
// the day LONGER — the wave-1 review's finding, still true after the sweep was
// fixed.
//
// A tap at stop time can only pay for itself if it removes a tap later, and
// close-out already costs only two (`c`, then the primary) however many drafts
// there are. There is nothing left for it to remove. So a per-entry tap here
// cannot be the default, and the offer had to become one of two things:
//
//   (a) show chips only where the phrasebook offers more than one plausible
//       option, so the chip appears when it is genuinely a choice; or
//   (b) reduce it to a single "looks right?" confirmation on the row and let
//       the pre-fill carry the rest.
//
// BUILT: (b), with (a) folded into it, because (a) alone still charges a tap
// whenever it appears and so still lands the day at 13–17.
//
//   THE PRE-FILL HAPPENS HERE, NOT AT CLOSE-OUT. The instant the offer knows
//   the matter's own top phrase, it WRITES it — one PATCH, no tap — and the
//   offer becomes a confirmation of something already saved. The entry is
//   finished at stop time, which is what the teardown asked for ("the entry
//   finishes itself"), and it stays finished whether or not the day is ever
//   closed.
//   CONFIRMING COSTS NOTHING. The row shows the sentence, the offer says where
//   it came from, and it retires itself after 30s like any other confirmation.
//   Doing nothing is the happy path: 0 taps.
//   ALTERNATIVES ONLY WHEN THERE IS A CHOICE. The other phrases are rendered
//   under the confirmation, one tap each, and only when the phrasebook has
//   more than one — that is (a), in the one place where a tap is buying
//   something a lawyer could not get for free.
//   ONLY HIS OWN WORDING IS WRITTEN UNASKED. A phrase auto-applies only when
//   it is the attorney's own, on THIS matter (`source: 'matter'`). A model's
//   suggested-on-start line, or wording borrowed from a sibling matter, stays
//   a chip — the app fills in what he has written before and ASKS before using
//   anything else.
//   AND IT IS REVERSIBLE THREE WAYS: Undo in the toast the write raises, the
//   alternatives right there, and the row's own narrative field.
//
// THE DAY COUNT, HONESTLY (wave-2c). This block used to end "Re-measured, same
// five-entry day: chipped 12, unchipped 12", and a later comment claimed 12/13.
// Nobody has reproduced either figure. The only count that has been reproduced
// is the one at the top of this block — 12 ignored, 17 chipped — and it is
// still what a five-entry day costs if the lawyer answers every offer.
//
// So the claim is withdrawn rather than restated at a different number. What
// the design above actually rests on is a structural argument, which does not
// need a measurement to be checked: doing NOTHING at a stop costs nothing (the
// entry is already written, and a pure confirmation retires itself), so the
// offer cannot make an ignored day longer than it was. Every remaining tap is
// a lawyer choosing different words, which is work no design can delete.
// Whoever next measures a five-entry day should put the number here with the
// date and the viewport it was measured at, and nothing else should quote it.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// ONE OFFER PER STOP  (wave-2b3 — the data-correctness fix)
//
// The mount site renders a single `<StopChips popup=…>` for whichever stop is
// current, with no key. React therefore reconciled the SAME component instance
// across two different stops, and the offer kept the previous entry's state
// while re-anchoring itself into the new entry's row. Reproduced in the app's
// natural rhythm — stop A, start B, stop B:
//
//   head:   "0.7h filed — Northgate diligence"     ← the new entry
//   row:    "no narrative · Write narrative"       ← the new entry, unwritten
//   chip:   "Reviewed the landlord's termination notice and the underlying
//            lease."  chip-applied, aria-pressed="true", kbd 1
//   note:   "Written in from your own wording on this matter — already saved."
//   db:     entries.narrative = '' for that entry
//
// Two ways to lose: a lawyer reads "already saved" and leaves Northgate
// unwritten, or he taps the ticked chip and writes ACME HOLDINGS' billing
// narrative onto NORTHGATE PARTNERS' entry (verified in SQLite: entry 17 went
// from '' to Acme's sentence, toast "Narrative filled in from this matter ·
// Undo"). On desktop the stale `1` key did the same thing. It also silently
// suppressed the pre-fill for every stop after the first, because `autoRef`
// (one unasked write, ever) was still latched from the previous entry — so the
// leave-it-alone day arrived at close-out with four unwritten drafts.
//
// Picking a chip happened to escape it, because a pick unmounts the offer.
// Doing nothing — the path this component was redesigned around — did not.
//
// THE FIX IS TWO-PART, and both parts are here rather than at the mount site
// because another agent owns that file this wave:
//
//   1. `StopChips` is now a shell whose only job is to give the real offer a
//      key derived from the stop. A new stop is a new instance: suggestions,
//      pre-fill, applied state, caption, undo target and hot keys are all
//      re-derived from THAT entry, and the previous offer is unmounted (its
//      row slot removed) rather than re-dressed.
//   2. Nothing renders as "already saved" on the strength of a remembered
//      flag. `settled` is the intersection of what this offer wrote and what
//      the SERVER says the entry's narrative is right now (`saved`, re-read on
//      every entry write). If they ever disagree — a stale render, a failed
//      PATCH, an edit from the row or the float window — there is no
//      confirmation on screen and no ticked control to tap.
// ---------------------------------------------------------------------------

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

// The shell. It holds no state of its own beyond "which stop is this", and it
// exists so the offer below can never be handed a second entry mid-life. The
// counter rides along with the entry id because the same entry can be stopped
// twice in a day (one timer, two stretches): a second stop on entry 17 is
// still a new stop, with a fresh suggestion fetch and a fresh undo target.
export function StopChips(props) {
  const stamp = useRef({ popup: null, n: 0 });
  if (stamp.current.popup !== props.popup) {
    stamp.current = { popup: props.popup, n: stamp.current.n + 1 };
  }
  const entryId = props.popup?.result?.entry?.id ?? 'none';
  return html`<${StopOffer} key=${`${entryId}#${stamp.current.n}`} ...${props} />`;
}

function StopOffer({ popup, openEditor, onFiled, onClose }) {
  const { result } = popup;
  const entry = result.entry;
  const timer = result.timer || popup.timer; // stop payload carries the fresh row
  const [chips, setChips] = useState(null);  // null = loading
  const [busy, setBusy] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [typed, setTyped] = useState('');    // the field under the chips
  const [writing, setWriting] = useState(false);
  const [applied, setApplied] = useState(null); // the phrase this offer wrote by itself
  // …and what the SERVER says this entry's narrative is right now. Nothing is
  // ever shown as settled on the strength of `applied` alone: the two have to
  // agree, so a confirmation can only ever describe THIS entry's real text.
  const [saved, setSaved] = useState(() => String(entry.narrative || ''));
  const wide = useWideViewport();
  const shortcuts = useShortcuts();
  const expand = useCallback((t, caret) => expandShortcuts(t, caret, shortcuts), [shortcuts]);

  const doneRef = useRef(false);   // one commit per stop, whatever fires first
  const rootRef = useRef(null);    // the element the dismissal stack ranks
  const hotUntil = useRef(Date.now() + HOT_KEYS_MS);
  const dismissRef = useRef(null);
  const autoRef = useRef(false);   // the unasked write happens once, ever
  const ownWriteRef = useRef(null); // what THIS offer last wrote, so the
  // entries-changed watcher below can tell its own echo from the lawyer
  // writing the narrative somewhere else (which does retire the offer)

  // never clobber: chips only when the narrative is blank and not auto-generated
  const offerChips = !entry.narrative_auto && String(entry.narrative || '').trim() === '';
  const cmId = timer.cm_id || entry.cm?.id || null;
  const cmLabel = entry.cm ? entry.cm.short_name : (timer.cm_short_name || null);

  // ---- MATTER FENCE 1: THIS OFFER BELONGS TO ONE MATTER ----
  //
  // Captured at mount and never recomputed from props, because it is the thing
  // every other piece of state here is derived FROM: the suggestions were built
  // for this matter, the caption speaks for this matter, the undo target is
  // this matter's entry as the stop found it, and the hot keys index this
  // matter's alternatives. An entry can change matter while the offer stands —
  // the row menu's "Open entry…" is two taps away and correcting a mis-keyed
  // matter is an ordinary thing to do — and when it does, none of that state is
  // true any more. So the matter is re-read on every entry write (below) and a
  // mismatch takes the whole offer down rather than re-dressing it.
  const mountCm = useRef(cmId);
  const [moved, setMoved] = useState(false);

  // Every write from this surface names the matter the suggestion was built
  // for. PATCH /api/entries/:id refuses (409) when the entry has since moved,
  // so a sentence cannot land on a matter it was not written for even if this
  // component never noticed the move (another tab, the float window, a stale
  // render). Matterless stops send nothing — there is no matter to claim.
  const stamped = (body) => (
    mountCm.current == null ? body : { ...body, source_cm_id: mountCm.current });

  // COMPOSED BY THE APP, and said so. `stamped` fences the write against a
  // matter that has already moved; this records that the sentence itself is the
  // app's, so the server can retract it later if the ENTRY moves — which the
  // fence cannot catch, because the matter picker is the sanctioned way to move
  // an entry and the fence deliberately stands aside for it.
  //
  // Only for text this surface COMPOSED. The two Undo writes below restore
  // whatever the server had, which may be the attorney's own typing, and must
  // never be stamped: stamping his words would have them silently deleted the
  // next time he corrected a mis-keyed matter.
  const composed = (body) => ({ ...stamped(body), narrative_suggested: 1 });

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
    // attorney's own past phrases, and the endpoint says whether each one is
    // his on THIS matter or borrowed from a client sibling. All three
    // provenances are kept on the chip: `ai` decides what gets recorded in
    // narrative_ai (so AI text never enters the pool the model learns his
    // voice from, spec §5) and `own` decides what may be written WITHOUT
    // being asked for.
    const build = (phrases) => {
      // ---- MATTER FENCE 2: NOTHING BORROWED IS EVER A CHIP ----
      //
      // /api/matters/:id/suggestions blends this matter's own phrases with the
      // client's OTHER matters' whenever this matter's history is thin, and
      // marks the blended ones `source: 'client'`. That blend is right for
      // reusable wording — ghost text and expansions are shared by design — and
      // wrong for a chip, because a chip is a whole client-facing SENTENCE that
      // gets written to this entry, under the ⟲ icon and the title "You wrote
      // this on this matter before". He did not: he wrote it on a different
      // matter, sometimes for a different client. Marking it "not own" was not
      // enough — it was still on offer, still one tap from the database, and
      // still labelled as his own history.
      //
      // So a borrowed phrase is DROPPED here, by text, before anything else
      // runs. By text rather than by flag because the same sentence reaches
      // this pipeline twice: once from the endpoint, and once as the timer's
      // stamped `suggested_narrative`, which routes/timers.js takes from the
      // same blended list and which arrives wearing the ✦ instead. A matter
      // with no wording of its own gets the narrative FIELD instead (see
      // `noHistory`), which is what the brief asks for: generic phrasing or
      // nothing, never another matter's sentence.
      const borrowed = new Set();
      for (const p of phrases || []) {
        if (p.source !== 'client') continue;
        const text = formatSuggestion(String(p.text || '').trim());
        if (text) borrowed.add(text.toLowerCase());
      }
      const byKey = new Map();
      const order = [];
      const add = (raw, meta) => {
        // Suggested narratives must never invent time amounts (spec: the app
        // records duration separately) — a stored free-text narrative can
        // carry baked-in amounts like "(0.5)" and still rank as a phrasebook
        // hit, so those never become a chip, let alone an unasked write.
        const src = String(raw || '').trim();
        if (!src || containsTimeAmounts(src)) return;
        const text = formatSuggestion(src);
        if (!text) return;
        const k = text.toLowerCase();
        if (borrowed.has(k)) return; // fence 2 — another matter's sentence
        const had = byKey.get(k);
        if (had) {
          // PROVENANCE MERGES, IT DOES NOT COLLIDE. The line computed at timer
          // start is the phrasebook's own top hit whenever the local model is
          // off or has not answered yet (routes/timers.js), so it very often
          // IS one of these phrases. Dropping the duplicate used to drop the
          // one that knew it was his — which both mislabelled his own wording
          // as the model's in narrative_ai and, now, left nothing that may be
          // written without being asked for. Measured before this: 2 of 5
          // stops pre-filled instead of 5.
          if (meta.own) { had.own = true; had.ai = false; }
          return;
        }
        const chip = { text, ai: !!meta.ai, own: !!meta.own };
        byKey.set(k, chip);
        order.push(chip);
      };
      add(timer.suggested_narrative, { ai: true, own: false });
      // Only this matter's own wording reaches the list at all now, so every
      // phrasebook chip is `own` by construction. The flag stays because it is
      // what decides the unasked pre-fill, and a chip that lost it silently
      // would go back to being written without being asked for.
      for (const p of phrases) {
        if (p.source === 'client') continue; // fence 2
        add(p.text, { ai: false, own: true });
      }
      return order.slice(0, 3);
    };
    api.get(`/api/matters/${cmId}/suggestions`)
      .then((r) => { if (alive) setChips(build(r.phrases)); })
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
        // ---- MATTER FENCE 1, the re-read ----
        //
        // This runs on EVERY entry write, and the entry fetch already carries
        // the matter, so the axis that matters costs nothing extra to check.
        // A mismatch is not something to re-render around: the suggestions,
        // the "already saved" caption, the ticked settled sentence, the undo
        // target and the 1/2/3 keys all describe a matter this entry no longer
        // has, so the offer goes. Whatever wrote the entry is now responsible
        // for it — and if the lawyer wants a suggestion for the NEW matter, the
        // row's own narrative field and "Reuse" are both one tap away.
        const nowCm = e.cm ? e.cm.id : (e.cm_id ?? null);
        if (nowCm !== mountCm.current) { setMoved(true); finish(false); return; }
        const narrative = String(e.narrative || '');
        // Whatever else this write was, it is the truth about this entry now,
        // and the confirmation on screen is checked against it.
        setSaved(narrative);
        // Our OWN write is not somebody else finishing this entry — the offer
        // has to survive the pre-fill it just made, and Undo has to put the
        // entry back the way the stop found it, not the way this offer left
        // it. So liveRef (the undo target) only ever tracks changes that came
        // from somewhere else, and those still retire the offer.
        if (ownWriteRef.current !== null && narrative === ownWriteRef.current) return;
        liveRef.current = { narrative, narrative_ai: e.narrative_ai ? 1 : 0 };
        if (narrative.trim() || e.status !== 'draft') finish(false);
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

  // ---- THE PRE-FILL, WITHOUT A TAP ----
  //
  // The whole reason this offer is worth its pixels. His own top phrase on
  // this matter is written to the entry the moment it is known, so the entry
  // is finished at stop time and the day's interaction count does not move.
  // Nothing borrowed and nothing the model wrote goes in unasked (see the
  // header): those stay chips, because they are a choice.
  const own = chips ? chips.filter((c) => !c.ai && c.own) : [];
  useEffect(() => {
    if (!offerChips || chips === null || autoRef.current || doneRef.current) return;
    if (own.length === 0) return;
    autoRef.current = true;
    const chip = own[0];
    api.patch(`/api/entries/${entry.id}`, composed({ narrative: chip.text, narrative_ai: 0 }))
      .then(() => {
        if (doneRef.current) return;
        ownWriteRef.current = chip.text;
        setApplied(chip.text);
        setSaved(chip.text);
        // An unasked write says so, and carries its own way back. `onFiled` is
        // deliberately NOT called: it unmounts this offer, and the offer is
        // now the confirmation of what was just written. The row redraws
        // anyway — api.js announces every entry write and the app refreshes
        // the day on it.
        emitToast('Narrative filled in from this matter', {
          actionLabel: 'Undo',
          action: () => undoAuto(),
        });
      })
      .catch((err) => {
        if (matterConflict(err)) return;
        autoRef.current = false; // leave it a plain chip list
      });
  }, [chips]); // eslint-disable-line

  // ---- MATTER FENCE 3: A REFUSED WRITE IS SAID OUT LOUD ----
  //
  // The server compares `source_cm_id` against the entry's matter as it stands
  // right now and answers 409 when they differ. That is not an error to swallow
  // and not one to report as "failed": nothing was written, the reason is
  // something the lawyer did (or another surface did) and can understand, and
  // the offer itself is no longer about this entry. So it says so and goes.
  // A 409 from the finalize lock is a different thing and keeps its own words.
  function matterConflict(err) {
    if (!err || err.status !== 409) return false;
    if (/finaliz/i.test(String(err.body?.error || err.message || ''))) return false;
    emitToast('That entry moved to another matter — nothing was written.', { error: true });
    finish(false);
    return true;
  }

  async function undoAuto() {
    const before = liveRef.current;
    try {
      await api.patch(`/api/entries/${entry.id}`, stamped({
        narrative: before.narrative, narrative_ai: before.narrative_ai,
      }));
      ownWriteRef.current = before.narrative;
      setApplied(null); // …and the offer stands, so a different phrase is one tap away
      setSaved(before.narrative);
      emitToast('Narrative put back');
    } catch (e) { if (!matterConflict(e)) emitToast(e.message, { error: true }); }
  }

  // ---- WHAT IS ACTUALLY ON THIS ENTRY ----
  //
  // The one gate every "already saved" claim passes through. `applied` is only
  // this offer's memory of what it wrote; `saved` is what the server last said
  // the narrative is. A confirmation is drawn only where the two agree, on
  // THIS entry — so a stale render, a PATCH that failed, or a narrative
  // rewritten from the row can never leave a tick on screen against text the
  // entry does not carry, and can never hand a lawyer another client's
  // sentence to accept.
  //
  // …and the matter is part of that gate. Comparing the TEXT alone is exactly
  // how "already saved" survived the entry being re-pointed at another client:
  // the sentence on screen really was the sentence in the database, and the
  // claim was still false, because it was the wrong matter's sentence sitting
  // on this entry. `moved` is the other half of the comparison.
  const settled = (!moved && applied !== null && String(saved).trim() === String(applied).trim())
    ? applied : null;

  // ---- what retires itself: an offer that is asking for nothing ----
  //
  // A pure confirmation times out; an offer with an unanswered question does
  // not. That is a stop on an entry that already said what the work was
  // (chipped earlier, typed on the row, AUTO from task lines) — and now also
  // one this offer has just filled in for him, because there is nothing left
  // to do on it either. A matter with no wording of his own still has a
  // question on screen, and that one stays until it is answered.
  const bare = (!offerChips || settled !== null) && !result.relinked;
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
      await api.patch(`/api/entries/${entry.id}`, composed({
        narrative: chip.text, narrative_ai: chip.ai ? 1 : 0,
      }));
      doneRef.current = true;
      // The row is the confirmation — it redraws with the narrative on it and
      // its "needs a narrative" rail cleared. The toast only carries the way
      // back, because a pick overwrites.
      emitToast('Narrative saved', {
        actionLabel: 'Undo',
        action: () => api.patch(`/api/entries/${entry.id}`, stamped({
          narrative: before.narrative, narrative_ai: before.narrative_ai,
        })).then(() => { emitToast('Narrative put back'); onFiled(); })
          .catch((err) => emitToast(err.status === 409
            ? 'That entry moved to another matter — nothing was written.'
            : err.message, { error: true })),
      });
      onFiled();
    } catch (e) {
      setBusy(false);
      if (matterConflict(e)) return;
      emitToast(e.message, { error: true });
    }
  }

  function edit() { finish(false); openEditor({ id: entry.id }); }

  // ---- CHIP SHAPE IS RESERVED FOR THINGS THAT WOULD CHANGE SOMETHING ----
  //
  // Measured on the five-entry day: leaving every stop alone cost 12
  // interactions and tapping the offer's ticked chip on every stop cost 17.
  // The five taps bought nothing. The narrative was already written by the
  // time the offer appeared, and the offer then re-drew that same sentence as
  // a chip — same size, same weight, same shape, same 1 key as the genuine
  // alternatives beside it — so an untaken-looking control sat there asking to
  // be taken, and taking it re-PATCHed identical text and fired a toast.
  //
  // So the settled sentence is TEXT now, with a quiet way to change it, and a
  // chip means "tap this and the entry says something different". The 1 2 3
  // caps index the alternatives alone, because those are the only keys that do
  // anything. (This used to end with a re-measured "12, or 13" day count. It is
  // withdrawn — see THE DAY COUNT, HONESTLY at the top of this file.)
  const alternatives = settled === null
    ? (chips || []) : (chips || []).filter((c) => c.text !== settled);
  const shown = alternatives;

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
      } else if (['1', '2', '3'].includes(e.key) && shown[Number(e.key) - 1]) {
        e.preventDefault();
        e.stopPropagation();
        pick(shown[Number(e.key) - 1]);
      }
    };
    // Capture phase: the stopped row usually keeps DOM focus, so these keys
    // would otherwise route through the Today list's own handlers first.
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
    // `saved` is in here because `shown` is derived from it: the digit keys
    // must index exactly the chips on screen, never a list from a moment ago.
  }, [chips, applied, saved, busy]); // eslint-disable-line

  // The entry is not on this matter any more. The refresh above has already
  // called finish(), so this render is the last one before the mount site drops
  // the component — and there is nothing in the offer that would be true on it.
  // Drawing nothing is the only honest frame to end on.
  if (moved) return null;

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

      ${/* The entry this timer was filling is settled (finalized, deleted, or
            moved off the timer's matter or date), so the rest of the day went
            to a NEW entry. The server has already taken the settled hours off
            the clock — syncToEntry() in routes/timers.js — so this is a notice,
            not a question: a "Deduct" button here would remove them twice. */''}
      ${result.relinked ? html`
        <div class="stop-chips-warn">
          The entry this timer was filling is settled, so the ${hoursFiled}h left
          on the clock went to a <strong>new</strong> entry.
        </div>` : null}

      ${offerChips && chips === null ? html`
        <p class="muted small stop-chips-note">Looking for what you wrote last time…</p>` : null}

      ${/* WHAT IS ON THE ENTRY — SETTLED TEXT, NOT A CONTROL.
            The sentence is already saved by the time this is read, so it is
            drawn as what it is: the entry's narrative, quoted, with a settled
            mark down its edge. It used to be a chip — same size, weight, shape
            and key cap as the real alternatives next to it — which read as
            untaken and cost a tap that changed nothing (measured: +5 on a
            five-entry day). A confirmation nobody has to answer does not need
            a button; it needs to be legible and to be easy to overrule, and
            the quiet "Change the wording" under it is the overrule.
            `data-stop-settled` carries the text for the smoke test, which
            asserts that whatever is shown as settled is what the entry
            actually holds. */''}
      ${settled ? html`
        <div class="stop-chips-settled" data-stop-settled=${settled} style=${SETTLED}>
          <${Icon} name="check" size=${14} />
          <p style=${SETTLED_TEXT}>${settled}</p>
        </div>
        <p class="muted small stop-chips-note" style=${NOTE}>
          Written in from your own wording on this matter — <strong>already saved</strong>.
          Nothing to do if it is right.
        </p>
        ${!writing ? html`
          <div style=${QUIET_ROW}>
            <button type="button" class="btn btn-sm" onClick=${() => setWriting(true)}>
              <${Icon} name="edit" size=${14} /> Change the wording
            </button>
          </div>` : null}` : null}

      ${/* THE ALTERNATIVES — shown only when the phrasebook has more than one
            plausible option, so a chip appears exactly where it is a genuine
            choice rather than a tax on every stop.

            A chip carries a leading visual, the way every filter/assist chip
            in a mature system does — without one a full-width bordered box
            of prose reads as a field, not an action, and at phone width
            the number cap that used to be the only leading mark is not
            drawn at all. It doubles as provenance: ⟲ is something the
            attorney wrote on this matter before, ✦ is the model's
            suggested-on-start line. He should be able to tell which he is
            accepting — the app already tracks it (narrative_ai) so that AI
            text never re-enters the pool the model learns his voice from,
            and that distinction is worth showing rather than hiding. */''}
      ${offerChips && alternatives.length > 0 ? html`
        ${settled ? html`
          <p class="muted small stop-chips-note" style=${NOTE}>Or use one of these instead:</p>` : null}
        <div class="stop-chips-list">
          ${alternatives.map((chip, i) => html`
            ${/* No `aria-pressed` on these. It used to be here because one
                  chip claimed to be the applied one, and a toggle state is
                  what that claim was made of — but a suggestion chip commits
                  and closes, it does not toggle, so announcing it as a
                  two-state control was wrong twice over. Nothing in this list
                  is ever the entry's current narrative: the settled sentence
                  is filtered out of it above. */''}
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

      ${/* Nothing settled, but something on offer: the field is still one tap
            away rather than a second thought. When something IS settled the
            same affordance already sits under it ("Change the wording"), so it
            is not drawn twice. */''}
      ${offerChips && !settled && alternatives.length > 0 && !writing ? html`
        <div style=${QUIET_ROW}>
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

      ${/* The full phrasebook, and it is matter-scoped at both ends: the dialog
            only ever lists the matter it was opened for (narrativehistory.js
            drops a feed that arrives for a different one), and the write it
            hands back is stamped with the matter this offer belongs to, so a
            sentence chosen here cannot land on an entry that has moved. */''}
      ${historyOpen && cmId ? html`
        <${NarrativeHistory} cmId=${cmId} cmLabel=${cmLabel || 'this matter'}
          insertLabel="Use it" announce=${false}
          onInsert=${(text, srcCm) => {
    if (srcCm != null && srcCm !== mountCm.current) {
      emitToast('That list is for another matter — nothing was written.', { error: true });
      return;
    }
    pick({ text, ai: false });
  }}
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
// THE SETTLED NARRATIVE. Deliberately not chip-shaped: no full border, no
// fill, no radius, nothing that reads as a raised, untaken control. What it
// has instead is the app's own settled-choice mark — a 2px rule down the left
// edge in the tier-2 family (`--state-selected-mark`, "a settled choice") —
// which is how this design system already says "this one IS the current
// value" everywhere else. The tick and the rule share that color; the sentence
// itself is plain body text, because it is the entry's own words.
const SETTLED = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 'var(--gap-inline)',
  margin: 'var(--space-1) 0 var(--space-2)',
  padding: 'var(--space-0-5) 0 var(--space-0-5) var(--space-3)',
  borderLeft: 'var(--state-mark-w) solid var(--state-selected-mark)',
  color: 'var(--state-selected-mark)',
};
const SETTLED_TEXT = {
  margin: 0,
  minWidth: 0,
  color: 'var(--text-primary)',
  fontSize: 'var(--fs-body)',
  lineHeight: 'var(--lh-body)',
};
const NOTE = { margin: '0 0 var(--space-2)' };
// The way to overrule the settled sentence. It sits at its own width on the
// reading edge: a full-bleed button with centred content reads as a primary,
// and the whole point of this control is that it is the exception, not the
// expected next move. Same small bordered shape as Dismiss / More / Edit in
// the foot, so it reads as one of the secondary controls it belongs with.
const QUIET_ROW = { display: 'flex', justifyContent: 'flex-start', margin: 'var(--space-1) 0 var(--space-2)' };

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

// (The filter that drops phrases carrying baked-in time amounts — "(0.5)" — and
// the three-deep dedupe both live inside `build` now, because a chip has to
// keep its provenance through them: which of them may be written unasked is
// decided by `own`, and that was lost when the pipeline was a list of strings.)
