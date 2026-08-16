import { api, downloadText } from '/js/api.js';
import {
  html, React, useState, useEffect, useRef, useMemo, useCallback, Overlay,
  fmtHours, emitToast, Icon, Spinner, ValidationList,
} from '/js/ui.js';
import { GhostInput } from '/js/components/ghosttext.js';
import { useShortcuts } from '/js/components/shortcuts.js';
import { expandShortcuts } from '/js/lib/expand.js';
import { containsTimeAmounts } from '/js/lib/timeamounts.js';

// ===========================================================================
// CLOSE THE DAY — a review LIST, not a card carousel  (teardown §18, wave-1 F2)
//
// The wave-1 review's single biggest number: a five-entry day cost 18
// interactions, and 23 if the lawyer used the new one-tap stop chips — the
// fast path made the day LONGER. The cause was measured and confirmed:
//
//   "The stop chip and the close-out sweep are not connected. An entry that
//    already has a narrative — because you chipped it thirty seconds earlier —
//    still gets its own card in the sweep and still costs an Enter. Close-out
//    charges 1 + N + 2 where N is EVERY draft. The wave's own new capability —
//    the phrasebook pre-fill and the chip — should be able to retire cards,
//    not just pre-fill them."
//
// So the sweep no longer charges for finished work:
//
//   1. A DRAFT THAT ALREADY HAS A NARRATIVE IS NOT A CARD. It goes in the
//      "Already written" list, which the lawyer reads and confirms ONCE with the
//      primary. Chipping an entry now removes a step from the day instead of
//      adding one.
//   2. WHAT IS LEFT IS A LIST, NOT A CAROUSEL. The teardown: "you cannot tell
//      at a glance which of the four drafts still need work, and you cannot
//      skip ahead to the one you know is wrong. For 4 drafts a carousel is
//      fine; for 12 it is a trap." Every remaining draft is on screen with its
//      pre-filled narrative in an editable field. The keyboard contract
//      survives and reads better on a list than it did on a stack: Enter
//      accepts the row and drops to the next, ↑/↓ walk the fields, `e` opens
//      the full editor, Esc quits.
//   3. ACCEPT ALL, for the ordinary day where every suggestion is right.
//   4. EDIT NO LONGER DESTROYS THE SWEEP. It used to call onClose(true), so
//      correcting one entry cost the whole pass — measured: Edit on card 1 of
//      4 unmounted the sweep, and Escape left you on Today with no sweep at
//      all. The editor opens OVER the review now (the overlay primitive is a
//      LIFO stack and handles this natively) and the review is still there,
//      with that row re-read from the server, when the editor closes.
//   5. THE TERMINAL STATE IS A TOAST WHEN IT CARRIES NO DECISION. A dialog is
//      for urgent information or a decision (Material 3); "the day closed and
//      the CSV downloaded" is neither, and charging a tap for `Done` on the
//      clean path is the last fixed cost in the flow. The panel STAYS — and
//      says considerably more than it used to — whenever something is left
//      over, because then there IS a decision.
//
// Phases: loading · empty · review · warn · blocked · closed.
// The summary phase is gone: it existed only to show a count between the last
// card and the commit, and the review list shows that count the whole time.
// ===========================================================================

// ===========================================================================
// ONE NUMBER  (wave-2b)
//
// The panel used to state the same quantity four different ways on one screen.
// Measured, mixed day: the title said "Close the day — 3 to write", the band
// head said "NEEDS A NARRATIVE 3", the secondary button said "Accept all 2",
// and the closing sentence said "saves all 2 narratives above … 1 entry will
// stay a draft". A lawyer reading top to bottom could not answer the one
// question a billing screen must never be vague about: HOW MANY ENTRIES AM I
// ABOUT TO COMMIT? The answer that day was 4, and the figure 4 appeared
// nowhere on the panel.
//
// So every count here now falls out of a single split of the day's drafts:
//
//   a draft whose narrative box HAS TEXT  →  it will be FILED
//   a draft whose narrative box is EMPTY  →  it will STAY A DRAFT
//
// "Box" covers all three ways a narrative gets there: already written (chip,
// row, editor, AUTO task lines), pre-filled from the matter's phrasebook, or
// typed here. `going` and `staying` below are the only two counts the panel
// is allowed to speak, and they are what the TITLE, the BANDS, the PRIMARY
// BUTTON and the closing sentence all say. The number moves live: type one
// word into an empty box and the title, the primary and the sentence all
// tick up together.
//
// The one count that survives outside that split is the collapsed "Already
// written" band's own — a band that hides its rows has to say how many it is
// hiding. Nothing that is on screen carries a badge you could mistake for the
// commit figure. In particular `Accept all` LOST its count: it wrote a
// different quantity (suggestions still unsaved) than the primary commits
// (entries), and that mismatch was two of the four contradictory numbers.
// ===========================================================================

// A draft is "written" when it already says what the work was — chipped from
// the stop offer, typed on the row, written in the editor, or built from task
// lines (AUTO). Written drafts cost nothing at close-out.
const isReady = (d) => String(d.narrative || '').trim() !== '';

