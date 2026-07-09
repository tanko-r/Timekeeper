import { api } from '/js/api.js';
import { html, useState, useEffect, useRef, createPortal, emitToast, fmtHours, todayStr, Icon } from '/js/ui.js';

// Bill from a sentence (spec §6, magic #1): one line in, a ready-to-approve
// entry out. Deterministic parse previews live; Enter approves and files.
// Deliberately NOT the shared Modal — this owns Enter/Escape itself.

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

  return createPortal(html`
    <div class="qc-backdrop" onMouseDown=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div class="qc-card" role="dialog" aria-label="Quick capture">
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
          ${parsed.narrative ? html`<div class="qc-narrative">${parsed.narrative}</div>` : null}
          <div class="qc-foot">
            ${ai && ai.enabled && parsed.missing.length > 0 ? html`
              <button class="btn btn-sm" disabled=${aiBusy} onClick=${() => requestParse(line, true)}>
                ${aiBusy ? 'Parsing…' : 'AI parse'}</button>` : null}
            <span class="spacer" style=${{ flex: 1 }}></span>
            <span class="muted small">${ready ? 'Enter files it · Esc closes' : 'fill the ? pieces, or edit the line'}</span>
          </div>` : html`
          <div class="qc-foot"><span class="muted small">one line: what · who · matter · time — Enter files it</span></div>`}
      </div>
    </div>`, document.body);
}
