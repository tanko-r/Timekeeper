import { api } from '/js/api.js';
import { html, useState, useEffect, useRef, useCallback } from '/js/ui.js';
import { ghostCompletion } from '/js/lib/ghost.js';

// Ghost-text narrative autocomplete (spec §6): a grey inline completion from
// the matter's phrasebook; Tab accepts. Deterministic — no LLM. Reusable:
// the entry editor mounts it now; Phase 4's close-out mounts the same
// component. NOT used in quick-capture (decided).

// --- phrasebook fetch, cached per matter (60s TTL, module-level) ---
const cache = new Map(); // cmId -> { at, phrases }
const TTL = 60_000;

// One shared empty pool, so "nothing on offer" keeps a stable identity across
// renders (GhostInput and its callers use the pool as a dependency).
const NO_PHRASES = Object.freeze([]);

// DATA INTEGRITY (docs/ui/BRIEF.md, "Data integrity: non-negotiable"): a
// phrase pool belongs to exactly one matter and may never be offered for
// another one, not even between two matters of the same client. So the pool is
// stored WITH the matter it was fetched for and handed out only on a match.
// The match is checked during render, not inside the effect, which means there
// is no window — not one frame, and not the length of a slow round trip —
// where the previous matter's sentences are still completable. An empty pool
// while the new matter's phrasebook is in flight is the correct behaviour:
// offering nothing is always safe, offering the previous matter's sentence
// never is.
export function useMatterSuggestions(cmId) {
  const [pool, setPool] = useState({ cmId: null, phrases: NO_PHRASES });
  useEffect(() => {
    if (!cmId) { setPool({ cmId: null, phrases: NO_PHRASES }); return undefined; }
    const hit = cache.get(cmId);
    // Only trust a cached HIT once the phrasebook has something in it — a
    // matter with zero phrases (brand new, or picked before its first entry
    // is saved) would otherwise wedge "no suggestions" in place for the
    // full TTL, hiding phrases added moments later in the same session.
    if (hit && hit.phrases.length > 0 && Date.now() - hit.at < TTL) {
      setPool({ cmId, phrases: hit.phrases });
      return undefined;
    }
    let alive = true;
    api.get(`/api/matters/${cmId}/suggestions`)
      .then((r) => {
        const texts = r.phrases.map((p) => p.text);
        if (texts.length > 0) cache.set(cmId, { at: Date.now(), phrases: texts });
        if (alive) setPool({ cmId, phrases: texts });
      })
      .catch(() => { if (alive) setPool({ cmId, phrases: NO_PHRASES }); });
    return () => { alive = false; };
  }, [cmId]);
  return pool.cmId === cmId ? pool.phrases : NO_PHRASES;
}

// GhostInput: a drop-in <input>/<textarea> with inline ghost completion.
//   value / onChange(text)  — controlled; onChange gets TEXT, not an event
//   suggestions             — ranked phrase strings (useMatterSuggestions)
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
  value, onChange, suggestions = [], expand = null,
  multiline = false, rows = 3, onSelectionChange,
  // composed, not clobbered: callers (e.g. the entry list's inline editor)
  // get their handlers AFTER the ghost's own Tab-accept / blur-dismiss
  onKeyDown: onKeyDownProp, onBlur: onBlurProp, ...rest
}) {
  const fieldRef = useRef(null);
  const mirrorRef = useRef(null);
  const [ghost, setGhost] = useState(null);
  const pendingCaret = useRef(null);

  // Identity of `suggestions` is not stable: two call sites build the array
  // inline on every render (stopchips, close-out), so the pool is tracked by
  // its CONTENTS. ghostCompletion depends on nothing else about the array.
  const poolKey = suggestions.join('\u0000');

  const recompute = useCallback((text, caret) => {
    setGhost(ghostCompletion(text, caret, suggestions));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [poolKey]);

  // DATA INTEGRITY: a painted completion belongs to the pool it was drawn
  // from. `ghost` is otherwise recomputed only on input, select and blur, so
  // when the pool changes underneath (the entry is re-pointed at another
  // matter, or that matter's real phrasebook lands) the grey text would sit
  // there indefinitely waiting for Tab — one matter's sentence, acceptable
  // into another's entry. Drop it the moment the pool it came from is gone.
  useEffect(() => { setGhost(null); }, [poolKey]);

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
    if (e.key === 'Tab' && ghost && !e.shiftKey) {
      e.preventDefault();
      const next = value + ghost;
      pendingCaret.current = next.length;
      setGhost(null);
      onChange(next);
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
    onBlur: (e) => { setGhost(null); if (onBlurProp) onBlurProp(e); },
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
    </div>`;
}
