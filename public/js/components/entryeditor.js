import { api, streamNdjson } from '/js/api.js';
import {
  html, useState, useEffect, useRef, useCallback, useDebounced,
  Overlay, Field, fmtHours, todayStr, emitToast, clientLabel, Confirm,
  ValidationList, fmtStamp, Spinner, Icon, splitTenthsEvenly, markJustFinalized,
} from '/js/ui.js';
import { CmPicker } from '/js/components/cmpicker.js';
import { GhostInput, useMatterSuggestions } from '/js/components/ghosttext.js';
import { useShortcuts, SaveShortcutBar } from '/js/components/shortcuts.js';
import { expandShortcuts } from '/js/lib/expand.js';
import { containsTimeAmounts } from '/js/lib/timeamounts.js';
import { insertNarrative } from '/js/lib/narrativejoin.js';
import { NarrativeHistory } from '/js/components/narrativehistory.js';
import {
  generateNarrative, parseNarrativeEdit, rebalanceHours, formatSuggestion, splitNarrativeSegments,
  alignTasksToClauses,
} from '/js/lib/narrativesync.js';

const blankLine = (duration = 0) => ({ task_code: '', duration, fragment: '' });
const tenth = (x) => Math.round((Number(x) || 0) * 10) / 10;
const isSubstantiveTask = (t) => !!((t.fragment || '').trim() || (t.task_code || '').trim() || Number(t.duration) > 0);

// Harvest's floating quick-add row (refs-v2/harvest-new-time-entry.mobile.jpg)
// in this app's units: it offers +0:15 / +0:30 / +1:00 / +8:00 because it bills
// in minutes; a law firm bills in tenths, so the four that matter are a tenth,
// a fifth, a half and an hour.
const QUICK_ADD = [0.1, 0.2, 0.5, 1];

// WHERE EACH FINDING BELONGS. The server returns one flat list; a message about
// the narrative rendered under the task lines is a message the reader has to
// hunt for, so every code is routed to the field it is about and anything
// unrecognised falls through to a list at the end (a new server code can never
// go silent).
const FIELD_OF = {
  narrative_empty: 'narrative',
  narrative_short: 'narrative',
  banned_phrase: 'narrative',
  missing_allocations: 'narrative',
  no_matter: 'matter',
  invalid_cm: 'matter',
  sum_mismatch: 'hours',
  zero_duration: 'hours',
  block_billing: 'hours',
  min_increment: 'hours',
  no_task_lines: 'tasks',
  custom_required: 'custom',
  custom_option: 'custom',
  custom_format: 'custom',
};
const findingsFor = (list, field) => (list || []).filter((f) => FIELD_OF[f.code] === field);
const findingsElsewhere = (list) => (list || []).filter((f) => !FIELD_OF[f.code]);

