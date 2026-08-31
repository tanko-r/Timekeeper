import { api } from '/js/api.js';
import { html, useState, useEffect, useRef, useCallback } from '/js/ui.js';
import { ghostCompletion } from '/js/lib/ghost.js';

// Ghost-text narrative autocomplete (spec §6): a grey inline completion from
// the matter's phrasebook; Tab accepts. Deterministic — no LLM. Reusable:
// the entry editor mounts it now; Phase 4's close-out mounts the same
// component. NOT used in quick-capture (decided).

// --- suggestion fetch, cached per matter (60s TTL, module-level) ---
const cache = new Map(); // cmId -> { at, phrases, entities, people }
const TTL = 60_000;

// One fetch per matter serves both hooks. Kept as two hooks rather than one
// returning an object: useMatterSuggestions' string[] contract is used by
// StopChips, the entry list and the close-out, and changing it would touch
// all of them for no gain.
function useMatterMemory(cmId) {
  const [mem, setMem] = useState({ phrases: [], entities: [], people: [] });
  useEffect(() => {
    if (!cmId) { setMem({ phrases: [], entities: [], people: [] }); return undefined; }
    const hit = cache.get(cmId);
    // Only trust a cached HIT once the phrasebook has something in it — a
    // matter with zero phrases (brand new, or picked before its first entry
    // is saved) would otherwise wedge "no suggestions" in place for the
    // full TTL, hiding phrases added moments later in the same session.
    if (hit && hit.phrases.length > 0 && Date.now() - hit.at < TTL) {
      setMem(hit);
      return undefined;
    }
    let alive = true;
    api.get(`/api/matters/${cmId}/suggestions`)
      .then((r) => {
        const next = {
          phrases: r.phrases.map((p) => p.text),
          entities: r.entities || [],
          people: r.people || [],
        };
        if (next.phrases.length > 0) cache.set(cmId, { at: Date.now(), ...next });
        if (alive) setMem(next);
      })
      .catch(() => { if (alive) setMem({ phrases: [], entities: [], people: [] }); });
    return () => { alive = false; };
  }, [cmId]);
  return mem;
}

export function useMatterSuggestions(cmId) { return useMatterMemory(cmId).phrases; }

// The dictionary behind the ghost's second tier: the documents, organisations
// and people this matter has seen, already ranked by the server.
export function useMatterEntities(cmId) {
  const { entities, people } = useMatterMemory(cmId);
  return { entities, people };
}