// ---------------------------------------------------------------------------
// ONE ROW PER MATTER  (wave-2b)
//
// The same matter used to appear twice in one dialog — "Acme — Borealis merger
// 0.0h" under NEEDS A NARRATIVE and "Acme — Borealis merger 2.6h" under READY —
// because close-out listed ENTRIES while Today lists MATTERS. (That is the
// wave-1 review's D8 defect, "Today and the ledger disagree about the day",
// showing up inside a dialog.) Drafts are grouped by matter here, exactly as
// the Today list groups them, and a matter that is part-written carries BOTH
// figures on its one row: what still needs words, and what is already written.
//
// Matterless drafts are never merged with each other — two unassigned stops
// are two different pieces of work — so they key by entry.
// ---------------------------------------------------------------------------
function buildGroups(list) {
  const order = [];
  const byKey = new Map();
  for (const d of list || []) {
    const key = d.cm && d.cm.id ? `cm:${d.cm.id}` : `entry:${d.id}`;
    let g = byKey.get(key);
    if (!g) {
      g = {
        key,
        cm: d.cm || null,
        label: d.cm ? d.cm.short_name : 'No matter yet',
        entries: [], written: [], blank: [],
        hours: 0, writtenHours: 0, blankHours: 0,
      };
      byKey.set(key, g);
      order.push(g);
    }
    const hours = Number(d.total || 0);
    g.entries.push(d);
    g.hours += hours;
    if (isReady(d)) { g.written.push(d); g.writtenHours += hours; }
    else { g.blank.push(d); g.blankHours += hours; }
  }
  return order;
}

// The closing sentence. It says what the primary is about to DO, in the same
// two numbers the title and the button carry — because the primary does two
// things that are not on its label: it writes every suggestion still sitting
// in a box (the lawyer read them and left them there, so they are his answer),
// and it leaves anything blank as a draft. Plurals are written out rather than
// assembled from `s` fragments, because "2 will stay drafts — nothing is lost,
// and IT will be here tomorrow" is the same defect one clause further along.
function noteFor({ going, staying, goingHours }) {
  if (going === 0) {
    return 'Nothing here says what the work was yet, so nothing can be filed. '
      + 'Write a narrative above, or leave the day alone — nothing is lost.';
  }
  const locks = going === 1 ? 'the one draft' : `all ${going} drafts`;
  const first = `Finalize & export saves what is in the boxes above, locks ${locks} (${fmtHours(goingHours)}h) `
    + 'and downloads them as a CSV.';
  if (staying === 0) return first;
  const rest = staying === 1
    ? 'One entry will stay a draft — nothing is lost, and it will be here tomorrow.'
    : `${staying} entries will stay drafts — nothing is lost, and they will be here tomorrow.`;
  return `${first} ${rest}`;
}

