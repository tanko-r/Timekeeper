import { api } from '/js/api.js';
import { html, useState, useEffect, Modal, Field, emitToast } from '/js/ui.js';

// Alt+drag anywhere → select a region → the tab is screenshotted with the
// region highlighted (everything else dimmed) → a note box pops → note +
// screenshot POST to /api/feedback, which files them in feedback/ and
// appends a TODO.md entry. Development affordance for capturing UI gripes
// the moment they're felt.
//
// Capture uses getDisplayMedia({ preferCurrentTab }) — zero dependencies,
// real pixels, at the cost of Chrome's one-click "share this tab" prompt.
// If capture is declined or unsupported, the note still files (region +
// route recorded, no image) — the feedback must never be lost to a
// permission dialog.
//
// The sidebar "Add todo" button dispatches `tk:add-todo`, which opens the
// same note box with no screenshot — a quick way to jot a change onto the
// same TODO.md list without dragging out a region.

function normRegion(sel) {
  const x = Math.min(sel.x0, sel.x1);
  const y = Math.min(sel.y0, sel.y1);
  return { x, y, w: Math.abs(sel.x1 - sel.x0), h: Math.abs(sel.y1 - sel.y0) };
}

async function captureTab(region) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) return null;
  // Without transient user activation (real click/drag), getDisplayMedia can
  // hang instead of rejecting — bail to the note-only path immediately.
  if (navigator.userActivation && !navigator.userActivation.isActive) return null;
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: true, audio: false, preferCurrentTab: true,
  });
  try {
    const video = document.createElement('video');
    video.srcObject = stream;
    await video.play();
    await new Promise((r) => requestAnimationFrame(r)); // one painted frame
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return null;

    // keep payloads sane on hi-DPI screens
    const scale = Math.min(1, 1920 / vw);
    const cw = Math.round(vw * scale);
    const ch = Math.round(vh * scale);
    const canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, cw, ch);

    // viewport coords → capture coords (tab capture covers the viewport)
    const sx = cw / window.innerWidth;
    const sy = ch / window.innerHeight;
    const r = { x: region.x * sx, y: region.y * sy, w: region.w * sx, h: region.h * sy };
    ctx.save();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
    ctx.beginPath();
    ctx.rect(0, 0, cw, ch);
    ctx.rect(r.x, r.y, r.w, r.h);
    ctx.fill('evenodd'); // dim everything except the selection
    ctx.restore();
    ctx.strokeStyle = '#e11d48';
    ctx.lineWidth = 3;
    ctx.strokeRect(r.x, r.y, r.w, r.h);
    return canvas.toDataURL('image/png');
  } finally {
    stream.getTracks().forEach((t) => t.stop());
  }
}

export function FeedbackCapture() {
  const [drag, setDrag] = useState(null);      // live selection rectangle
  const [pending, setPending] = useState(null); // { region, image|null, mode } → note box
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  // Sidebar "Add todo": open the same note box, no screenshot, no region.
  useEffect(() => {
    const onAddTodo = () => {
      if (document.querySelector('.feedback-note')) return; // note box already open
      setNote('');
      setPending({ region: null, image: null, mode: 'todo' });
    };
    window.addEventListener('tk:add-todo', onAddTodo);
    return () => window.removeEventListener('tk:add-todo', onAddTodo);
  }, []);

  useEffect(() => {
    const onDown = (e) => {
      if (!e.altKey || e.button !== 0) return;
      if (document.querySelector('.feedback-note')) return; // note box already open
      e.preventDefault(); // also suppresses native drag/text selection
      e.stopPropagation();
      const sel = { x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY };
      setDrag({ ...sel });
      const onMove = (ev) => {
        sel.x1 = ev.clientX;
        sel.y1 = ev.clientY;
        setDrag({ ...sel });
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove, true);
        document.removeEventListener('mouseup', onUp, true);
        setDrag(null);
        const region = normRegion(sel);
        if (region.w < 8 || region.h < 8) return; // accidental Alt+click
        // capture must start inside the user gesture — no awaits before it
        captureTab(region)
          .catch(() => null)
          .then((image) => { setNote(''); setPending({ region, image }); });
      };
      document.addEventListener('mousemove', onMove, true);
      document.addEventListener('mouseup', onUp, true);
    };
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
  }, []);

  async function save() {
    setBusy(true);
    try {
      const r = await api.post('/api/feedback', {
        note,
        image: pending.image || undefined,
        route: location.hash || '#/',
      });
      emitToast(r.file
        ? `Feedback filed → TODO.md + feedback/${r.file}`
        : pending.mode === 'todo'
          ? 'Todo added → TODO.md'
          : 'Feedback filed → TODO.md (no screenshot)');
      setPending(null);
    } catch (e) {
      emitToast(e.message, { error: true });
    } finally {
      setBusy(false);
    }
  }

  const rect = drag ? normRegion(drag) : null;
  return html`
    ${rect ? html`
      <div class="feedback-select" style=${{
        left: `${rect.x}px`, top: `${rect.y}px`,
        width: `${rect.w}px`, height: `${rect.h}px`,
      }}></div>` : null}
    ${pending ? html`
      <${Modal} title=${pending.mode === 'todo' ? 'Add todo' : 'UI feedback'}
        onClose=${() => setPending(null)}>
          ${pending.image
            ? html`<img class="feedback-shot" src=${pending.image} alt="Annotated screenshot" />`
            : pending.mode === 'todo'
              ? null
              : html`<p class="muted small" style=${{ marginTop: 0 }}>
                  No screenshot (capture declined or unsupported) — the note files on its own.
                </p>`}
          <${Field} label=${pending.mode === 'todo' ? 'What needs to change?' : 'What should be improved?'}>
            <textarea class="feedback-note" autoFocus rows="3" value=${note}
              placeholder=${pending.mode === 'todo'
                ? 'e.g. Add a keyboard shortcut for closing the day'
                : 'e.g. This meter is too subtle — needs stronger color'}
              onInput=${(e) => setNote(e.target.value)}
              onKeyDown=${(e) => {
                e.stopPropagation();
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && note.trim()) save();
              }} />
          <//>
          <div class="row-end">
            <button class="btn" onClick=${() => setPending(null)}>Cancel</button>
            <button class="btn btn-primary" disabled=${!note.trim() || busy} onClick=${save}>
              ${pending.mode === 'todo' ? 'Add todo' : 'Save feedback'}</button>
          </div>
      <//>` : null}
  `;
}