// GhostInput: a drop-in <input>/<textarea> with inline ghost completion.
//   value / onChange(text)  — controlled; onChange gets TEXT, not an event
//   suggestions             — ranked phrase strings (useMatterSuggestions)
//   entities                — {entities, people} from useMatterEntities; the
//                             ghost's second tier and the ↓ candidate list
//   expand                  — optional fn(text, caret) → {text, caret}|null,
//                             applied on every input (the Task 4 shortcut
//                             engine plugs in here)
//   multiline               — textarea instead of input
//   onSelectionChange(el)   — fires on select/caret events (Task 4 uses it
//                             for the save-as-shortcut affordance)
// Rendering: a mirror <div> overlays the field (pointer-events: none); the
// typed part is transparent so the real field text shows through, and the
// ghost remainder renders grey after it. Escape is NOT used to dismiss (the
// editor modal owns Escape via a capture listener); typing past the ghost or
// moving the caret recomputes/hides it.
export function GhostInput({
  value, onChange, suggestions = [], entities = null, expand = null,
  multiline = false, rows = 3, onSelectionChange,
  // composed, not clobbered: callers (e.g. the entry list's inline editor)
  // get their handlers AFTER the ghost's own Tab-accept / blur-dismiss
  onKeyDown: onKeyDownProp, onBlur: onBlurProp, ...rest
}) {
  const fieldRef = useRef(null);
  const mirrorRef = useRef(null);
  const [ghost, setGhost] = useState(null);
  const [list, setList] = useState(null); // null = closed; else { items, index }
  const pendingCaret = useRef(null);

  const recompute = useCallback((text, caret) => {
    setGhost(ghostCompletion(text, caret, suggestions, {
      entities: entities?.entities || [],
      people: entities?.people || [],
    }));
  }, [suggestions, entities]);

  // The candidates behind the ghost: the same two lists, minus anything
  // already written. Five is enough to choose from without becoming a menu.
  function candidates() {
    const used = String(value || '').toLowerCase();
    const all = [
      ...(entities?.entities || []).map((e) => e.name),
      ...(entities?.people || []).map((p) => p.name),
    ];
    return all.filter((n) => !used.includes(n.toLowerCase())).slice(0, 5);
  }

  // Both the Tab accept and the list share this, so they cannot drift.
  function accept(textToAppend) {
    const next = value + textToAppend;
    pendingCaret.current = next.length;
    setGhost(null);
    setList(null);
    onChange(next);
  }

  // Escape must close only the candidate list, never the editor around it.
  // Modal owns Escape through a document CAPTURE listener, so a bubble
  // handler on the field runs far too late. React commits child effects
  // before parent ones, so registering here — once, at mount, reading the
  // list through a ref so the listener is never re-registered and never
  // loses its place in the order — puts this ahead of Modal's.
  const listRef = useRef(null);
  listRef.current = list;
  useEffect(() => {
    const onEscapeCapture = (e) => {
      if (e.key !== 'Escape' || !listRef.current) return;
      if (e.target !== fieldRef.current) return;
      // stopImmediatePropagation, not stopPropagation: Modal's listener is on
      // the SAME node (document), and stopPropagation only blocks other nodes.
      e.preventDefault();
      e.stopImmediatePropagation();
      setList(null);
    };
    document.addEventListener('keydown', onEscapeCapture, true);
    return () => document.removeEventListener('keydown', onEscapeCapture, true);
  }, []);

  // Native 'select' listener as a fallback to React's synthetic onSelect:
  // React's onSelect only fires from a real 'selectionchange' paired with a
  // keyboard/mouse event on the field — a purely scripted
  // setSelectionRange() + dispatched 'select' event (e.g. Task 4's
  // save-as-shortcut e2e coverage) doesn't reach it. Listening natively
  // covers both paths; harmless to run alongside the synthetic one.
  useEffect(() => {
    const el = fieldRef.current;
    if (!el) return undefined;
    const onNativeSelect = () => {
      recompute(el.value, el.selectionStart);
      if (onSelectionChange) onSelectionChange(el);
    };
    el.addEventListener('select', onNativeSelect);
    return () => el.removeEventListener('select', onNativeSelect);
  }, [recompute, onSelectionChange]);

  // after programmatic edits (expansion / Tab accept): restore the caret;
  // always: keep the mirror scrolled with the field
  useEffect(() => {
    if (pendingCaret.current != null && fieldRef.current) {
      fieldRef.current.setSelectionRange(pendingCaret.current, pendingCaret.current);
      pendingCaret.current = null;
    }
    const el = fieldRef.current;
    const mir = mirrorRef.current;
    if (el && mir) { mir.scrollTop = el.scrollTop; mir.scrollLeft = el.scrollLeft; }
  });

  function handleInput(e) {
    let text = e.target.value;
    let caret = e.target.selectionStart;
    const expanded = expand ? expand(text, caret) : null;
    if (expanded) {
      text = expanded.text;
      caret = expanded.caret;
      pendingCaret.current = caret;
    }
    recompute(text, caret);
    onChange(text);
  }

  function handleKeyDown(e) {
    // ↓ opens the candidate list. The key is free because a ghost only ever
    // appears with the caret at the very END of the text, where ↓ has nothing
    // to do. With no ghost showing, ↓ is not touched at all.
    if (e.key === 'ArrowDown' && ghost && !list) {
      const items = candidates();
      if (items.length) { e.preventDefault(); setList({ items, index: 0 }); return; }
    }
    if (list) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setList({ ...list, index: (list.index + 1) % list.items.length });
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setList({ ...list, index: (list.index + list.items.length - 1) % list.items.length });
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        accept(list.items[list.index]);
        return;
      }
      if (e.key === 'Escape') {
        // The editor modal owns Escape through a capture listener, so closing
        // the list has to stop the event here or the whole editor closes with
        // it (the precedent StopChips documents).
        e.preventDefault();
        e.stopPropagation();
        setList(null);
        return;
      }
      setList(null); // any other key resumes typing
    }
    if (e.key === 'Tab' && ghost && !e.shiftKey) {
      e.preventDefault();
      accept(ghost);
      return;
    }
    if (onKeyDownProp) onKeyDownProp(e);
  }

  const shared = {
    ref: fieldRef,
    // Every ghost field is a narrative field, so spell-check them all — and
    // do it explicitly: Chrome does not spell-check single-line inputs by
    // default, and React drops a lowercase boolean `spellcheck` prop
    // entirely (it only understands the camelCase `spellCheck`).
    spellCheck: true,
    value,
    onInput: handleInput,
    onKeyDown: handleKeyDown,
    onSelect: (e) => {
      recompute(e.target.value, e.target.selectionStart);
      if (onSelectionChange) onSelectionChange(e.target);
    },
    onBlur: (e) => { setGhost(null); setList(null); if (onBlurProp) onBlurProp(e); },
    ...rest,
  };

  return html`
    <div class=${'ghost-wrap' + (multiline ? ' multiline' : '')}>
      ${ghost ? html`
        <div class="ghost-mirror" ref=${mirrorRef} aria-hidden="true">
          <span class="ghost-typed">${value}</span><span class="ghost-hint">${ghost}</span>
        </div>` : null}
      ${multiline
        ? html`<textarea rows=${rows} ...${shared}></textarea>`
        : html`<input type="text" ...${shared} />`}
      ${list ? html`
        <div class="ghost-list">
          ${list.items.map((name, i) => html`
            <button key=${name} type="button" class=${i === list.index ? 'on' : ''}
              onMouseDown=${(ev) => { ev.preventDefault(); accept(name); }}>${name}</button>`)}
        </div>` : null}
    </div>`;
}
