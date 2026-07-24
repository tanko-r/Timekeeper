import { html, useRef, useEffect, Modal, emitToast, Icon } from '/js/ui.js';
import { downloadText } from '/js/api.js';

// Read-back view of a day/range as plain text (see lib/daysummary.js). The
// text stays selectable so a clipboard failure — denied permission, insecure
// context — never blocks copying by hand.
export function SummaryModal({ text, title, filename, onClose }) {
  const preRef = useRef(null);

  // Focus the text on open so Ctrl+A / Ctrl+C work straight away and the
  // modal is reachable from the keyboard alone.
  useEffect(() => { preRef.current?.focus(); }, []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      emitToast('Summary copied to clipboard');
    } catch {
      emitToast('Could not copy — select the text and copy it by hand.', { error: true });
    }
  }

  return html`
    <${Modal} title=${title} onClose=${onClose} wide=${true}>
      <pre class="summary-text" tabIndex="0" ref=${preRef} aria-label="Summary text">${text}</pre>
      <div class="row-end">
        <button class="btn" onClick=${() => downloadText(filename, text, 'text/plain')}>
          <${Icon} name="download" size=${16} /> Download .txt</button>
        <button class="btn btn-primary" onClick=${copy}>
          <${Icon} name="clipboard" size=${16} /> Copy</button>
      </div>
    <//>`;
}