// Mirrors generateNarrative's per-segment DISPLAY transform (narrativesync.js):
// cleaned fragment, falling back to the task code, then 'Time'; segment 0 gets
// its first letter capitalized. applyAutoEdit diffs parsed AUTO-box segments
// against THIS — not the raw stored fragment — so a display-only difference
// (segment 0's capitalization, stripped trailing punctuation, a task-code
// fallback) reads as a non-change and never gets folded back into the task
// line as if the user had typed it.
function segmentDisplayText(t, k) {
  const clean = (s) => String(s || '').trim().replace(/[.;\s]+$/, '');
  const text = clean(t.fragment) || clean(t.task_code) || 'Time';
  return k === 0 ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

// Same suggestion pipeline StopChips uses (spec: chips must match exactly —
// fully-formed via formatSuggestion, deduped case-insensitively, max 3, never
// carrying a baked-in time amount).
function suggestChips(phrases) {
  const seen = new Set();
  const out = [];
  for (const raw of phrases || []) {
    if (containsTimeAmounts(raw)) continue;
    const text = formatSuggestion(raw);
    if (!text) continue;
    const k = text.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(text);
    if (out.length === 3) break;
  }
  return out;
}

// ============================================================================
// Entry editor — REBUILT AROUND THE NARRATIVE (teardown §16 / E7, wave-2 F1).
//
// What was measured here before: 18 controls, in the order Date · Client/Matter
// · Total hours · Billable · Task lines · Narrative, presented as a centred
// modal on desktop. At 390×844 the narrative <textarea> — the sentence a client
// reads and pays for, and the only reason anyone opens this dialog — sat at
// y=725, the fifteenth control, underneath the pinned action bar, and did not
// appear in the shipped screenshot at all. The first 700px were four fields a
// timer had already filled in correctly.
//
// The reference is refs-v2/harvest-new-time-entry.mobile.jpg, which does the
// same job in seven controls: label-left / value-right rows that open pickers
// rather than inline widgets, a duration stepper with a floating quick-add pill
// row, and one full-width primary. One thing is deliberately INVERTED from it —
// Harvest's note is optional and last; our narrative is the reason the dialog
// exists, so it is first and it holds the caret on open.
//
// The order, top to bottom:
//   narrative (focused, Reuse beside it) → hours (stepper + quick-add pills)
//   → matter ▸ → task lines, collapsed behind one "Split into tasks" control
//   until there are ≥2 → date ▸ / billable → everything rare behind "More".
//
// Nothing was deleted. Finalize, unlock, delete, the AI tasks and their undo,
// the even split, the audit log and the AI provenance line all live one tap
// deep in the "More" disclosure — which is inside the panel, inside the focus
// trap, and whose rows are full-width touch targets, rather than a portalled
// 28px popover the keyboard cannot reach.
//
// spec: {id} | {template:{date?,cm?}} | {copyFrom:id}
// ============================================================================
export function EntryEditor({ spec, settings, onClose }) {
  const [entry, setEntry] = useState(null);
  const [local, setLocal] = useState(null);
  const [saveState, setSaveState] = useState('idle');
  const [gate, setGate] = useState(null);
  const [audit, setAudit] = useState(null);
  const [taskCodes, setTaskCodes] = useState([]);
  const [codeOpenIdx, setCodeOpenIdx] = useState(null); // task-line index with its "+ code" select open
  const [ai, setAi] = useState(null);
  const [aiSplit, setAiSplit] = useState(false); // "split into tasks" — off by default (spec 3.3)
  const [aiBusy, setAiBusy] = useState(false);
  const [aiUndo, setAiUndo] = useState(null); // pre-rewrite {auto, narrative} snapshot, or null
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false); // "Reuse" — this matter's past narratives
  const [moreOpen, setMoreOpen] = useState(false);       // the overflow disclosure
  const [tasksOpen, setTasksOpen] = useState(false);     // "Split into tasks" has been used
  const [hoursActive, setHoursActive] = useState(false); // the quick-add pills are showing
  const [cmOpen, setCmOpen] = useState(false);           // the matter listbox is down
  const aiAbortRef = useRef(null); // in-flight narrate stream; aborted on new run/unmount
  const changedRef = useRef(false);
  const localRef = useRef(null);
  localRef.current = local;
  const entryRef = useRef(null);
  entryRef.current = entry;
  const hoursBoxRef = useRef(null);
  const gateRef = useRef(null);
  // The narrative claims the caret ONCE, on the render where it first appears.
  // React applies autoFocus during commit, which is how the caret gets there at
  // phone width too: the overlay primitive deliberately refuses to focus a text
  // field on a phone sheet (it would raise the keyboard over half the sheet)
  // but explicitly stands aside for "a dialog whose whole job IS type this now"
  // that claims focus itself — see keyboardShy() in components/overlay.js. This
  // is that dialog. The ref then stops the AUTO⇄manual swap, which remounts the
  // textarea, from yanking the caret back mid-edit.
  const caretClaimed = useRef(false);

  const increment = settings?.rounding?.increment || 0.1;

  // Ghost-text autocomplete (spec §6): deterministic phrasebook completions
  // for the picked matter; Tab accepts. No LLM anywhere in this path.
  const phrases = useMatterSuggestions(local?.cm?.id);

  // Custom fields for the picked matter (client-level + matter-level —
  // spec 2026-07-15). Values live in local.custom_values keyed by field id
  // and ride the normal autosave. They stay on the FACE of the form rather
  // than behind "More": a required one blocks finalize, and a field that can
  // stop the day closing must not be behind a disclosure.
  const [customFields, setCustomFields] = useState([]);
  useEffect(() => {
    const mid = local?.cm?.id;
    if (!mid) { setCustomFields([]); return undefined; }
    let alive = true;
    api.get(`/api/custom-fields/effective/${mid}`)
      .then((f) => { if (alive) setCustomFields(f); })
      .catch(() => { if (alive) setCustomFields([]); });
    return () => { alive = false; };
  }, [local?.cm?.id]);

  // Text-expansion shortcuts (spec §6): deterministic inline expansion in
  // fragment/narrative fields + in-flow capture from a text selection.
  const shortcuts = useShortcuts();
  const [selText, setSelText] = useState('');
  const expand = useCallback((text, caret) => expandShortcuts(text, caret, shortcuts), [shortcuts]);
  const onFieldSelect = useCallback((el) => setSelText(el.value.slice(el.selectionStart, el.selectionEnd)), []);

  useEffect(() => {
    api.get('/api/task-codes').then(setTaskCodes).catch(() => {});
    api.get('/api/ai/status').then(setAi).catch(() => {});
    return () => aiAbortRef.current?.abort(); // closing the editor cancels a live stream
  }, []);

  // load / create
  useEffect(() => {
    (async () => {
      try {
        if (spec.id) {
          const e = await api.get(`/api/entries/${spec.id}`);
          setEntry(e);
          setLocal(toLocal(e));
        } else if (spec.copyFrom) {
          const e = await api.post(`/api/entries/${spec.copyFrom}/copy`, { date: todayStr() });
          changedRef.current = true;
          emitToast('Entry copied — adjust the date if needed.');
          setEntry(e);
          setLocal(toLocal(e));
        } else {
          setLocal({
            date: spec.template.date || todayStr(),
            cm: spec.template.cm || null,
            billable: spec.template.cm ? !!spec.template.cm.billable : true,
            narrative: '',
            auto: true, // once ≥2 substantive lines exist, default to the live-AUTO box
            total: 0,
            tasks: [blankLine()],
            status: 'draft',
            ack_validation: 0,
            custom_values: {},
          });
        }
      } catch (e) {
        emitToast(e.message, { error: true });
        onClose(false);
      }
    })();
  }, []); // eslint-disable-line

  function toLocal(e) {
    return {
      date: e.date,
      cm: e.cm,
      billable: !!e.billable,
      narrative: e.narrative,
      // Mirrors today's semantics exactly: an entry that WAS auto (≥2
      // substantive lines) opens with the live-AUTO box on; a plain entry
      // opens manual. From there the toggle is the user's to flip.
      auto: !!e.narrative_auto,
      total: e.total_override != null ? e.total_override : e.total,
      tasks: e.tasks.length ? e.tasks.map((t) => ({ ...t })) : [blankLine()],
      status: e.status,
      ack_validation: e.ack_validation,
      custom_values: { ...(e.custom_values || {}) },
    };
  }

  const substantiveIdx = (local?.tasks || []).map((t, i) => i).filter((i) => isSubstantiveTask(local.tasks[i]));
  const substantiveLines = substantiveIdx.map((i) => local.tasks[i]);
  const taskBilling = local?.cm?.client_task_billing ?? 1;
  const generated = generateNarrative(substantiveLines, { increment, taskBilling });
  const autoAvailable = generated !== null;
  const autoOn = autoAvailable && !!local?.auto;
  const autoText = autoOn ? generated : null;
  const sum = tenth((local?.tasks || []).reduce((a, t) => a + (Number(t.duration) || 0), 0));
  const total = tenth(local?.total || 0);
  const remaining = tenth(total - sum);
  const finalized = local?.status === 'finalized';
  const seedText = autoOn ? (autoText || '') : (local?.narrative || '').trim();
  const suggestionChips = !autoOn && !String(local?.narrative || '').trim() ? suggestChips(phrases) : [];

  // The task-line editor is COLLAPSED until it has something to show: one
  // undivided line is the ordinary entry, and its hours are the entry total
  // already on screen. It opens for real work — two or more lines, a task code
  // that has to stay visible because the billing system wants it, or the
  // deliberate press of "Split into tasks".
  const hasTaskCode = (local?.tasks || []).some((t) => (t.task_code || '').trim());
  const tasksExpanded = tasksOpen || hasTaskCode
    || (local?.tasks || []).length > 1 || substantiveIdx.length >= 2;

  // Edit-through parser for the AUTO box (spec: two-way binding). Parse OK →
  // fold fragments/durations back into local.tasks in a single batch (only
  // the segments that actually changed, to dodge a feedback loop with the
  // controlled textarea re-deriving its value from the same tasks). Parse
  // null (a structural break — deleted paren, merged/added segment) → the
  // box detaches into a plain manual narrative, keeping exactly what's typed.
  function applyAutoEdit(text) {
    if (aiUndo) setAiUndo(null); // manual edit supersedes the last AI rewrite
    if (local.aiAuto) update({ aiAuto: false }); // a typed fragment is the attorney's
    // Emptying the box is not "typing over AUTO" — there is nothing left to
    // protect, so AUTO stays on and refills from the task lines instead of
    // detaching into a permanently blank manual narrative (2026-08-14).
    if (!String(text).trim()) { update({ narrative: '' }); return; }
    const parsed = parseNarrativeEdit(text, substantiveIdx.length, { taskBilling });
    if (!parsed) { update({ narrative: text, auto: false }); return; }
    let changed = false;
    const tasks = local.tasks.slice();
    substantiveIdx.forEach((origIdx, k) => {
      const seg = parsed.segments[k];
      const cur = tasks[origIdx];
      const patch = {};
      // Compare against the segment's DISPLAY text, not the raw fragment:
      // segment 0 renders capitalized (etc.), and writing that display
      // variant back would silently rewrite the stored fragment's casing on
      // any edit anywhere in the box.
      if (seg.fragment !== segmentDisplayText(cur, k)) patch.fragment = seg.fragment;
      if (seg.duration != null && tenth(seg.duration) !== tenth(cur.duration)) patch.duration = tenth(seg.duration);
      if (Object.keys(patch).length) { tasks[origIdx] = { ...cur, ...patch }; changed = true; }
    });
    if (changed) update({ tasks });
  }

  // ---------- persistence (single-flight chain) ----------

  const saveChain = useRef(Promise.resolve(null));

  const doPersist = useCallback(async () => {
    const l = localRef.current;
    const e = entryRef.current;
    if (!l || l.status === 'finalized') return e;
    if (!l.date) return e;
    // A brand-new entry still needs a matter before the first save; an
    // EXISTING matterless one (quick-timer entry) saves fine — cm_id is
    // simply omitted until the picker assigns one (2026-07-13).
    if (!l.cm && !e) return e;
    const substantiveTasks = l.tasks
      .filter((t) => (t.fragment || '').trim() || (t.task_code || '').trim() || Number(t.duration) > 0)
      .map((t) => ({ task_code: t.task_code, duration: Number(t.duration) || 0, fragment: t.fragment }));
    const body = {
      date: l.date,
      ...(l.cm ? { cm_id: l.cm.id } : {}),
      billable: l.billable ? 1 : 0,
      narrative: l.narrative,
      total_override: l.total > 0 ? tenth(l.total) : null,
      tasks: substantiveTasks,
      // AUTO on → live-generated, never detached (0). AUTO off on a ≥2-line
      // entry → the user has typed over/away from the AUTO box, so the
      // narrative is durably manual (1) and syncNarrative must stop
      // regenerating it. A single-line entry has no AUTO box to detach from,
      // so it always stays 0 (matches narrative_auto's own ≥2-line gate).
      // A blank narrative is never durably manual — the server would refill it
      // from the task lines anyway, so claiming the detach here only makes the
      // two disagree for one round trip.
      narrative_manual: (l.auto || !String(l.narrative || '').trim())
        ? 0 : (substantiveTasks.length >= 2 ? 1 : 0),
      // AI provenance (spec 2026-08-01 §5). The narrative counts as AI-written
      // only while it still reads EXACTLY as generated — the moment David
      // types over it the comparison fails, the flag clears, and the entry
      // joins the pool the model learns its voice from. The split path
      // derives the narrative from AI fragments, so AUTO standing untouched
      // over them counts too.
      // Only ASSERT provenance when this session actually generated something.
      // Reopening a flagged entry does not restore aiText, so sending a flat 0
      // here would silently clear the flag on an unrelated edit; omitting the
      // field leaves the server's rule in charge (text changed -> not AI).
      ...(l.aiText != null || l.aiAuto ? {
        narrative_ai: (l.aiText != null && l.narrative === l.aiText)
          || (l.aiAuto && l.auto) ? 1 : 0,
      } : {}),
      ...(l.aiBrief ? { ai_brief: l.aiBrief } : {}),
      // The model's original output, sent once when generated and never
      // withdrawn — a correction is only informative next to what it corrected.
      ...(l.aiText ? { ai_draft: l.aiText } : {}),
      custom_values: l.custom_values || {},
    };
    setSaveState('saving');
    try {
      const saved = e
        ? await api.patch(`/api/entries/${e.id}`, body)
        : await api.post('/api/entries', body);
      changedRef.current = true;
      entryRef.current = saved;
      setEntry(saved);
      setSaveState('saved');
      setLocal((cur) => {
        if (!cur) return cur;
        const next = { ...cur };
        // Only pull the server's (re-synced) narrative back in when the
        // CLIENT is itself in AUTO mode — saved.narrative_auto is purely
        // "≥2 substantive lines", oblivious to the user's manual-mode
        // choice, so trusting it here would silently clobber a just-typed
        // manual narrative on the very next autosave.
        if (cur.auto && saved.narrative_auto) next.narrative = saved.narrative;
        // A detached-but-blank narrative the server has just refilled from the
        // task lines: adopt the text and follow it back into AUTO, so the box
        // shows what the entry actually holds.
        else if (!String(cur.narrative || '').trim() && saved.narrative_auto && saved.narrative) {
          next.narrative = saved.narrative;
          next.auto = true;
        }
        return next;
      });
      return saved;
    } catch (err) {
      setSaveState('error');
      emitToast(err.message, { error: true });
      return entryRef.current;
    }
  }, []);

  const persist = useCallback(() => {
    saveChain.current = saveChain.current.then(doPersist, doPersist);
    return saveChain.current;
  }, [doPersist]);

  const [queueSave, cancelSave] = useDebounced(persist, 600);

  const update = useCallback((patch) => {
    setLocal((cur) => ({ ...cur, ...patch }));
    setGate(null);
    queueSave();
  }, [queueSave]);

  // Total is primary. With a single line, the line mirrors it.
  const updateTotal = useCallback((value) => {
    setLocal((cur) => {
      const t = Math.max(0, Number(value) || 0);
      const next = { ...cur, total: t };
      if (cur.tasks.length === 1) {
        next.tasks = [{ ...cur.tasks[0], duration: tenth(t) }];
      }
      return next;
    });
    setGate(null);
    queueSave();
  }, [queueSave]);

  const bumpTotal = useCallback((delta) => {
    updateTotal(Math.max(0, tenth((localRef.current?.total || 0) + delta)));
  }, [updateTotal]);

  const updateLine = useCallback((i, patch) => {
    setLocal((cur) => ({ ...cur, tasks: cur.tasks.map((t, j) => (j === i ? { ...t, ...patch } : t)) }));
    setGate(null);
    queueSave();
  }, [queueSave]);

  // Hours auto-rebalance (spec 4c): the edited line takes the new value; the
  // delta is absorbed by the OTHER lines (reverse order, floored at one
  // increment) so the lines' sum holds steady — a single line degenerates to
  // a plain take-the-new-value (and still writes through to the total, same
  // as before).
  const updateLineDuration = useCallback((i, value) => {
    setLocal((cur) => {
      const durations = cur.tasks.map((t) => Number(t.duration) || 0);
      const rebalanced = rebalanceHours(durations, i, value, { total: cur.total, increment });
      const tasks = cur.tasks.map((t, j) => ({ ...t, duration: rebalanced[j] }));
      const next = { ...cur, tasks };
      if (tasks.length === 1) next.total = tenth(tasks[0].duration);
      return next;
    });
    setGate(null);
    queueSave();
  }, [queueSave, increment]);

  const addLine = useCallback(() => {
    setLocal((cur) => {
      const s = cur.tasks.reduce((a, t) => a + (Number(t.duration) || 0), 0);
      const rem = Math.max(0, tenth((cur.total || 0) - s));
      return { ...cur, tasks: [...cur.tasks, blankLine(rem)] };
    });
    queueSave();
  }, [queueSave]);

  // Literal split (2026-07-14 feedback): divide the EXISTING narrative into
  // task lines at semicolons — wording kept verbatim, no AI. Trailing "(x.x)"
  // amounts become that line's hours; the rest of the total spreads evenly.
  // AUTO comes on so the narrative now regenerates from the (identical)
  // fragments and stays in sync with further line edits.
  function splitFromNarrative() {
    const segs = splitNarrativeSegments(seedText);
    if (segs.length < 2) return false;
    const explicitSum = tenth(segs.reduce((a, s) => a + (s.duration || 0), 0));
    const unknownIdx = segs.map((s, i) => (s.duration == null ? i : -1)).filter((i) => i >= 0);
    const pool = Math.max(0, tenth((total || sum || explicitSum) - explicitSum));
    const even = splitTenthsEvenly(pool, Math.max(1, unknownIdx.length));
    const durations = segs.map((s, i) => (
      s.duration != null ? tenth(s.duration) : even[unknownIdx.indexOf(i)] || 0));
    update({
      tasks: segs.map((s, i) => ({ task_code: '', fragment: s.fragment, duration: durations[i] })),
      auto: true,
      ...(total > 0 ? {} : { total: tenth(durations.reduce((a, b) => a + b, 0)) }),
    });
    return true;
  }

  // The one control that stands in for the whole task-line editor while an
  // entry is undivided. It does whichever kind of split is available: a
  // narrative already written in semicolon-separated clauses divides at them,
  // verbatim; anything else opens the editor with a second line to fill.
  function beginSplit() {
    setTasksOpen(true);
    if (substantiveIdx.length <= 1 && splitFromNarrative()) return;
    addLine();
  }

  const splitEvenly = useCallback(() => {
    setLocal((cur) => {
      const parts = splitTenthsEvenly(cur.total || 0, cur.tasks.length);
      return { ...cur, tasks: cur.tasks.map((t, i) => ({ ...t, duration: parts[i] })) };
    });
    queueSave();
  }, [queueSave]);

  async function flushAndClose() {
    cancelSave();
    await persist();
    onClose(changedRef.current);
  }

  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        flushAndClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []); // eslint-disable-line

  // A refused finalize must be READ, not hunted for. The gate renders as the
  // panel's first block and the scroll box goes back to the top with it — the
  // wave-1 measurement was a blocking message rendered in a 17px sliver under
  // the pinned action row at 390×844.
  useEffect(() => {
    if (!gate) return;
    const body = gateRef.current?.closest('.ovl-body');
    if (body) body.scrollTop = 0;
    gateRef.current?.focus?.();
  }, [gate]);

  // ---------- actions ----------

  async function finalize(ack) {
    cancelSave();
    const e = await persist();
    if (!e) { emitToast('Pick a CM and add time first.', { error: true }); return; }
    try {
      await api.post(`/api/entries/${e.id}/finalize`, ack ? { ack: true } : {});
      markJustFinalized(e.id); // one lock pulse on the list chip after close
      changedRef.current = true;
      emitToast('Finalized', {
        actionLabel: 'Unlock',
        action: async () => { await api.post(`/api/entries/${e.id}/unlock`); },
      });
      onClose(true);
    } catch (err) {
      if (err.status === 422) setGate(err.body);
      else emitToast(err.message, { error: true });
    }
  }

  async function unlock() {
    const e = entryRef.current;
    await api.post(`/api/entries/${e.id}/unlock`);
    changedRef.current = true;
    const fresh = await api.get(`/api/entries/${e.id}`);
    setEntry(fresh);
    setLocal(toLocal(fresh));
    emitToast('Unlocked — edits are audit-logged.');
  }

  async function del() {
    const e = entryRef.current;
    cancelSave();
    if (e) {
      await api.del(`/api/entries/${e.id}`);
      emitToast('Entry deleted', {
        actionLabel: 'Undo',
        action: async () => { await api.post(`/api/entries/${e.id}/restore`); },
      });
    }
    onClose(true);
  }

  async function loadAudit() {
    const e = entryRef.current;
    if (!e) return;
    setAudit(await api.get(`/api/entries/${e.id}/audit`));
  }

  // Structured task split — the only remaining /ai/expand caller, gated
  // behind the "split into tasks" checkbox (default unchecked).
  //
  // Two different questions wear the same button (2026-08-11 report).
  //
  // A seed the attorney has ALREADY divided — an AUTO narrative, which writes
  // a "(x.x)" per clause — needs no splitting; it needs each clause rewritten.
  // Sending `clauses` asks the server for exactly that, one task per line, and
  // the attorney's own hours ride along untouched. Asking the model to work
  // the division out again is what dropped a clause on a third of runs,
  // reordered them on others, and merged two into one.
  //
  // Shorthand carries no allocation, so it goes whole and the model does the
  // splitting — that is the case where there is something to split.
  // alignTasksToClauses is then only a backstop, for a model answer that came
  // back with fewer tasks than the attorney described.
  async function aiExpand(seed) {
    setAiBusy(true);
    try {
      const clauses = splitNarrativeSegments(seed);
      const preSplit = containsTimeAmounts(seed) && clauses.length >= 2;
      const r = await api.post('/api/ai/expand', {
        brief: seed, totalHours: total > 0 ? total : (sum > 0 ? sum : undefined),
        cm_id: local?.cm?.id, // lets the server attach the matter's people/phrases
        ...(preSplit ? { clauses: clauses.map((c) => c.fragment) } : {}),
      });
      // A pre-split seed must come back with exactly one task per clause, so
      // any other count falls back to matching. Shorthand only falls back when
      // the model came back SHORT — coming back with more tasks than clauses
      // is a legitimate finer split, and capping it would throw work away.
      const mismatch = preSplit
        ? r.tasks.length !== clauses.length
        : (clauses.length >= 2 && r.tasks.length < clauses.length);
      const resultTasks = mismatch
        ? alignTasksToClauses(clauses, r.tasks)
        : (preSplit
          // 1:1 by position — the contract the server asked for, and the count
          // matches, so the attorney's allocation maps straight across.
          ? r.tasks.map((t, i) => ({ ...t, hours: clauses[i].duration ?? t.hours }))
          : r.tasks);
      if (resultTasks.length > 0) {
        const even = splitTenthsEvenly(total || sum, resultTasks.length);
        setTasksOpen(true);
        update({
          tasks: resultTasks.map((t, i) => ({
            task_code: t.task_code, fragment: t.fragment,
            duration: t.hours != null ? t.hours : even[i] || 0,
          })),
          // fragments are full narrative clauses now — let AUTO regenerate
          // the narrative from them so it stays as robust as the split
          auto: true,
          aiAuto: true, aiBrief: seed, aiText: null,
        });
      } else {
        update({ narrative: r.narrative, aiText: r.narrative, aiBrief: seed, aiAuto: false });
      }
    } catch (e) {
      emitToast(e.body?.message || e.message, { error: true });
    } finally {
      setAiBusy(false);
    }
  }

  // Streamed narration (spec §6): tokens land in the narrative field live,
  // replacing the blocking spinner. Each chunk goes through update(), so the
  // normal debounced autosave applies. Starting a new run aborts any
  // in-flight one (regenerate mid-stream), and unmount aborts too —
  // otherwise the server never sees a disconnect and Ollama keeps generating
  // for up to 180s. A superseded run's callbacks and state writes are
  // ignored so it can't fight the run that replaced it.
  async function aiNarrate(mode, seed) {
    aiAbortRef.current?.abort();
    const ctrl = new AbortController();
    aiAbortRef.current = ctrl;
    setAiBusy(true);
    try {
      let acc = '';
      await streamNdjson('/api/ai/narrate', {
        mode, brief: seed, narrative: seed,
        cm_id: local?.cm?.id, // lets the server attach the matter's people/phrases
        // grounding (2026-07-14): the prose must scale to the recorded time
        totalHours: total > 0 ? total : (sum > 0 ? sum : undefined),
      }, (m) => {
        if (aiAbortRef.current !== ctrl) return; // superseded — drop late lines
        if (m.error) throw new Error(m.message || m.error);
        if (m.token) { acc += m.token; update({ narrative: acc }); }
        if (m.done) update({ narrative: m.narrative, aiText: m.narrative, aiBrief: seed, aiAuto: false });
      }, ctrl.signal);
    } catch (e) {
      if (e.name !== 'AbortError') emitToast(e.body?.message || e.message, { error: true });
    } finally {
      if (aiAbortRef.current === ctrl) setAiBusy(false);
    }
  }

  // Expand / Shorten / Rewrite all seed from the CURRENT narrative text. AI
  // output is always manual text, so using it while AUTO is on first flips
  // AUTO off and takes the generated text as the seed — one click, no dead end.
  //
  // The three used to be a split button plus a dropdown plus a checkbox — the
  // teardown's "three levels of configuration on a feature that should be one
  // button". They are three plainly-labelled buttons inside "More" now: each
  // task costs one tap instead of two, and the remembered-last-task machinery
  // that existed only to make the dropdown bearable is gone with it.
  function runAi(kind) {
    const seed = seedText;
    if (!seed) return;
    // Snapshot what the narrative field shows right now so the rewrite can be
    // undone (2026-07-16 / 2026-07-20 feedback). Restores AUTO mode too.
    setAiUndo({ auto: autoOn, narrative: local.narrative });
    if (autoOn) update({ auto: false, narrative: seed });
    if (kind === 'expand') { if (aiSplit) aiExpand(seed); else aiNarrate('draft', seed); return; }
    if (kind === 'shorten') { aiNarrate('shorter', seed); return; }
    aiNarrate('regenerate', seed);
  }

  // Fold a narrative borrowed from this matter's history into the box. Same
  // one-click rule the AI path uses: borrowed text is the attorney's own
  // narrative now, so AUTO steps aside and hands over what it had generated
  // as the text being added to — no dead end, nothing silently overwritten.
  function insertFromHistory(text) {
    if (aiUndo) setAiUndo(null);
    const base = autoOn ? (autoText || '') : local.narrative;
    update({ auto: false, aiAuto: false, narrative: insertNarrative(base, text) });
  }

  // Restore the pre-rewrite narrative (and AUTO state). One-shot: the button
  // vanishes after use or once the user edits the field manually.
  function undoAi() {
    if (!aiUndo) return;
    update({ auto: aiUndo.auto, narrative: aiUndo.narrative });
    setAiUndo(null);
  }

  // ---------- render ----------

  // `.modal` / `.modal-wide` stay as behavioural hooks (the e2e suite and a few
  // feature modules select by them); `.ed-panel` is what turns the same panel
  // into a right-hand side panel at ≥768px while the phone keeps the shared
  // primitive's bottom sheet. One component, two shapes — never two components.
  const PANEL = 'modal modal-wide ed-panel';

  if (!local) {
    return html`
      <${Overlay} title="Time entry" size="lg" className=${PANEL}
        onClose=${() => onClose(changedRef.current)}><${Spinner} /><//>`;
  }

  const validation = entry ? entry.validation : [];
  const narrativeFindings = findingsFor(validation, 'narrative');
  const aiReady = ai && ai.enabled && ai.reachable && !finalized;
  // Claim the caret on the render where the narrative field first exists, and
  // never again (see caretClaimed above).
  const claimCaret = !finalized && !caretClaimed.current;
  if (claimCaret) caretClaimed.current = true;

  const narrativeField = autoOn ? html`
    <span class="auto-badge">AUTO</span>
    <textarea value=${autoText || ''} disabled=${finalized} spellCheck=${true}
      autoFocus=${claimCaret} aria-label="Narrative"
      onInput=${(e) => applyAutoEdit(e.target.value)}></textarea>` : html`
    <${GhostInput} multiline rows=${4} value=${local.narrative} disabled=${finalized}
      suggestions=${phrases} expand=${expand} onSelectionChange=${onFieldSelect}
      autoFocus=${claimCaret} aria-label="Narrative"
      placeholder="What did you do? (specific verbs — banned vague phrases are flagged)"
      onChange=${(v) => { if (aiUndo) setAiUndo(null); update({ narrative: v }); }} />`;

  return html`
    <${Overlay} size="lg" className=${PANEL} onClose=${flushAndClose}
      initialFocus=${local ? '.narrative-preview textarea' : null}
      title=${finalized ? 'Time entry (finalized)' : entry ? 'Edit time entry' : 'New time entry'}>

      ${gate ? html`
        <div class="ed-gate" role="alert" tabIndex=${-1} ref=${gateRef}>
          <strong>${gate.blocks.length ? 'Cannot finalize yet' : 'Finalize with warnings?'}</strong>
          <${ValidationList} findings=${[...gate.blocks, ...gate.warns]} compact=${true} />
          <div class="ed-gate-actions">
            <button type="button" class="btn btn-sm" onClick=${() => setGate(null)}>Dismiss</button>
            ${gate.blocks.length === 0 ? html`
              <button type="button" class="btn btn-sm btn-primary" onClick=${() => finalize(true)}>Finalize anyway</button>` : null}
          </div>
        </div>` : null}

      ${/* 1 — THE NARRATIVE. First, focused, with Reuse beside it. */''}
      <section class="ed-narrative">
        <div class="ed-narrative-head">
          <h3 class="ed-label">Narrative</h3>
          ${autoAvailable ? html`
            <button type="button" class=${'auto-toggle-chip' + (autoOn ? ' on' : '')} disabled=${finalized}
              aria-pressed=${autoOn ? 'true' : 'false'}
              title=${autoOn ? 'Turn off — edit narrative freely' : 'Turn on — regenerate from task lines'}
              onClick=${() => update({ auto: !local.auto })}>AUTO</button>` : null}
          <div class="spacer"></div>
          ${local.cm && !finalized ? html`
            <button type="button" class="btn btn-sm ed-reuse"
              title="Reuse a narrative from this matter's recent entries"
              onClick=${() => setHistoryOpen(true)}>
              <${Icon} name="history" size=${14} /> Reuse</button>` : null}
        </div>
        <div class="narrative-preview">${narrativeField}</div>
        ${!finalized && suggestionChips.length > 0 ? html`
          <div class="editor-suggest-chips">
            ${suggestionChips.map((t) => html`
              <button key=${t} type="button" title=${t}
                onClick=${() => { if (aiUndo) setAiUndo(null); update({ narrative: t }); }}>${t}</button>`)}
          </div>` : null}
        <${ValidationList} findings=${narrativeFindings} compact=${true} />
        <${SaveShortcutBar} selection=${selText} />
      </section>

      ${/* 2 — HOURS. Stepper, plus Harvest's quick-add pill row, which appears
            while the field is being worked on and gets out of the way when it
            is not — exactly as it does in the reference shot, where the pills
            ride above the keyboard over the duration field. Typing an exact
            figure is untouched. */''}
      <div class="ed-hours" ref=${hoursBoxRef}
        onFocus=${() => { if (!finalized) setHoursActive(true); }}
        onBlur=${() => requestAnimationFrame(() => {
          const box = hoursBoxRef.current;
          if (box && !box.contains(document.activeElement)) setHoursActive(false);
        })}>
        <div class="ed-row">
          <span class="ed-row-label" id="ed-hours-label">Hours</span>
          <div class="ed-stepper">
            <button type="button" class="ed-step" aria-label=${`Subtract ${fmtHours(increment, increment)} hours`}
              disabled=${finalized || total <= 0} onClick=${() => bumpTotal(-increment)}>
              <${Icon} name="minus" size=${16} /></button>
            <input type="number" min="0" step=${increment} class="mono total-input"
              inputMode="decimal" aria-labelledby="ed-hours-label"
              value=${local.total || ''} placeholder="0.0" disabled=${finalized}
              onInput=${(e) => updateTotal(e.target.value)} />
            <button type="button" class="ed-step" aria-label=${`Add ${fmtHours(increment, increment)} hours`}
              disabled=${finalized} onClick=${() => bumpTotal(increment)}>
              <${Icon} name="plus" size=${16} /></button>
          </div>
        </div>
        ${hoursActive && !finalized ? html`
          <div class="ed-pills" role="group" aria-label="Add time">
            ${QUICK_ADD.map((h) => html`
              <button key=${h} type="button" class="ed-pill"
                onClick=${() => bumpTotal(h)}>+${fmtHours(h, 0.1)}</button>`)}
          </div>` : null}
        <${ValidationList} findings=${findingsFor(validation, 'hours')} compact=${true} />
      </div>

      ${/* 3 — MATTER. A label/value row that opens the picker; while the
            listbox is down the row hands the whole width to the search box,
            because a 270px value cell is not somewhere to search from. */''}
      <div class=${'ed-row ed-row-matter' + (cmOpen || !local.cm ? ' searching' : '')}>
        <span class="ed-row-label">Matter</span>
        <div class="ed-row-value">
          <${CmPicker} value=${local.cm} variant="row" disabled=${finalized}
            onOpenChange=${setCmOpen}
            onChange=${(cm) => update({ cm, billable: !!cm.billable })} />
          ${local.cm ? html`<span class="cm-client-label muted small">${clientLabel(local.cm)}</span>` : null}
        </div>
      </div>
      <${ValidationList} findings=${findingsFor(validation, 'matter')} compact=${true} />

      ${/* 4 — TASK LINES, behind one control until there are two or more. */''}
      ${tasksExpanded ? html`
        <div class="ed-tasks">
          <div class="ed-tasks-head">
            <h3 class="ed-label">Task lines</h3>
            <span class="muted small">divide the total among tasks</span>
            <div class="spacer"></div>
            ${remaining !== 0 && total > 0 && local.tasks.length > 0 ? html`
              <span class=${'alloc-chip' + (remaining < 0 ? ' over' : '')}>
                ${remaining > 0
                  ? `${fmtHours(remaining, increment)}h unallocated`
                  : `${fmtHours(-remaining, increment)}h over-allocated`}
              </span>` : null}
          </div>
          <div class="task-lines">
            ${local.tasks.map((t, i) => html`
              <div key=${i} class="task-line">
                <div class="task-code-cell">
                  ${t.task_code ? html`
                    <span class="task-code-chip">
                      <span>${t.task_code}</span>
                      <button type="button" title="Remove task code" disabled=${finalized}
                        onClick=${() => updateLine(i, { task_code: '' })}><${Icon} name="x" size=${10} /></button>
                    </span>` : (codeOpenIdx === i ? html`
                    <select autoFocus disabled=${finalized} aria-label="Task code"
                      onChange=${(e) => { updateLine(i, { task_code: e.target.value }); setCodeOpenIdx(null); }}
                      onBlur=${() => setCodeOpenIdx(null)}>
                      <option value="">(task)</option>
                      ${taskCodes.map((c) => html`<option key=${c.id} value=${c.name}>${c.name}</option>`)}
                    </select>` : html`
                    <button type="button" class="task-code-add" disabled=${finalized}
                      onClick=${() => setCodeOpenIdx(i)}>+ code</button>`)}
                </div>
                <input type="number" min="0" step=${increment} value=${t.duration || ''}
                  placeholder="0.0" disabled=${finalized} class="mono" aria-label="Task hours"
                  onInput=${(e) => updateLineDuration(i, e.target.value)} />
                <${GhostInput} value=${t.fragment} suggestions=${phrases} disabled=${finalized}
                  expand=${expand} onSelectionChange=${onFieldSelect} aria-label="Task narrative fragment"
                  placeholder=${autoAvailable ? 'narrative fragment for this task' : 'optional fragment (used if you add more lines)'}
                  onChange=${(v) => updateLine(i, { fragment: v })} />
                <div class="task-line-actions">
                  <div class="reorder">
                    <button type="button" title="Move up" disabled=${finalized || i === 0}
                      onClick=${() => update({ tasks: swap(local.tasks, i, i - 1) })}><${Icon} name="chevronUp" size=${11} /></button>
                    <button type="button" title="Move down" disabled=${finalized || i === local.tasks.length - 1}
                      onClick=${() => update({ tasks: swap(local.tasks, i, i + 1) })}><${Icon} name="chevronDown" size=${11} /></button>
                  </div>
                  <button type="button" class="btn btn-ghost btn-sm" title="Remove line" disabled=${finalized}
                    onClick=${() => {
                      setCodeOpenIdx(null); // indexes shift on delete — never leave a stale open select
                      update({ tasks: local.tasks.filter((_, j) => j !== i) });
                    }}><${Icon} name="x" size=${14} /></button>
                </div>
              </div>`)}
            <div class="ed-tasks-foot">
              <button type="button" class="btn btn-sm" disabled=${finalized} onClick=${addLine}>
                <${Icon} name="plus" size=${14} /> Add task line
              </button>
              <div class="spacer"></div>
              <span class="muted small">Allocated <strong class="mono">${fmtHours(sum, increment)}h</strong>${' of '}<strong class="mono">${fmtHours(total, increment)}h</strong></span>
            </div>
          </div>
          <${ValidationList} findings=${findingsFor(validation, 'tasks')} compact=${true} />
        </div>` : html`
        <div class="ed-split-row">
          <button type="button" class="btn ed-split" disabled=${finalized} onClick=${beginSplit}
            title="Divide this entry into task-coded lines. A narrative already written in semicolon-separated clauses splits at them, keeping your wording exactly.">
            <${Icon} name="clipboard" size=${14} /> Split into tasks
          </button>
          <${ValidationList} findings=${findingsFor(validation, 'tasks')} compact=${true} />
        </div>`}

      ${/* 5 — DATE and BILLABLE. Compact rows: a timer set both correctly. */''}
      <div class="ed-row">
        <label class="ed-row-label" for="ed-date">Date</label>
        <input id="ed-date" type="date" class="ed-row-control" value=${local.date} disabled=${finalized}
          onChange=${(e) => update({ date: e.target.value })} />
      </div>
      <label class="ed-row ed-row-check">
        <span class="ed-row-label">Billable</span>
        <input type="checkbox" checked=${local.billable} disabled=${finalized}
          onChange=${(e) => update({ billable: e.target.checked })} />
      </label>

      ${customFields.length > 0 ? html`
        <div class="custom-fields-row">
          ${customFields.map((f) => html`
            <${Field} key=${f.id} label=${f.name + (f.required ? ' *' : '')}>
              ${f.type === 'select' ? html`
                <select value=${local.custom_values?.[f.id] || ''} disabled=${finalized}
                  onChange=${(e) => update({ custom_values: { ...local.custom_values, [f.id]: e.target.value } })}>
                  <option value=""></option>
                  ${f.options.map((o) => html`<option key=${o} value=${o}>${o}</option>`)}
                </select>` : html`
                <input type="text" value=${local.custom_values?.[f.id] || ''} disabled=${finalized}
                  placeholder=${f.pattern_hint || ''}
                  onInput=${(e) => update({ custom_values: { ...local.custom_values, [f.id]: e.target.value } })} />`}
            <//>`)}
          <${ValidationList} findings=${findingsFor(validation, 'custom')} compact=${true} />
        </div>` : null}

      <${ValidationList} findings=${findingsElsewhere(validation)} compact=${true} />

      ${/* 6 — EVERYTHING RARE. One disclosure, inside the panel and inside the
            focus trap, with full-width touch rows — not a portalled popover the
            keyboard cannot reach. Nothing here was deleted; all of it is one
            tap deep instead of on the face of the form. */''}
      <div class="ed-more">
        <button type="button" class="ed-more-toggle" data-ed-more
          aria-expanded=${moreOpen ? 'true' : 'false'} aria-controls="ed-more-panel"
          onClick=${() => setMoreOpen((v) => !v)}>
          <${Icon} name="more" size=${16} />
          <span>More</span>
          <${Icon} name=${moreOpen ? 'chevronUp' : 'chevronDown'} size=${14} />
        </button>
        ${moreOpen ? html`
          <div class="ed-more-panel" id="ed-more-panel">
            ${entry && (entry.narrative_ai || entry.ai_draft) ? html`
              <p class="ed-prov muted small">
                <${Icon} name="sparkles" size=${13} />
                ${entry.narrative_ai
                  ? ' This narrative is exactly as the assistant wrote it.'
                  : ' The assistant drafted this narrative; you edited it.'}
                ${entry.ai_brief ? html`<span class="ed-prov-brief"> From: “${entry.ai_brief}”</span>` : null}
              </p>` : null}

            ${aiReady ? html`
              <div class="ed-more-group" role="group" aria-label="AI assist">
                <span class="ed-more-group-label">AI assist</span>
                <div class="ed-more-buttons">
                  <button type="button" class="btn btn-sm" disabled=${!seedText || aiBusy}
                    onClick=${() => runAi('expand')}>
                    <${Icon} name="sparkles" size=${14} /> ${aiBusy ? 'Working…' : 'Expand'}</button>
                  <button type="button" class="btn btn-sm" disabled=${!seedText || aiBusy}
                    onClick=${() => runAi('shorten')}>Shorten</button>
                  <button type="button" class="btn btn-sm" disabled=${!seedText || aiBusy}
                    onClick=${() => runAi('rewrite')}>Rewrite</button>
                </div>
                <label class="checkbox-row small">
                  <input type="checkbox" checked=${aiSplit} onChange=${(e) => setAiSplit(e.target.checked)} />
                  Expand splits the entry into task lines
                </label>
              </div>` : null}

            ${aiUndo && !finalized ? html`
              <button type="button" class="ed-more-item" disabled=${aiBusy} onClick=${undoAi}>
                <${Icon} name="history" size=${16} /> Undo the AI rewrite</button>` : null}

            ${!finalized && local.tasks.length > 1 && total > 0 ? html`
              <button type="button" class="ed-more-item" onClick=${splitEvenly}>
                <${Icon} name="layout" size=${16} /> Split hours evenly across ${local.tasks.length} lines</button>` : null}

            ${finalized ? html`
              <button type="button" class="ed-more-item" onClick=${unlock}>
                <${Icon} name="unlock" size=${16} /> Unlock to edit</button>` : html`
              <button type="button" class="ed-more-item" onClick=${() => finalize(false)}>
                <${Icon} name="lock" size=${16} /> Finalize this entry</button>`}

            ${entry && !finalized ? html`
              <button type="button" class="ed-more-item danger" onClick=${() => setConfirmDelete(true)}>
                <${Icon} name="trash" size=${16} /> Delete entry</button>` : null}

            ${entry && entry.ever_finalized ? html`
              <details class="ed-audit" onToggle=${(e) => { if (e.target.open && !audit) loadAudit(); }}>
                <summary>Audit history</summary>
                ${audit === null ? html`<${Spinner} />` : audit.length === 0
                  ? html`<p class="muted small">No changes recorded.</p>`
                  : html`<div class="table-wrap"><table class="tk">
                      <thead><tr><th>When</th><th>Action</th><th>Detail</th></tr></thead>
                      <tbody>${audit.map((a) => html`
                        <tr key=${a.id}>
                          <td class="small">${fmtStamp(a.created_at)}</td>
                          <td class="small">${a.action}</td>
                          <td class="small mono">${JSON.stringify(a.detail)}</td>
                        </tr>`)}</tbody>
                    </table></div>`}
              </details>` : null}
          </div>` : null}
      </div>

      ${historyOpen && local.cm ? html`
        <${NarrativeHistory} cmId=${local.cm.id}
          cmLabel=${local.cm.short_name || local.cm.cm_number}
          onInsert=${insertFromHistory} onClose=${() => setHistoryOpen(false)} />` : null}

      ${/* The dialog's action row. .ovl-actions is what the phone sheet pins
            above the safe-area inset and what the desktop side panel pins to
            its own bottom edge (editor.css), so the save state and the one
            committing action are on screen at every scroll position — which is
            what "legible without hunting for it" has to mean in a panel that
            scrolls. `Done` rather than `Save & close`: the form autosaves, so
            there was never a save to commit; the button closes. */''}
      <div class="ovl-actions">
        <span class=${'saving-dot state-' + saveState} aria-live="polite">
          ${saveState === 'saving' ? html`<${Icon} name="refresh" size=${13} /> Saving…`
            : saveState === 'saved' ? html`<${Icon} name="check" size=${13} /> Saved`
            : saveState === 'error' ? html`<${Icon} name="alert" size=${13} /> Not saved`
            : 'Autosaves'}
        </span>
        ${saveState === 'error' ? html`
          <button type="button" class="btn btn-sm" onClick=${() => persist()}>Retry</button>` : null}
        <div class="spacer"></div>
        <button type="button" class="btn btn-primary ed-done" onClick=${flushAndClose}>
          Done<kbd class="ovl-kbd">Ctrl ↵</kbd>
        </button>
      </div>
      ${confirmDelete ? html`
        <${Confirm} title="Delete entry" danger confirmLabel="Delete"
          message=${`Delete this ${fmtHours(total, increment)}h entry${local.cm ? ` for ${local.cm.short_name}` : ''}? You'll have a few seconds to undo from the toast.`}
          onConfirm=${del}
          onClose=${() => setConfirmDelete(false)} />` : null}
    <//>`;
}

function swap(arr, i, j) {
  const next = arr.slice();
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}
