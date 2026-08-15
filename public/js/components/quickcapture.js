import { api } from '/js/api.js';
import { html, useState, useEffect, useRef, Overlay, emitToast, fmtHours, todayStr, Icon } from '/js/ui.js';

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

export function QuickCapture({ onClose, onFiled }) {
  const [line, setLine] = useState('');
  const [parsed, setParsed] = useState(null);
  const [matterIdx, setMatterIdx] = useState(0);
  const [aiBusy, setAiBusy] = useState(false);
  const [ai, setAi] = useState(null);
  const inputRef = useRef(null);
  const timer = useRef(null);
  const seq = useRef(0);

  useEffect(() => { api.get('/api/ai/status').then(setAi).catch(() => {}); }, []);
  useEffect(() => () => clearTimeout(timer.current), []);

  function requestParse(text, useAi = false) {
    const mySeq = ++seq.current;
    const run = () => api.post('/api/quickcapture', { line: text, ai: useAi })
      .then((p) => { if (seq.current === mySeq) { setParsed(p); setMatterIdx(0); } })
      .catch(() => {})
      .finally(() => { if (useAi) setAiBusy(false); });
    if (useAi) { setAiBusy(true); run(); }
    else { clearTimeout(timer.current); timer.current = setTimeout(run, 200); }
  }

  function onInput(e) {
    const text = e.target.value;
    setLine(text);
    if (text.trim().length >= 3) requestParse(text);
    else setParsed(null);
  }

  const matter = parsed && parsed.matches[matterIdx];
  const ready = parsed && parsed.missing.length === 0 && matter;

  async function file() {
    if (!ready) return;
    try {
      await api.post('/api/entries', {
        date: todayStr(), cm_id: matter.id, narrative: parsed.narrative,
        tasks: [{ task_code: parsed.task_code, duration: parsed.hours, fragment: '' }],
      });
      emitToast(`Filed ✓ — ${fmtHours(parsed.hours)}h on ${matter.short_name}`);
      onFiled();
      onClose();
    } catch (e) { emitToast(e.message, { error: true }); }
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
    else if (e.key === 'Enter') { e.preventDefault(); file(); }
  }

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
        <div class="qc-preview">
          ${parsed.matches.length ? html`
            <span class="qc-chips">
              ${parsed.matches.map((m, i) => html`
                <button key=${m.id} class=${'qc-chip' + (i === matterIdx ? ' on' : '')}
                  onClick=${() => setMatterIdx(i)}>${m.client_name ? `${m.client_name} · ` : ''}${m.short_name}</button>`)}
            </span>` : html`<span class="qc-chip miss">? matter</span>`}
          ${parsed.hours != null ? html`<span class="qc-chip">${fmtHours(parsed.hours)}h</span>`
            : html`<span class="qc-chip miss">? hours</span>`}
          ${parsed.task_code ? html`<span class="qc-chip">${parsed.task_code}</span>`
            : html`<span class="qc-chip miss">? action</span>`}
        </div>
        ${parsed.narrative ? html`<div class="qc-narrative">${parsed.narrative}</div>` : null}` : null}
      <div class="qc-hint muted small">
        ${!parsed ? 'one line: what · who · matter · time'
          : ready ? 'ready to file' : 'fill the ? pieces, or edit the line'}
      </div>
      <div class="ovl-actions">
        ${ai && ai.enabled && parsed && parsed.missing.length > 0 ? html`
          <button class="btn" disabled=${aiBusy} onClick=${() => requestParse(line, true)}>
            ${aiBusy ? 'Parsing…' : 'AI parse'}</button>` : null}
        <button class="btn" onClick=${() => onClose()}>
          Cancel<kbd class="ovl-kbd">Esc</kbd>
        </button>
        <button class="btn btn-primary" disabled=${!ready} onClick=${file}>
          <${Icon} name="check" size=${16} /> File it<kbd class="ovl-kbd">Enter</kbd>
        </button>
      </div>
    <//>`;
}
