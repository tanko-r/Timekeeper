import { api } from '/js/api.js';
import { html, useState, useEffect, useRef, Overlay, emitToast, fmtHours, todayStr, Icon } from '/js/ui.js';
import { CmPicker } from '/js/components/cmpicker.js';
import { useDismissLayer } from '/js/components/overlay.js';

// Bill from a sentence (spec §6, magic #1): one line in, a ready-to-approve
// entry out. Deterministic parse previews live; Enter approves and files.
//
// It goes through the shared Overlay primitive like every other dialog — the
// wave-0 critic found it "a floating popover with no scrim whatsoever, the
// page behind fully bright, partially covering the New entry button and the
// alert card, so it reads as a rendering glitch rather than a focused mode",
// with "no commit or dismiss control: the only affordance is the hint text
// 'Enter files it'". It keeps its own Enter/Escape handling on the input,
// because typing a line and pressing Enter is the whole point of it — but
// File and Cancel are now real buttons, at the touch floor, on every width.
//
// ---------------------------------------------------------------------------
// THE DEAD END, measured twice and fixed here.
//
// Wave-1 review, finding D9: "Driven with four realistic phrasings, only one
// filed. `Acme lease dispute review .6` and `northgate diligence review
// documents .4` both parse matter and hours, then show `? action` and a
// DISABLED `File it`. The hint says 'fill the ? pieces' — but `.qc-chip.miss`
// is an inert `<span>` 67×27 with `cursor: default`; clicking it does nothing.
// There is no way to follow the instruction the dialog gives."
//
// Three changes, and all three have to hold together:
//
//   1. EVERY SLOT IS A CONTROL. Matter, hours and action are buttons now,
//      whether the parser found them or not, and each one opens the picker
//      that fills it — the client/matter combobox the rest of the app already
//      uses, a task-code list, or an hours stepper — INLINE in the sheet,
//      never as a second dialog over the first. A found value is a button too:
//      the parser's guess is a proposal, and correcting it before filing must
//      not mean retyping the line. 44px on a phone.
//
//   2. A MISSING TASK CODE NO LONGER BLOCKS THE FILE. An entry posted from
//      here is a draft either way (POST /api/entries always writes
//      status='draft'), the row it lands on shows the missing code, and
//      close-out sweeps it at the end of the day. A draft that needs one field
//      later beats a sentence that cannot be filed at all. Matter and hours DO
//      still gate it: an entry with no matter cannot be written, and an entry
//      with no hours is not a time entry.
//
//   3. THE PRIMARY NEVER LIES AND NEVER DEAD-ENDS. Instead of a disabled
//      button next to an instruction you cannot follow, the primary says what
//      it will do next — "Pick a matter", "Set the hours", "File as draft",
//      "File it" — and Enter does exactly what the primary says, so the
//      keyboard path and the thumb path are the same path. The button is
//      disabled only while there is nothing typed to act on.
//
// An explicit pick beats the parse, and any keystroke in the line drops every
// pick: the sentence is the source of truth, and a pick refines the sentence
// that is on screen. Keeping a matter chosen for an earlier sentence would be
// the one truly expensive mistake this dialog can make — time filed against
// the wrong client.
// ---------------------------------------------------------------------------

// Hours the phone can set in one tap, in the shape of Harvest's quick-add
// duration pills (refs-v2/harvest-new-time-entry.mobile.jpg) — but SET rather
// than ADD, because "that call was a 0.3" is the thought a lawyer actually
// has. The stepper beside them covers everything else in ±0.1 steps.
const HOUR_PILLS = [0.1, 0.2, 0.3, 0.5, 0.8, 1, 1.5, 2];
const STEP = 0.1;
const HOURS_MAX = 12; // mirrors parseDuration's own bound in server/lib/quickcapture.js
const round1 = (n) => Math.round(n * 10) / 10;
const clampHours = (n) => Math.min(HOURS_MAX, Math.max(STEP, round1(n)));

