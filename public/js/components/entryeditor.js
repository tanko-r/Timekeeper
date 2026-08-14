import { api, streamNdjson } from '/js/api.js';
import {
  html, useState, useEffect, useRef, useCallback, useDebounced,
  Modal, Field, fmtHours, todayStr, emitToast, clientLabel, ContextMenu, Confirm,
  ValidationList, fmtStamp, Spinner, Icon, splitTenthsEvenly, markJustFinalized,
} from '/js/ui.js';
import { CmPicker } from '/js/components/cmpicker.js';
import { GhostInput, useMatterSuggestions } from '/js/components/ghosttext.js';
import { useShortcuts, SaveShortcutBar } from '/js/components/shortcuts.js';
import { expandShortcuts } from '/js/lib/expand.js';
import { containsTimeAmounts } from '/js/lib/timeamounts.js';
import {
  generateNarrative, parseNarrativeEdit, rebalanceHours, formatSuggestion, splitNarrativeSegments,
  alignTasksToClauses,
} from '/js/lib/narrativesync.js';

const blankLine = (duration = 0) => ({ task_code: '', duration, fragment: '' });
const tenth = (x) => Math.round((Number(x) || 0) * 10) / 10;
const isSubstantiveTask = (t) => !!((t.fragment || '').trim() || (t.task_code || '').trim() || Number(t.duration) > 0);

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

