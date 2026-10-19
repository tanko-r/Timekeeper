// Ghost-text autocomplete for a PLAIN DOM field — the float timer's narrative
// box (lib/pip.js, 2026-10-08 feedback: "ghost text should work on the float
// timer too"). The float is hand-built DOM in a Document Picture-in-Picture
// window, so it can't mount the React GhostInput; this is the same behaviour
// without React:
//   - a grey completion from the matter's phrasebook / dictionary (ghostMatch)
//   - Tab accepts it (applyGhost — fixes the typed prefix's case)
//   - ↓ while a ghost shows opens the candidate list; ↑/↓ move, Enter/Tab
//     pick, Escape closes just the list
// Same class names as GhostInput (.ghost-wrap / .ghost-mirror / .ghost-hint /
// .ghost-list), so either stylesheet styles it.
//
// Works in any document: it builds nodes with field.ownerDocument, never the
// global `document`. Relative import so it needs no browser-absolute path.
import { ghostMatch, applyGhost, ghostCandidates } from './ghost.js';

const EMPTY = { phrases: [], entities: [], people: [] };

// attachGhost(field, { memory }) → { wrap, setMemory(mem), detach() }
//   field   — a <textarea> or <input>, not yet (or already) in the DOM
//   memory  — { phrases: string[], entities, people } (fetchMatterMemory's
//             shape); can arrive later via setMemory()
// Append `wrap` where the field should go: it holds the field plus the mirror.
//
// Event order: the caller's own 'input' listener (shortcut expansion, draft
// save) should be added BEFORE attaching, so the ghost recomputes on the
// expanded text. keydown runs in the CAPTURE phase so the list's Escape is
// seen before the caller's Escape-collapses-the-row handler.
export function attachGhost(field, { memory = EMPTY } = {}) {
  const doc = field.ownerDocument;
  const multiline = field.tagName === 'TEXTAREA';
  let mem = memory || EMPTY;
  let ghost = null;
  let list = null; // null = closed; else { items, index }

  const wrap = doc.createElement('div');
  wrap.className = 'ghost-wrap' + (multiline ? ' multiline' : '');
  if (field.parentNode) field.parentNode.insertBefore(wrap, field);
  wrap.appendChild(field);

  const mirror = doc.createElement('div');
  mirror.className = 'ghost-mirror';
  mirror.setAttribute('aria-hidden', 'true');
  const typed = doc.createElement('span');
  typed.className = 'ghost-typed';
  const hint = doc.createElement('span');
  hint.className = 'ghost-hint';
  mirror.append(typed, hint);

  const listEl = doc.createElement('div');
  listEl.className = 'ghost-list';

  function paintGhost() {
    if (!ghost) { mirror.remove(); return; }
    typed.textContent = field.value;
    hint.textContent = ghost.text;
    if (!mirror.parentNode) wrap.insertBefore(mirror, field);
    // A scrolling textarea loses width to its scrollbar; give the mirror the
    // same inset or its text wraps at a different word than the field's.
    const bar = Math.max(0, field.offsetWidth - field.clientWidth
      - (parseFloat(doc.defaultView.getComputedStyle(field).borderLeftWidth) || 0)
      - (parseFloat(doc.defaultView.getComputedStyle(field).borderRightWidth) || 0));
    mirror.style.marginRight = bar ? `${bar}px` : '';
    mirror.scrollTop = field.scrollTop;
    mirror.scrollLeft = field.scrollLeft;
  }

  function paintList() {
    if (!list) { listEl.remove(); return; }
    listEl.replaceChildren(...list.items.map((name, i) => {
      const b = doc.createElement('button');
      b.type = 'button';
      if (i === list.index) b.className = 'on';
      b.textContent = name;
      // mousedown + preventDefault: keep focus in the field (a blur would
      // close the list and, in the float, save and maybe re-render)
      b.addEventListener('mousedown', (ev) => { ev.preventDefault(); setText(field.value + name); });
      return b;
    }));
    if (!listEl.parentNode) wrap.appendChild(listEl);
  }

  function recompute() {
    ghost = ghostMatch(field.value, field.selectionStart, mem.phrases || [], {
      entities: mem.entities || [],
      people: mem.people || [],
    });
    paintGhost();
  }

  function close() {
    ghost = null;
    list = null;
    paintGhost();
    paintList();
  }

  // A programmatic value change fires no 'input' — dispatch one so the
  // caller's own listener (draft + autosave in the float) sees the accepted
  // text exactly as if it had been typed.
  function setText(next) {
    list = null;
    paintList();
    field.value = next;
    field.setSelectionRange(next.length, next.length);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function onKeyDown(e) {
    // ↓ is free while a ghost shows: a ghost only appears with the caret at
    // the very end, where ↓ has nothing to do.
    if (e.key === 'ArrowDown' && ghost && !list) {
      const items = ghostCandidates(field.value, mem);
      if (items.length) {
        e.preventDefault();
        list = { items, index: 0 };
        paintList();
        return;
      }
    }
    if (list) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : list.items.length - 1;
        list = { ...list, index: (list.index + step) % list.items.length };
        paintList();
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        e.stopImmediatePropagation();
        setText(field.value + list.items[list.index]);
        return;
      }
      if (e.key === 'Escape') {
        // close only the list — not the row / close-out pane around it
        e.preventDefault();
        e.stopImmediatePropagation();
        list = null;
        paintList();
        return;
      }
      list = null; // any other key resumes typing
      paintList();
    }
    if (e.key === 'Tab' && ghost && !e.shiftKey) {
      e.preventDefault();
      e.stopImmediatePropagation();
      const next = applyGhost(field.value, ghost);
      ghost = null;
      paintGhost();
      setText(next);
    }
  }

  const onScroll = () => { mirror.scrollTop = field.scrollTop; mirror.scrollLeft = field.scrollLeft; };

  field.addEventListener('keydown', onKeyDown, true);
  field.addEventListener('input', recompute);
  field.addEventListener('keyup', recompute); // caret moved by arrows / Home / End
  field.addEventListener('click', recompute);
  field.addEventListener('select', recompute);
  field.addEventListener('scroll', onScroll);
  field.addEventListener('blur', close);

  return {
    wrap,
    setMemory(next) {
      mem = next || EMPTY;
      if (doc.activeElement === field) recompute();
    },
    detach() {
      field.removeEventListener('keydown', onKeyDown, true);
      field.removeEventListener('input', recompute);
      field.removeEventListener('keyup', recompute);
      field.removeEventListener('click', recompute);
      field.removeEventListener('select', recompute);
      field.removeEventListener('scroll', onScroll);
      field.removeEventListener('blur', close);
      close();
    },
  };
}