const FILL_TITLE = { matter: 'Which matter?', hours: 'How long?', action: 'Which action?' };

const isPhone = () => typeof window !== 'undefined'
  && window.matchMedia('(max-width: 767px)').matches;

export function QuickCapture({ onClose, onFiled }) {
  const [line, setLine] = useState('');
  const [parsed, setParsed] = useState(null);
  const [matterIdx, setMatterIdx] = useState(0);
  const [aiBusy, setAiBusy] = useState(false);
  const [ai, setAi] = useState(null);
  const [codes, setCodes] = useState([]);
  // Which inline picker is open — null, 'matter', 'hours' or 'action'. One at
  // a time: this is a disclosure below the chips, not a stack of popovers.
  const [fill, setFill] = useState(null);
  // Explicit picks. They override the parse until the line changes.
  const [pickMatter, setPickMatter] = useState(null);
  const [pickHours, setPickHours] = useState(null);
  const [pickCode, setPickCode] = useState(null);
  const inputRef = useRef(null);
  const fillRef = useRef(null);
  const openerRef = useRef(null); // the chip that opened the picker, to focus back
  const timer = useRef(null);
  const seq = useRef(0);
  // Enter was pressed while the parse on screen was still catching up with the
  // line. See THE PARSE ON SCREEN IS NOT ALWAYS THE LINE below.
  const fileWhenFresh = useRef(false);

  useEffect(() => { api.get('/api/ai/status').then(setAi).catch(() => {}); }, []);
  useEffect(() => { api.get('/api/task-codes').then(setCodes).catch(() => {}); }, []);
  useEffect(() => () => clearTimeout(timer.current), []);

  // The parse REMEMBERS THE LINE IT IS ABOUT. Without that the component holds
  // "a parse" with no way to tell whether it describes the sentence on screen
  // or the one before it — which is the whole of the defect fenced below.
  function requestParse(text, useAi = false, immediate = false) {
    const mySeq = ++seq.current;
    const run = () => api.post('/api/quickcapture', { line: text, ai: useAi })
      .then((p) => { if (seq.current === mySeq) { setParsed({ ...p, line: text }); setMatterIdx(0); } })
      .catch(() => {})
      .finally(() => { if (useAi) setAiBusy(false); });
    if (useAi) { setAiBusy(true); clearTimeout(timer.current); run(); }
    else if (immediate) { clearTimeout(timer.current); run(); }
    else { clearTimeout(timer.current); timer.current = setTimeout(run, 200); }
  }

  function onInput(e) {
    const text = e.target.value;
    setLine(text);
    // The line is the source of truth: a pick describes the sentence that was
    // on screen when it was made, so editing the sentence retires it.
    setPickMatter(null); setPickHours(null); setPickCode(null);
    // …and so does a queued file: more typing means he is not finished.
    fileWhenFresh.current = false;
    if (text.trim().length >= 3) requestParse(text);
    // Nothing left to fill: the chips go with the parse, so the picker hanging
    // off one of them goes too rather than being orphaned open.
    else { setParsed(null); setFill(null); }
  }

  // ---------------------------------------------------------------------------
  // THE PARSE ON SCREEN IS NOT ALWAYS THE LINE ON SCREEN  (matter fence)
  //
  // The parse is debounced by 200ms and the dialog deliberately keeps the last
  // one visible while the next is in flight, so the preview does not flicker on
  // every keystroke. That is right for the preview and wrong for the FILE:
  // Enter pressed inside that window filed the PREVIOUS sentence's parse.
  //
  // Reproduced: type "acme lease dispute review notice .3", wait for the
  // preview, then correct the head of the line to "northgate diligence review
  // notice .3" and press Enter. The entry landed on Acme — a different client —
  // with the corrected line's own words, because `parsed.matches` still held
  // the Acme ranking. Nothing on screen said so; the line said Northgate.
  // That is time and a client-facing sentence filed against the wrong client
  // from the app's fastest path, and the brief puts it above every other rule.
  //
  // So the parse now carries the line it was made from, and a parse that does
  // not match the line is STALE: it may still be shown (the preview is only a
  // preview), but it may never be filed. Enter on a stale parse re-parses the
  // real line at once and files when that answer lands — the keystroke is not
  // lost, it just waits for the truth.
  const stale = !!parsed && parsed.line !== line;

  // What the entry WILL be: an explicit pick, else what the parser found.
  const matter = pickMatter || (parsed && parsed.matches[matterIdx]) || null;
  const hours = pickHours != null ? pickHours : (parsed ? parsed.hours : null);
  const code = pickCode != null ? pickCode : (parsed ? parsed.task_code : null);

  // Missing, recomputed from the effective values — parsed.missing is the
  // server's view of the raw line and goes stale the moment a chip is used.
  const missing = [];
  if (!matter) missing.push('matter');
  if (hours == null) missing.push('hours');
  if (!code) missing.push('action');
  // A task code can be added later; a matter and an hours figure cannot be
  // guessed after the fact.
  const canFile = !!matter && hours != null;
  const complete = canFile && !!code;

  function openFill(kind, e) {
    openerRef.current = e && e.currentTarget ? e.currentTarget : null;
    setFill((cur) => (cur === kind ? null : kind));
  }

  function closeFill() {
    setFill(null);
    // Back to the chip that opened it; back to the line when the picker was
    // opened by Enter and there was no chip to come from.
    const el = openerRef.current && openerRef.current.isConnected
      ? openerRef.current : inputRef.current;
    if (el) el.focus({ preventScroll: true });
  }

  // Escape closes the picker before it closes the dialog (the overlay
  // primitive's dismissal stack), so a half-made choice never costs the line.
  useDismissLayer(!!fill, closeFill, fillRef);

  function focusFill() {
    const box = fillRef.current;
    if (!box) return;
    const el = box.querySelector('[data-qc-focus]') || box.querySelector('input, button');
    if (el) el.focus({ preventScroll: true });
    box.scrollIntoView({ block: 'nearest' });
  }

  // Open a picker by keyboard and the first control in it takes focus; on a
  // phone the panel is scrolled into the sheet's own scrollport instead of
  // being left below the fold.
  useEffect(() => { if (fill) focusFill(); }, [fill]); // eslint-disable-line

  // The keystroke that arrived while the parse was catching up, honoured the
  // moment the parse describes the line the lawyer actually typed. It runs
  // exactly the same `advance` the key and the button run, so Enter-during-the
  // -debounce and Enter-after-it can never do two different things.
  useEffect(() => {
    if (!fileWhenFresh.current) return;
    if (!parsed || parsed.line !== line) return;
    fileWhenFresh.current = false;
    advance(null);
  }, [parsed, line]); // eslint-disable-line

  async function file() {
    if (!canFile || stale) return;
    try {
      await api.post('/api/entries', {
        date: todayStr(), cm_id: matter.id, narrative: parsed.narrative,
        // The matter this sentence was composed for, named on the write itself.
        // On a POST it is the same matter the entry is being created on, so it
        // can only ever agree — which is the point: every surface that writes a
        // suggested narrative says which matter it meant, and the one surface
        // that cannot disagree still says it, so the rule has no exceptions to
        // remember.
        source_cm_id: matter.id,
        tasks: [{ task_code: code || '', duration: hours, fragment: '' }],
      });
      emitToast(code
        ? `Filed ✓ — ${fmtHours(hours)}h on ${matter.short_name}`
        : `Filed as draft — ${fmtHours(hours)}h on ${matter.short_name} · no action code yet`);
      onFiled();
      onClose();
    } catch (e) {
      emitToast(e.status === 409 && !/finaliz/i.test(String(e.body?.error || e.message || ''))
        ? 'That matter changed while this was filing — nothing was written.'
        : e.message, { error: true });
    }
  }

  // ONE next step, shared by Enter and by the primary button, so the keyboard
  // and the thumb can never disagree about what happens next.
  function advance(e) {
    // A stale parse decides nothing — not what to file, and not which picker
    // is "next". Re-parse the real line now and pick this up again when the
    // answer lands (the effect below).
    if (stale) {
      fileWhenFresh.current = true;
      if (line.trim().length >= 3) requestParse(line, false, true);
      else { fileWhenFresh.current = false; setParsed(null); setFill(null); }
      return;
    }
    if (canFile) { file(); return; }
    if (!parsed) return;
    // Never a toggle here: pressing Enter (or the primary) a second time while
    // the picker it just opened is still up must take the reader INTO it, not
    // shut the thing they were told to use.
    if (fill === missing[0]) { focusFill(); return; }
    openFill(missing[0], e);
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
    else if (e.key === 'Enter') { e.preventDefault(); advance(null); }
  }

  const chipProps = (kind, extra = {}) => ({
    type: 'button',
    'aria-expanded': fill === kind ? 'true' : 'false',
    // Only while the panel is really in the document — an aria-controls
    // pointing at an id that does not exist is worse than none.
    'aria-controls': fill === kind ? 'qc-fill' : undefined,
    onClick: (e) => openFill(kind, e),
    ...extra,
  });

  const matterLabel = (m) => `${m.client_name ? `${m.client_name} · ` : ''}${m.short_name}`;

  // At rest — nothing typed yet — the button says what this dialog is FOR, and
  // is disabled. It only renames itself once there is a parse to act on.
  const primary = !parsed || complete ? { label: 'File it', icon: 'check' }
    : canFile ? { label: 'File as draft', icon: 'check' }
    : missing[0] === 'matter' ? { label: 'Pick a matter', icon: 'chevronRight' }
    : { label: 'Set the hours', icon: 'chevronRight' };

  // The hint names the affordance rather than describing a state. The old one
  // ("fill the ? pieces, or edit the line") described something the dialog did
  // not let you do.
  const hint = !parsed ? 'one line: what · who · matter · time'
    : complete ? 'ready to file'
    : canFile ? 'files as a draft — the ? action chip codes it now'
    : 'every ? chip opens a picker — Enter opens the next one';

  const fillBody = fill === 'matter' ? html`
    ${/* The app's own client/matter combobox, not a second one: favourites,
          recents, ranked search, "＋ New client/matter…" and the ARIA 1.2
          pattern all come with it. autoFocus only where a keyboard exists —
          on a phone the field is a 44px target the thumb opens itself, and
          auto-raising the soft keyboard over the sheet is exactly what the
          overlay primitive's keyboardShy rule exists to prevent. */''}
    <${CmPicker} value=${null} onChange=${(cm) => { setPickMatter(cm); closeFill(); }}
      autoFocus=${!isPhone()} placeholder="Search client or matter…" />`
    : fill === 'hours' ? html`
    <div class="qc-hours">
      <button type="button" class="btn btn-icon qc-step" aria-label="Less by a tenth"
        onClick=${() => setPickHours((h) => clampHours((h != null ? h : hours || 0) - STEP))}>
        <${Icon} name="minus" size=${18} /></button>
      <output class="qc-hours-value" aria-live="polite">
        ${hours != null ? html`${fmtHours(hours)}<span class="qc-hours-unit">h</span>`
          : html`<span class="qc-hours-none">not set</span>`}</output>
      <button type="button" class="btn btn-icon qc-step" aria-label="More by a tenth"
        onClick=${() => setPickHours((h) => clampHours((h != null ? h : hours || 0) + STEP))}>
        <${Icon} name="plus" size=${18} /></button>
    </div>
    <div class="qc-fill-grid">
      ${HOUR_PILLS.map((h, i) => html`
        <button key=${h} type="button" class="qc-pick" aria-pressed=${hours === h}
          data-qc-focus=${i === 0 ? '' : undefined}
          onClick=${() => { setPickHours(h); closeFill(); }}>${fmtHours(h)}h</button>`)}
    </div>`
    : fill === 'action' ? (codes.length ? html`
    <div class="qc-fill-grid">
      ${codes.map((c, i) => html`
        <button key=${c.id} type="button" class="qc-pick" aria-pressed=${code === c.name}
          data-qc-focus=${i === 0 ? '' : undefined}
          onClick=${() => { setPickCode(c.name); closeFill(); }}>${c.name}</button>`)}
    </div>` : html`
    <div class="muted small">No task codes are active — add one in Settings → Codes &
      shortcuts. You can still file this as a draft.</div>`)
    : null;

  return html`
    <${Overlay} onClose=${() => onClose()} title=${null} label="Quick capture"
      className="qc-card" initialFocus="input[type=text]">
      <div class="qc-row">
        <${Icon} name="sparkles" size=${16} />
        <input ref=${inputRef} autoFocus type="text" value=${line}
          placeholder="call sam re loading dock lease .3"
          onInput=${onInput} onKeyDown=${onKeyDown} />
      </div>
      ${parsed ? html`
        <div class="qc-preview" role="group" aria-label="What this will file">
          ${parsed.matches.length && !pickMatter ? html`
            <span class="qc-chips">
              ${parsed.matches.map((m, i) => html`
                <button key=${m.id} type="button" class=${'qc-chip' + (i === matterIdx ? ' on' : '')}
                  aria-pressed=${i === matterIdx}
                  onClick=${() => setMatterIdx(i)}>${matterLabel(m)}</button>`)}
              ${/* A matter the ranker did not offer is still a matter he might
                    have meant; without this the only way out of three wrong
                    guesses is to retype the sentence. */''}
              <button ...${chipProps('matter', { title: 'Pick a different matter' })}
                class="qc-chip qc-chip-alt" aria-label="Pick a different matter">Other…</button>
            </span>`
            : pickMatter ? html`
            <button ...${chipProps('matter')} class="qc-chip on" aria-pressed=${true}>
              ${matterLabel(pickMatter)}</button>`
            : html`
            <button ...${chipProps('matter')} class="qc-chip miss">? matter</button>`}

          ${hours != null ? html`
            <button ...${chipProps('hours')} class="qc-chip qc-chip-num"
              aria-label=${`${fmtHours(hours)} hours — change`}>${fmtHours(hours)}h</button>`
            : html`<button ...${chipProps('hours')} class="qc-chip miss">? hours</button>`}

          ${code ? html`
            <button ...${chipProps('action')} aria-label=${`Action ${code} — change`}
              class="qc-chip">${code}</button>`
            : html`<button ...${chipProps('action')} class="qc-chip miss">? action</button>`}
        </div>
        ${fill ? html`
          <div class="qc-fill" id="qc-fill" ref=${fillRef} role="group"
            aria-labelledby="qc-fill-title">
            <div class="qc-fill-head">
              <span class="qc-fill-title" id="qc-fill-title">${FILL_TITLE[fill]}</span>
              <button type="button" class="btn btn-ghost btn-icon btn-sm" aria-label="Close"
                onClick=${closeFill}><${Icon} name="x" size=${16} /></button>
            </div>
            ${fillBody}
          </div>` : null}
        ${parsed.narrative ? html`<div class="qc-narrative">${parsed.narrative}</div>` : null}` : null}
      <div class="qc-hint muted small" aria-live="polite">${hint}</div>
      <div class="ovl-actions">
        ${ai && ai.enabled && parsed && missing.length > 0 ? html`
          <button class="btn" disabled=${aiBusy} onClick=${() => requestParse(line, true)}>
            ${aiBusy ? 'Parsing…' : 'AI parse'}</button>` : null}
        <button class="btn" onClick=${() => onClose()}>
          Cancel<kbd class="ovl-kbd">Esc</kbd>
        </button>
        <button class="btn btn-primary" disabled=${!parsed} onClick=${(e) => advance(e)}>
          <${Icon} name=${primary.icon} size=${16} /> ${primary.label}<kbd class="ovl-kbd">Enter</kbd>
        </button>
      </div>
    <//>`;
}