// Entry editor. The entry TOTAL is primary (typed or from a timer); task lines
// divide it. spec: {id} | {template:{date?,cm?}} | {copyFrom:id}
export function EntryEditor({ spec, settings, onClose }) {
  const [entry, setEntry] = useState(null);
  const [local, setLocal] = useState(null);
  const [saveState, setSaveState] = useState('idle');
  const [gate, setGate] = useState(null);
  const [audit, setAudit] = useState(null);
  const [taskCodes, setTaskCodes] = useState([]);
  const [codeOpenIdx, setCodeOpenIdx] = useState(null); // task-line index with its "+ code" select open
  const [ai, setAi] = useState(null);
  const [aiMenu, setAiMenu] = useState(null); // {x, y} — the AI dropdown's position
  const [aiSplit, setAiSplit] = useState(false); // "split into tasks" — off by default (spec 3.3)
  // Remembers the last AI task picked (2026-08-03 feedback) so the main
  // button re-runs it directly; a caret still opens the full menu.
  const [lastAiTask, setLastAiTaskState] = useState(() => {
    const v = localStorage.getItem('tk:lastAiTask');
    return ['expand', 'shorten', 'rewrite'].includes(v) ? v : 'expand';
  });
  const setLastAiTask = (v) => { localStorage.setItem('tk:lastAiTask', v); setLastAiTaskState(v); };
  const [aiBusy, setAiBusy] = useState(false);
  const [aiUndo, setAiUndo] = useState(null); // pre-rewrite {auto, narrative} snapshot, or null
  const [confirmDelete, setConfirmDelete] = useState(false);
  const aiAbortRef = useRef(null); // in-flight narrate stream; aborted on new run/unmount
  const changedRef = useRef(false);
  const localRef = useRef(null);
  localRef.current = local;
  const entryRef = useRef(null);
  entryRef.current = entry;

  const increment = settings?.rounding?.increment || 0.1;

  // Ghost-text autocomplete (spec §6): deterministic phrasebook completions
  // for the picked matter; Tab accepts. No LLM anywhere in this path.
  const phrases = useMatterSuggestions(local?.cm?.id);

  // Custom fields for the picked matter (client-level + matter-level —
  // spec 2026-07-15). Values live in local.custom_values keyed by field id
  // and ride the normal autosave.
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
    if (segs.length < 2) return;
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

  // Dropdown entry point (spec 3.3): Expand/Shorten/Rewrite all seed from the
  // CURRENT narrative text. AI output is always manual text, so using it
  // while AUTO is on first flips AUTO off and takes the generated text as
  // the seed — one click, no dead end.
  function runAi(kind) {
    const seed = seedText;
    if (!seed) return;
    setLastAiTask(kind);
    // Snapshot what the narrative field shows right now so the rewrite can be
    // undone (2026-07-16 / 2026-07-20 feedback). Restores AUTO mode too.
    setAiUndo({ auto: autoOn, narrative: local.narrative });
    if (autoOn) update({ auto: false, narrative: seed });
    if (kind === 'expand') { if (aiSplit) aiExpand(seed); else aiNarrate('draft', seed); return; }
    if (kind === 'shorten') { aiNarrate('shorter', seed); return; }
    aiNarrate('regenerate', seed);
  }

  // Restore the pre-rewrite narrative (and AUTO state). One-shot: the button
  // vanishes after use or once the user edits the field manually.
  function undoAi() {
    if (!aiUndo) return;
    update({ auto: aiUndo.auto, narrative: aiUndo.narrative });
    setAiUndo(null);
  }

  function aiTaskLabel(kind) {
    if (kind === 'expand') return aiSplit ? 'Expand → split into tasks' : 'Expand';
    if (kind === 'shorten') return 'Shorten';
    return 'Rewrite';
  }

  const aiMenuItems = [
    {
      label: aiSplit ? 'Expand → split into tasks' : 'Expand',
      icon: 'sparkles', disabled: !seedText || aiBusy,
      onClick: () => runAi('expand'),
    },
    { label: 'Shorten', disabled: !seedText || aiBusy, onClick: () => runAi('shorten') },
    { label: 'Rewrite', disabled: !seedText || aiBusy, onClick: () => runAi('rewrite') },
    { hr: true },
    {
      custom: () => html`
        <label class="checkbox-row small" style=${{ padding: '2px 10px 6px' }}>
          <input type="checkbox" checked=${aiSplit} onChange=${(e) => setAiSplit(e.target.checked)} />
          split into tasks
        </label>`,
    },
  ];

  // ---------- render ----------

  if (!local) {
    return html`<${Modal} title="Time entry" onClose=${() => onClose(changedRef.current)} wide=${true}><${Spinner} /><//>`;
  }

  const validation = entry ? entry.validation : [];

  return html`
    <${Modal} wide=${true} onClose=${flushAndClose}
      title=${finalized ? 'Time entry (finalized)' : entry ? 'Edit time entry' : 'New time entry'}>
      <div class="entry-head-grid">
        <${Field} label="Date">
          <input type="date" value=${local.date} disabled=${finalized}
            onChange=${(e) => update({ date: e.target.value })} />
        <//>
        <${Field} label="Client/Matter">
          <${CmPicker} value=${local.cm} autoFocus=${!local.cm}
            onChange=${(cm) => update({ cm, billable: !!cm.billable })} />
          ${local.cm ? html`<span class="cm-client-label muted small">${clientLabel(local.cm)}</span>` : null}
        <//>
        <${Field} label="Total hours">
          <input type="number" min="0" step=${increment} class="mono total-input"
            value=${local.total || ''} placeholder="0.0" disabled=${finalized}
            onInput=${(e) => updateTotal(e.target.value)} />
        <//>
        <div class="field">
          ${/* a blank label so the checkbox lines up with the neighbouring
                CONTROLS, not with their labels. The spacer is a JS escape
                because htm does not decode HTML entities — a written
                "&nbsp;" would render as those six characters. */''}
          <span class="field-label" aria-hidden="true">${'\u00a0'}</span>
          <label class="checkbox-row">
            <input type="checkbox" checked=${local.billable} disabled=${finalized}
              onChange=${(e) => update({ billable: e.target.checked })} />
            Billable
          </label>
        </div>
      </div>

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
        </div>` : null}

      <div class="section-title">
        <h3 style=${{ margin: 0 }}>Task lines</h3>
        <span class="muted small">divide the total among tasks</span>
        <div class="spacer" style=${{ flex: 1 }}></div>
        ${!finalized && substantiveIdx.length <= 1 && splitNarrativeSegments(seedText).length >= 2 ? html`
          <button class="btn btn-sm"
            title="Divide the narrative into task lines at its semicolons — keeps your wording exactly; trailing (x.x) amounts become that task's hours, the rest splits evenly"
            onClick=${splitFromNarrative}><${Icon} name="clipboard" size=${14} /> Split into tasks</button>` : null}
        ${!finalized && local.tasks.length > 1 && total > 0 ? html`
          <button class="btn btn-sm" onClick=${splitEvenly}>Split evenly</button>` : null}
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
                <select autoFocus disabled=${finalized}
                  onChange=${(e) => { updateLine(i, { task_code: e.target.value }); setCodeOpenIdx(null); }}
                  onBlur=${() => setCodeOpenIdx(null)}>
                  <option value="">(task)</option>
                  ${taskCodes.map((c) => html`<option key=${c.id} value=${c.name}>${c.name}</option>`)}
                </select>` : html`
                <button type="button" class="task-code-add" disabled=${finalized}
                  onClick=${() => setCodeOpenIdx(i)}>+ code</button>`)}
            </div>
            <input type="number" min="0" step=${increment} value=${t.duration || ''}
              placeholder="0.0" disabled=${finalized} class="mono"
              onInput=${(e) => updateLineDuration(i, e.target.value)} />
            <${GhostInput} value=${t.fragment} suggestions=${phrases} disabled=${finalized}
              expand=${expand} onSelectionChange=${onFieldSelect}
              placeholder=${autoAvailable ? 'narrative fragment for this task' : 'optional fragment (used if you add more lines)'}
              onChange=${(v) => updateLine(i, { fragment: v })} />
            <div class="row" style=${{ flexWrap: 'nowrap', gap: '2px' }}>
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
        <div class="row">
          <button class="btn btn-sm" disabled=${finalized} onClick=${addLine}>
            <${Icon} name="plus" size=${14} /> Add task line
          </button>
          <div class="spacer" style=${{ flex: 1 }}></div>
          <span class="muted small">Allocated <strong class="mono">${fmtHours(sum, increment)}h</strong>${' of '}<strong class="mono">${fmtHours(total, increment)}h</strong></span>
        </div>
      </div>

      <div class="section-title"><h3 style=${{ margin: 0 }}>Narrative</h3>
        ${autoAvailable ? html`
          <button type="button" class=${'auto-toggle-chip' + (autoOn ? ' on' : '')} disabled=${finalized}
            title=${autoOn ? 'Turn off — edit narrative freely' : 'Turn on — regenerate from task lines'}
            onClick=${() => update({ auto: !local.auto })}>AUTO</button>` : null}
        <div class="spacer" style=${{ flex: 1 }}></div>
        ${aiUndo && !finalized ? html`
          <button type="button" class="btn btn-sm" title="Undo the AI rewrite — restore your previous narrative"
            disabled=${aiBusy} onClick=${undoAi}>
            <${Icon} name="history" size=${14} /> Undo</button>` : null}
        ${ai && ai.enabled && ai.reachable && !finalized ? html`
          <div class="btn-split">
            <button type="button" class="btn btn-sm" title=${`AI: ${aiTaskLabel(lastAiTask)}`}
              disabled=${!seedText || aiBusy} onClick=${() => runAi(lastAiTask)}>
              <${Icon} name="sparkles" size=${14} /> ${aiBusy ? 'Working…' : aiTaskLabel(lastAiTask)}
            </button>
            <button type="button" class="btn btn-sm" title="Choose a different AI task"
              disabled=${!seedText || aiBusy}
              onClick=${(e) => { const r = e.currentTarget.getBoundingClientRect(); setAiMenu({ x: r.left, y: r.bottom + 4 }); }}>
              <${Icon} name="chevronDown" size=${12} />
            </button>
          </div>` : null}
        <${SaveShortcutBar} selection=${selText} />
      </div>
      ${!finalized && suggestionChips.length > 0 ? html`
        <div class="editor-suggest-chips">
          ${suggestionChips.map((t) => html`
            <button key=${t} type="button" title=${t}
              onClick=${() => { if (aiUndo) setAiUndo(null); update({ narrative: t }); }}>${t}</button>`)}
        </div>` : null}
      <div class="narrative-preview">
        ${autoOn ? html`
          <span class="auto-badge">AUTO</span>
          <textarea value=${autoText || ''} disabled=${finalized} spellCheck=${true}
            onInput=${(e) => applyAutoEdit(e.target.value)}></textarea>` : html`
          <${GhostInput} multiline rows=${3} value=${local.narrative} disabled=${finalized}
            suggestions=${phrases} expand=${expand} onSelectionChange=${onFieldSelect}
            placeholder="What did you do? (specific verbs — banned vague phrases are flagged)"
            onChange=${(v) => { if (aiUndo) setAiUndo(null); update({ narrative: v }); }} />`}
      </div>
      ${aiMenu ? html`<${ContextMenu} x=${aiMenu.x} y=${aiMenu.y} items=${aiMenuItems} onClose=${() => setAiMenu(null)} />` : null}

      <${ValidationList} findings=${validation} />

      ${gate ? html`
        <div class="card" style=${{ borderColor: 'var(--status-warning)' }}>
          <strong>${gate.blocks.length ? 'Cannot finalize yet:' : 'Finalize with warnings?'}</strong>
          <${ValidationList} findings=${[...gate.blocks, ...gate.warns]} />
          ${gate.blocks.length === 0 ? html`
            <div class="row-end">
              <button class="btn btn-primary" onClick=${() => finalize(true)}>Finalize anyway</button>
            </div>` : null}
        </div>` : null}

      ${entry && entry.ever_finalized ? html`
        <details style=${{ marginTop: '10px' }} onToggle=${(e) => { if (e.target.open && !audit) loadAudit(); }}>
          <summary class="muted small" style=${{ cursor: 'pointer' }}>Audit history</summary>
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

      <div class="row" style=${{ marginTop: '16px' }}>
        ${entry && !finalized ? html`
          <button class="btn btn-ghost" onClick=${() => setConfirmDelete(true)}><${Icon} name="trash" size=${16} /> Delete</button>` : null}
        <span class="saving-dot">
          ${saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? '✓ Saved' : saveState === 'error' ? '⚠ Save failed' : ''}
        </span>
        <div class="spacer" style=${{ flex: 1 }}></div>
        ${finalized
          ? html`<button class="btn" onClick=${unlock}><${Icon} name="unlock" size=${16} /> Unlock to edit</button>`
          : html`
            <button class="btn" onClick=${flushAndClose}>Save & close</button>
            <button class="btn btn-primary" onClick=${() => finalize(false)}>
              <${Icon} name="lock" size=${16} /> Finalize</button>`}
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