export function CloseOut({ onClose, openEditor }) {
  const [drafts, setDrafts] = useState(null); // null = loading; frozen at open
  const [date, setDate] = useState(null);
  const [phase, setPhase] = useState('loading');
  const [texts, setTexts] = useState({});     // entry id → what the field holds
  const [skip, setSkip] = useState({});       // entry id → deliberately left a draft
  const [sugg, setSugg] = useState({});       // cm id → phrasebook lines
  const [readyOpen, setReadyOpen] = useState(true);
  const [warnInfo, setWarnInfo] = useState(null); // { warnOnly, hard, newDrafts? }
  const [closedInfo, setClosedInfo] = useState(null); // { total, blocked: [] }
  const [blockedInfo, setBlockedInfo] = useState(null); // { blocked: [] }
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState(null); // an entry open in the editor OVER this
  const changedRef = useRef(false); // anything saved/finalized/exported/edited
  const savedRef = useRef(0);       // narratives written during this pass

  const shortcuts = useShortcuts();
  const expand = useCallback((t, caret) => expandShortcuts(t, caret, shortcuts), [shortcuts]);

  const groups = useMemo(() => buildGroups(drafts), [drafts]);
  const ready = useMemo(() => groups.filter((g) => g.blank.length === 0), [groups]);
  const needs = useMemo(
    () => groups.filter((g) => g.blank.length > 0 && !skip[g.key]), [groups, skip]);
  const parked = useMemo(
    () => groups.filter((g) => g.blank.length > 0 && skip[g.key]), [groups, skip]);
  const groupByKey = useMemo(() => {
    const m = {};
    groups.forEach((g) => { m[g.key] = g; });
    return m;
  }, [groups]);
  const draftById = useMemo(() => {
    const m = {};
    (drafts || []).forEach((d) => { m[d.id] = d; });
    return m;
  }, [drafts]);

  // ---- MATTER FENCE: A PRE-FILL MAY ONLY EVER BE THIS MATTER'S OWN WORDING --
  //
  // docs/ui/BRIEF.md, "Data integrity": a narrative written for matter A may
  // never be pre-filled into an entry for matter B, not even between two
  // matters of the same client. /api/matters/:id/suggestions blends in the
  // client's OTHER matters whenever this matter's history is thin, and marks
  // those `source: 'client'`. This component used to map that response to bare
  // strings — `r.phrases.map((p) => p.text)` — which threw the one field that
  // says where a sentence came from, and then put `[0]` straight into the
  // row's textarea. Finalize & export saves every box that has text, so a
  // sibling matter's billing sentence reached the database and the CSV without
  // anybody choosing it.
  //
  // The source rides through the mapping now, and the PRE-FILL takes the first
  // phrase that is this matter's own. An empty box is the correct fallback: it
  // stays a draft, nothing is lost, and it will be here tomorrow — which is
  // exactly what the panel already promises. (The suggestion list handed to
  // GhostInput is untouched: ghost text is reusable wording and the brief says
  // it is shared by design.)
  const prefillOf = useCallback((cmId) => {
    const own = (sugg[cmId] || []).find((p) => p.source !== 'client');
    return own ? own.text : '';
  }, [sugg]);

  // The box's value: what the lawyer typed, else the matter's top clean
  // phrasebook line OF ITS OWN, so the primary CONFIRMS rather than composes.
  // Resolved at render instead of synced by an effect — an effect that
  // pre-fills has to know whether the field was touched, and the touched case
  // is exactly `texts[key] !== undefined`.
  const valueOf = useCallback((g) => {
    if (texts[g.key] !== undefined) return texts[g.key];
    return prefillOf(g.cm?.id);
  }, [texts, prefillOf]);

  // ---- THE ONE NUMBER, and its complement ----
  // Counted in ENTRIES, because an entry is what gets locked and what becomes a
  // line in the CSV — the rows above are matters, and a row says so whenever it
  // stands for more than one entry.
  const filing = useMemo(() => {
    const withText = new Set(
      needs.filter((g) => String(valueOf(g)).trim() !== '').map((g) => g.key));
    let going = 0;
    let goingHours = 0;
    let total = 0;
    let totalHours = 0;
    for (const g of groups) {
      total += g.entries.length;
      totalHours += g.hours;
      going += g.written.length + (withText.has(g.key) ? g.blank.length : 0);
      goingHours += g.writtenHours + (withText.has(g.key) ? g.blankHours : 0);
    }
    return {
      withText,
      going,
      goingHours,
      staying: total - going,
      stayingHours: totalHours - goingHours,
      total,
      // every already-written ENTRY, wherever its row sits — a part-written
      // matter keeps its finished entries inside its own card now
      writtenEntries: groups.reduce((n, g) => n + g.written.length, 0),
    };
  }, [groups, needs, valueOf]);

  // Fresh fetch on open — the dashboard's copy behind this overlay may be
  // stale (a stop-chip pick, another tab, etc.).
  const load = useCallback(async (first) => {
    setPhase('loading');
    try {
      const d = await api.get('/api/dashboard');
      const list = d.entries.filter((e) => e.status === 'draft');
      setDate(d.date);
      setDrafts(list);
      setTexts({});
      setSkip({});
      setWarnInfo(null);
      setPhase(list.length === 0 ? 'empty' : 'review');
    } catch (e) {
      emitToast(e.message, { error: true });
      onClose(first ? false : changedRef.current);
    }
  }, [onClose]);

  useEffect(() => { load(true); }, []); // eslint-disable-line

  // One phrasebook read per matter that still needs a narrative — the same
  // endpoint the entry editor and the stop chips use, asked for the whole list
  // at once because a list of N rows cannot call a per-matter hook N times.
  const needKey = needs.map((g) => g.cm?.id || 0).join(',');
  useEffect(() => {
    const ids = [...new Set(needs.map((g) => g.cm?.id).filter(Boolean))];
    if (ids.length === 0) return undefined;
    let alive = true;
    Promise.all(ids.map((id) => api.get(`/api/matters/${id}/suggestions`)
      // `source` survives the mapping — see the fence above `prefillOf`. It is
      // the difference between "he wrote this on this matter" and "somebody
      // wrote this on a different one", and the pre-fill turns on it.
      .then((r) => [id, r.phrases
        .filter((p) => !containsTimeAmounts(p.text))
        .map((p) => ({ text: p.text, source: p.source }))])
      .catch(() => [id, []])))
      .then((pairs) => {
        if (!alive) return;
        setSugg((prev) => {
          const next = { ...prev };
          let changed = false;
          for (const [id, list] of pairs) {
            if (!(id in next)) { next[id] = list; changed = true; }
          }
          return changed ? next : prev;
        });
      });
    return () => { alive = false; };
  }, [needKey]); // eslint-disable-line

  // Keyboard-first on desktop: the caret starts in the first field that still
  // needs words. THUMB-first on a phone — a bottom sheet that throws the soft
  // keyboard up over its own list before the lawyer has read it is the
  // opposite of what this dialog is for, and every action here has a button.
  useEffect(() => {
    if (phase !== 'review') return;
    if (window.matchMedia('(max-width: 767px)').matches) return;
    const el = document.querySelector('.closeout-card .co-item textarea');
    if (el) el.focus();
  }, [phase]);

  // ---------- writes ----------

  // Every narrative written from this panel names the matter its row was built
  // for. The list is frozen at open and the primary can be pressed minutes
  // later, so "the matter this row is about" and "the matter this entry is on"
  // are two different facts; the server compares them and refuses (409) if they
  // have come apart. A refusal writes nothing, and the caller stops rather than
  // finalizing past it.
  async function save(d, text) {
    if (d.narrative_auto) return true;
    if (text === (d.narrative || '')) return true;
    try {
      await api.patch(`/api/entries/${d.id}`, {
        narrative: text,
        ...(d.cm && d.cm.id != null ? { source_cm_id: d.cm.id } : {}),
      });
      changedRef.current = true;
      savedRef.current += 1;
      setDrafts((list) => list.map((x) => (x.id === d.id ? { ...x, narrative: text } : x)));
      return true;
    } catch (e) {
      const moved = e.status === 409 && !/finaliz/i.test(String(e.body?.error || e.message || ''));
      emitToast(moved
        ? `${label(d)} moved to another matter — that narrative was not written.`
        : e.message, { error: true });
      return false;
    }
  }

  // Enter on a row: write it and drop to the next one that still needs words.
  // The row leaves the list the moment it is saved, so the next field has to be
  // chosen before the write and focused after the re-render. One box covers
  // every unwritten entry on that matter — the row says so when there is more
  // than one, and that is the whole point of merging them.
  async function acceptGroup(key) {
    const g = groupByKey[key];
    if (!g) return;
    const i = needs.findIndex((x) => x.key === key);
    const nextKey = i > -1 && needs[i + 1] ? needs[i + 1].key : null;
    const text = valueOf(g);
    if (String(text).trim()) {
      for (const d of g.blank) await save(d, text); // eslint-disable-line no-await-in-loop
    }
    requestAnimationFrame(() => {
      const el = nextKey
        ? document.querySelector(`.co-item[data-group="${nextKey}"] textarea`)
        : document.querySelector('.closeout-card .co-primary');
      if (el) el.focus();
    });
  }

  async function acceptAll() {
    setBusy(true);
    try {
      for (const g of needs) {
        const text = valueOf(g);
        if (!String(text).trim()) continue;
        for (const d of g.blank) await save(d, text); // eslint-disable-line no-await-in-loop
      }
    } finally { setBusy(false); }
  }

  // ---------- the editor, OVER the review ----------
  //
  // The overlay primitive is a LIFO stack, so the entry editor opens on top and
  // answers Escape first; this dialog stays mounted underneath with its list,
  // its typed text and its place intact. Two things have to follow from that:
  // this component's capture-phase key handler must stand down while it is
  // covered (below), and the row has to be re-read when the editor closes,
  // because the editor is exactly where its narrative may have been written.
  function editEntry(id) {
    changedRef.current = true;
    setEditingId(id);
    openEditor({ id });
  }

  useEffect(() => {
    if (editingId == null) return undefined;
    let seen = false;
    const iv = setInterval(async () => {
      const open = !!document.querySelector('.ovl-panel.modal');
      if (open) { seen = true; return; }
      if (!seen) return; // the editor has not mounted yet
      clearInterval(iv);
      const id = editingId;
      setEditingId(null);
      try {
        const fresh = await api.get(`/api/entries/${id}`);
        setDrafts((list) => (fresh.status === 'draft' && !fresh.deleted_at
          ? list.map((x) => (x.id === id ? { ...x, ...fresh } : x))
          : list.filter((x) => x.id !== id)));
        setTexts((t) => { const n = { ...t }; delete n[id]; return n; });
      } catch { /* deleted, or offline — leave the row as it stands */ }
    }, 150);
    return () => clearInterval(iv);
  }, [editingId]);

  // ---------- finalize / export ----------

  async function finalizeAndExport(ack) {
    setBusy(true);
    try {
      // Everything the lawyer left in a field is his answer — write it before
      // the day is locked, or the primary would finalize past his own text.
      //
      // …and if one of those writes is REFUSED, stop. A refusal here means the
      // entry is not the entry this row described any more (it moved matter),
      // and finalizing on past it would lock a draft whose narrative never
      // landed — time filed under words nobody chose for it. The day is
      // re-read instead, which puts the panel back on what is actually true.
      if (!ack) {
        for (const g of needs) {
          const text = valueOf(g);
          if (!String(text).trim()) continue;
          for (const d of g.blank) {
            const ok = await save(d, text); // eslint-disable-line no-await-in-loop
            if (!ok) {
              emitToast('Nothing was finalized — the day has been re-read.', { error: true });
              await load(false); // eslint-disable-line no-await-in-loop
              return;
            }
          }
        }
      }
      if (ack) {
        // finalize-day applies ack DATE-WIDE, not per-entry (and the plan
        // forbids changing it): a draft filed while this warning card sat on
        // screen (background timer stop, another tab) would get its warnings
        // acknowledged and finalized sight unseen. Guard client-side: only
        // ack if today's draft set is still exactly what this pass reviewed
        // (the frozen list + the blocked ids the warning screen listed).
        const freshD = await api.get('/api/dashboard');
        const reviewed = new Set([
          ...(drafts || []).map((d) => d.id),
          ...(warnInfo ? [...warnInfo.warnOnly, ...warnInfo.hard].map((b) => b.id) : []),
        ]);
        const newDrafts = freshD.entries.filter((e) => e.status === 'draft' && !reviewed.has(e.id));
        if (newDrafts.length > 0) {
          setWarnInfo((w) => ({ ...w, newDrafts }));
          return;
        }
      }
      // Deliberately no markJustFinalized() for the bulk path: the closed
      // moment is its own confirmation here; a row of chips pulsing behind the
      // backdrop would be decoration (spec §7 restraint).
      const r = await api.post('/api/finalize-day', { date, ack });
      changedRef.current = true;
      const warnOnly = r.blocked.filter((b) => b.blocks.length === 0);
      const hard = r.blocked.filter((b) => b.blocks.length > 0);
      if (!ack && warnOnly.length > 0) {
        setWarnInfo({ warnOnly, hard });
        setPhase('warn');
        return;
      }
      await doExport(hard);
    } finally {
      setBusy(false);
    }
  }

  async function doExport(hard) {
    const left = hard || [];
    const r = await api.post('/api/export', { from: date, to: date });
    changedRef.current = true;
    if (r.count === 0) {
      setBlockedInfo({ blocked: left.length ? left : (drafts || []).map((d) => ({ id: d.id, blocks: [] })) });
      setPhase('blocked');
      return;
    }
    downloadText(`timekeeper-${date}.csv`, r.csv);
    const fresh = await api.get('/api/dashboard');
    if (left.length === 0) {
      // NOTHING LEFT TO DECIDE — so this is a snackbar, not a dialog. The
      // export has downloaded and the day behind the scrim is finalized; a
      // modal whose only control is "Done" was the last fixed interaction in
      // the whole flow and it bought the lawyer nothing.
      emitToast(`Day closed — ${fmtHours(fresh.today.total)}h finalized and downloaded as CSV`);
      onClose(true);
      return;
    }
    setClosedInfo({ total: fresh.today.total, blocked: left });
    setPhase('closed');
  }

  // ---------- keyboard ----------
  //
  // Document-level capture listener (the StopChips pattern). Escape is NOT
  // handled here — the Overlay primitive owns it for every dialog in the app.
  useEffect(() => {
    // While the entry editor (or anything else) is open OVER this dialog, this
    // listener has to be silent: it runs in the CAPTURE phase at document
    // level, so a stray stopPropagation here would swallow keystrokes before
    // the dialog above ever saw them.
    const covered = () => {
      const panels = document.querySelectorAll('.ovl-panel');
      const top = panels[panels.length - 1];
      return !top || !top.classList.contains('closeout-card');
    };
    function onKey(e) {
      if (covered()) return;
      const tag = (e.target.tagName || '').toLowerCase();
      const typing = ['input', 'textarea', 'select'].includes(tag) || e.target.isContentEditable;
      // A focused BUTTON owns its own Enter/Space — Accept all, Edit, Skip and
      // the primary are real buttons, and this must not fire twice on top of a
      // button's own click.
      const onButton = !!(e.target.closest && e.target.closest('button'));
      const item = e.target.closest ? e.target.closest('.co-item') : null;

      if (phase === 'review' && e.key === 'Enter' && !e.shiftKey && !onButton) {
        e.preventDefault();
        e.stopPropagation();
        if (item) acceptGroup(item.dataset.group);
        else if (!busy) finalizeAndExport(false);
        return;
      }

      // ↑/↓ walk the list. Inside a field they only leave it once the caret has
      // no line left to travel to, which is how every list-of-textareas worth
      // copying behaves — a narrative can be two lines and the arrow keys still
      // have to edit it.
      if (phase === 'review' && (e.key === 'ArrowDown' || e.key === 'ArrowUp') && !e.altKey) {
        if (typing) {
          if (!item || tag !== 'textarea') return;
          const v = e.target.value || '';
          const c = e.target.selectionStart;
          const free = e.key === 'ArrowDown'
            ? !v.slice(c).includes('\n')
            : !v.slice(0, c).includes('\n');
          if (!free) return;
        }
        const fields = [...document.querySelectorAll('.closeout-card .co-item textarea')];
        if (fields.length === 0) return;
        const i = fields.indexOf(document.activeElement);
        const next = i < 0 ? (e.key === 'ArrowDown' ? 0 : fields.length - 1) : i + (e.key === 'ArrowDown' ? 1 : -1);
        if (next < 0 || next >= fields.length) return;
        e.preventDefault();
        e.stopPropagation();
        fields[next].focus();
        return;
      }

      if (typing) return; // never fence real typing — the field must see its own keys
      if (!(e.metaKey || e.ctrlKey || e.altKey) && e.key === 'e' && phase === 'review') {
        const g = item ? groupByKey[item.dataset.group] : needs[0];
        const id = g && g.blank[0] ? g.blank[0].id : null;
        if (id) {
          e.preventDefault();
          e.stopPropagation();
          editEntry(id);
          return;
        }
      }
      // FENCE: app.js's global shortcut handler (n/t/q/c///g/?) is a
      // document-level BUBBLE listener. It stands down for any open overlay
      // now, but this capture fence predates that and still costs nothing —
      // stop propagation for every key we do not handle when the target is not
      // a form field. No preventDefault: browser defaults (button Enter/Space)
      // survive.
      e.stopPropagation();
    }
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [phase, drafts, texts, skip, sugg, needs, groupByKey, busy, editingId]); // eslint-disable-line

  // ---------- render ----------

  const label = (d) => (d.cm ? d.cm.short_name : 'No matter yet');

  let body;
  let title = 'Close the day';

  if (phase === 'loading') {
    body = html`<${Spinner} />`;
  } else if (phase === 'empty') {
    body = html`
      <${React.Fragment}>
        <p>Nothing to close — no drafts today.</p>
        <div class="ovl-actions">
          <button class="btn btn-primary" onClick=${() => onClose(changedRef.current)}>Close</button>
        </div>
      <//>`;
  } else if (phase === 'review') {
    const {
      withText, going, goingHours, staying, stayingHours, total,
    } = filing;
    // THE TITLE IS THE NUMBER. It used to say "3 to write" while the button
    // said 2 and the sentence said 2 and 1; it now says the only thing the
    // lawyer needs before he reads a word of the list.
    title = `Close the day — filing ${going} of ${total}`;

    body = html`
      <${React.Fragment}>
        ${/* THE DAY'S SHAPE, in one line, before anything asks for a decision.
              It replaces the dot pagination, which could only say "card 3 of 5"
              — a position in a stack, never how much of the day was committed.
              Both halves of the split are here, with their hours, so the figure
              on the primary button can be checked against the list. */''}
        <p class="co-shape">
          <span class="co-shape-lead">
            <strong>${going} of ${total} draft${total === 1 ? '' : 's'}</strong> will be filed
          </span>
          <span class="co-shape-hours mono">${fmtHours(goingHours)}h</span>
          <span class="muted">${staying === 0
            ? 'Nothing is left over — the whole day goes.'
            : `${staying} ${staying === 1 ? 'entry' : 'entries'} · ${fmtHours(stayingHours)}h `
              + `will stay ${staying === 1 ? 'a draft' : 'drafts'}.`}</span>
        </p>

        ${/* THE BAND HEADS CARRY NO COUNT unless they are hiding their rows.
              A badge beside a visible list is a second number claiming to
              answer the same question the title answers, and that is exactly
              how "3 / 3 / 2 / 2-and-1" happened. */''}
        ${needs.length > 0 ? html`
          <section class="co-group">
            <div class="co-group-head">
              <h3 class="co-group-title">Not written yet</h3>
              ${withText.size > 0 ? html`
                <button class="btn btn-sm co-acceptall" disabled=${busy} onClick=${acceptAll}
                  title="Save every suggestion below as it stands, without locking the day">
                  <${Icon} name="check" size=${14} /> Accept all
                </button>` : null}
            </div>
            <ul class="co-list">
              ${needs.map((g) => {
    const on = withText.has(g.key);
    const mixed = g.written.length > 0;
    return html`
                <li key=${g.key} class="co-item" data-group=${g.key}
                  data-entry-id=${g.blank[0].id} data-will=${on ? 'file' : 'stay'}>
                  <div class="co-item-head">
                    <strong>${g.label}</strong>
                    <span class="co-item-hours mono">${fmtHours(g.hours)}h</span>
                    ${/* Marked only where it matters. Filing is the ordinary
                          outcome and needs no badge; an empty box is the
                          exception, and it is the one thing on the row that
                          changes the figure in the title. */''}
                    ${on ? null : html`<span class="co-state">stays a draft</span>`}
                  </div>
                  ${/* ONE MATTER, ONE ROW, BOTH FIGURES. */''}
                  ${mixed || g.blank.length > 1 ? html`
                    <p class="co-item-note">
                      <span class="mono">${fmtHours(g.blankHours)}h</span>
                      ${g.blank.length > 1
    ? ` across ${g.blank.length} entries needs a narrative — this one covers them all`
    : ' needs a narrative'}
                      ${mixed ? html`
                        <span class="co-item-sep">·</span>
                        <span class="mono">${fmtHours(g.writtenHours)}h</span>
                        ${` already written${g.written.length > 1 ? ` on ${g.written.length} entries` : ''}: `}
                        <span class="co-item-had" title=${g.written[0].narrative}>${g.written[0].narrative}</span>` : null}
                    </p>` : null}
                  <${GhostInput} multiline rows=${2} value=${valueOf(g)}
                    suggestions=${(sugg[g.cm?.id] || []).map((p) => p.text)} expand=${expand}
                    aria-label=${`Narrative for ${g.label}`}
                    placeholder="What did you do?"
                    onChange=${(t) => setTexts((p) => ({ ...p, [g.key]: t }))} />
                  <div class="co-item-acts">
                    <button class="btn btn-sm" onClick=${() => setSkip((s) => ({ ...s, [g.key]: true }))}
                      title="Leave this one as a draft — nothing is lost">Skip</button>
                    <button class="btn btn-sm" onClick=${() => editEntry(g.blank[0].id)}
                      title="Open the full editor over this review">
                      <${Icon} name="edit" size=${14} /> Edit<kbd class="ovl-kbd" aria-hidden="true">e</kbd>
                    </button>
                  </div>
                </li>`;
  })}
            </ul>
          </section>` : null}

        ${parked.length > 0 ? html`
          <section class="co-group">
            <div class="co-group-head">
              <h3 class="co-group-title">Staying a draft</h3>
            </div>
            <ul class="co-list co-list-quiet">
              ${parked.map((g) => html`
                <li key=${g.key} class="co-row">
                  <span class="co-row-name">${g.label}</span>
                  <span class="co-row-hours mono">${fmtHours(g.blankHours)}h</span>
                  <button class="btn btn-sm"
                    onClick=${() => setSkip((s) => { const n = { ...s }; delete n[g.key]; return n; })}
                    title="Put this one back in the list">Undo</button>
                  ${/* Skipping a PART-written matter parks only the part with no
                        words on it; what was already written on the same matter
                        still files, and is counted in the figure above, so the
                        row has to say so. */''}
                  ${g.written.length > 0 ? html`
                    <span class="co-row-narr">
                      <span class="mono">${fmtHours(g.writtenHours)}h</span>
                      ${` on this matter is already written and still files: “${g.written[0].narrative}”`}
                    </span>` : null}
                </li>`)}
            </ul>
          </section>` : null}

        ${/* ALREADY WRITTEN — the whole point of the wave-1 rewrite. A draft
              that was finished at the moment the timer stopped (the stop
              offer, the row's own field, the editor) is not a card to be
              walked through: it is work already done, and it is confirmed
              once, with everything else, by the primary below. This is the
              ONE band that carries a count, because collapsing it hides its
              rows and a band that hides rows has to say how many. */''}
        ${ready.length > 0 ? html`
          <section class="co-group co-ready">
            <button class="co-disclosure" aria-expanded=${readyOpen ? 'true' : 'false'}
              onClick=${() => setReadyOpen((v) => !v)}>
              <${Icon} name=${readyOpen ? 'chevronDown' : 'chevronRight'} size=${16} />
              <span class="co-group-title">Already written
                <span class="co-count">${ready.reduce((n, g) => n + g.entries.length, 0)}</span></span>
              <span class="co-row-hours mono">${fmtHours(ready.reduce((h, g) => h + g.hours, 0))}h</span>
            </button>
            ${readyOpen ? html`
              <ul class="co-list co-list-quiet">
                ${ready.map((g) => html`
                  <li key=${g.key} class="co-row">
                    <span class="co-row-name">
                      ${g.label}
                      ${g.entries.length > 1 ? html`<span class="co-count">${g.entries.length}</span>` : null}
                      ${g.written.every((d) => d.narrative_auto) ? html`<span class="auto-badge">AUTO</span>` : null}
                    </span>
                    <span class="co-row-hours mono">${fmtHours(g.hours)}h</span>
                    <span class="co-row-narr" title=${g.written[0].narrative}>${g.written[0].narrative}</span>
                    <button class="btn btn-sm btn-icon" aria-label=${`Edit ${g.label}`}
                      title=${`Edit ${g.label}`} onClick=${() => editEntry(g.written[0].id)}>
                      <${Icon} name="edit" size=${14} />
                    </button>
                  </li>`)}
              </ul>` : null}
          </section>` : null}

        ${/* The reassurance goes ABOVE the buttons, not after them: it is what
              makes the primary safe to press, and on a phone the action row is
              lifted out of the scrolling body and pinned to the sheet, so only
              the last child before it is guaranteed to be read.

              It also says what the primary is about to DO, because the primary
              does two things that are not on its label: it writes every
              suggestion still sitting in a field (they are the lawyer's answer
              — he read them and left them there), and it leaves anything blank
              as a draft. */''}
        <p class="closeout-note muted small">${noteFor({ going, staying, goingHours })}</p>

        <div class="ovl-actions">
          <button class="btn" onClick=${() => onClose(changedRef.current)}>
            Not yet<kbd class="ovl-kbd" aria-hidden="true">Esc</kbd>
          </button>
          ${/* THE PRIMARY CARRIES THE NUMBER, because it is the control that
                commits it — the same pattern the Export dialog already uses
                ("Download CSV 17"). */''}
          <button class="btn btn-primary co-primary" disabled=${busy}
            data-autofocus=${needs.length === 0 ? '' : undefined}
            onClick=${() => finalizeAndExport(false)}>
            <${Icon} name="lock" size=${16} /> Finalize & export${going > 0
    ? html`<span class="co-primary-count">${going}</span>` : null}<kbd class="ovl-kbd" aria-hidden="true">Enter</kbd>
          </button>
        </div>
      <//>`;
  } else if (phase === 'warn') {
    body = html`
      <${React.Fragment}>
        ${warnInfo.warnOnly.length > 0 ? html`
          <h3 class="closeout-warn-title">Finalize with warnings?</h3>
          <div class="closeout-warnlist">
            ${warnInfo.warnOnly.map((b) => html`
              <div key=${b.id} class="closeout-warnitem">
                <strong>${draftById[b.id] ? label(draftById[b.id]) : `entry #${b.id}`}</strong>
                <${ValidationList} findings=${b.warns} compact />
              </div>`)}
          </div>
          ${warnInfo.newDrafts ? html`
            <div class="closeout-warnitem">
              <strong>New drafts appeared while you reviewed</strong> — reopen
              close-out to include them (the warning ack applies to the whole
              day, so accepting now would finalize them unseen).
              <div class="closeout-warnlist" style=${{ marginTop: '6px' }}>
                ${warnInfo.newDrafts.map((e) => html`
                  <span key=${e.id} class="small">${e.cm ? e.cm.short_name : 'No matter yet'} · ${fmtHours(e.total)}h</span>`)}
              </div>
              <div class="ovl-actions">
                <button class="btn btn-primary" onClick=${() => load(false)}>Start the review again</button>
              </div>
            </div>` : html`
            <div class="ovl-actions">
              <button class="btn" onClick=${() => onClose(changedRef.current)}>Not yet</button>
              <button class="btn btn-primary" disabled=${busy} onClick=${() => finalizeAndExport(true)}>
                Accept warnings & finalize
              </button>
            </div>`}` : null}
        ${warnInfo.hard.length > 0 ? html`
          <h3 class="closeout-warn-title">Cannot finalize yet</h3>
          <div class="closeout-warnlist">
            ${warnInfo.hard.map((b) => html`
              <div key=${b.id} class="closeout-warnitem">
                <span>${draftById[b.id] ? label(draftById[b.id]) : `entry #${b.id}`}</span>
                <${ValidationList} findings=${b.blocks} compact />
                <button class="btn btn-sm" onClick=${() => editEntry(b.id)}>Edit</button>
              </div>`)}
          </div>` : null}
      <//>`;
  } else if (phase === 'blocked' || phase === 'closed') {
    // ONE SCREEN FOR "SOMETHING IS LEFT OVER", and it says what and why.
    // The wave-1 review, D12: the closed panel "reads '1 draft still need
    // attention' — grammar, and a state question: the sweep accepted 5 of 5 and
    // one draft is still outstanding, unexplained." It is explained now: each
    // leftover is named, with the validation finding that blocked it and a
    // button that opens it.
    const info = phase === 'closed' ? closedInfo : blockedInfo;
    const left = info.blocked || [];
    const n = left.length;
    title = phase === 'closed' ? 'Day closed' : 'Nothing exported yet';
    body = html`
      <${React.Fragment}>
        ${/* The title already says "Day closed"; this is the figure. */''}
        ${phase === 'closed' ? html`
          <p class="closeout-hours mono">${fmtHours(info.total)}h finalized · CSV downloaded</p>` : null}
        <p>
          ${phase === 'closed'
            ? `Everything else is finalized and in the CSV. ${n} ${n === 1 ? 'draft could' : 'drafts could'} not be finalized:`
            : `Nothing could be finalized, so nothing was exported. ${n} ${n === 1 ? 'draft needs' : 'drafts need'} attention:`}
        </p>
        <div class="closeout-warnlist">
          ${left.map((b) => html`
            <div key=${b.id} class="closeout-warnitem">
              <strong>${draftById[b.id] ? label(draftById[b.id]) : `entry #${b.id}`}</strong>
              ${b.blocks && b.blocks.length ? html`<${ValidationList} findings=${b.blocks} compact />` : null}
              <button class="btn btn-sm" onClick=${() => editEntry(b.id)}>
                <${Icon} name="edit" size=${14} /> Fix it now
              </button>
            </div>`)}
        </div>
        <p class="muted small">
          ${n === 1
            ? `It stays a draft on ${date}. Nothing was lost, and closing the day again once it is fixed exports just that one.`
            : `They stay as drafts on ${date}. Nothing was lost, and closing the day again once they are fixed exports just them.`}
        </p>
        <div class="ovl-actions">
          <button class="btn btn-primary" onClick=${() => onClose(true)}>Done</button>
        </div>
      <//>`;
  }

  // One dialog, every phase. The panel keeps `closeout-card` (this component's
  // own key handler and the e2e suite both select by it) and carries the phase
  // as data, where the backdrop used to.
  //
  // It also carries its own shape as data — the smoke suite reads it, and it is
  // the same split the panel says in words. `data-need` counts ROWS still
  // needing words (one per matter, so it always equals the number of .co-item
  // cards on screen); `data-ready` counts already-written ENTRIES wherever they
  // sit, including the ones now folded into a part-written matter's own card;
  // `data-filing` / `data-staying` are the one number and its complement.
  const shapeAttrs = {
    'data-phase': phase,
    'data-need': needs.length,
    'data-ready': filing.writtenEntries,
    'data-filing': filing.going,
    'data-staying': filing.staying,
  };
  return html`
    <${Overlay} title=${title} onClose=${() => onClose(changedRef.current)}
      className=${'closeout-card' + (phase === 'closed' ? ' closeout-closed' : '')}
      panelAttrs=${shapeAttrs}
      initialFocus=".co-item textarea">
      ${body}
    <//>`;
}
