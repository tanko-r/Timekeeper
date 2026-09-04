import { html, Modal } from '/js/ui.js';

// Interrupts a one-click export when the range holds unfinalized entries —
// those entries never carry billable time to Export by default, and skipping
// them silently would look like the day exported clean when it didn't.
export function ExportGate({ count, onClose, onFinalize, onExportAnyway }) {
  return html`
    <${Modal} title="Unfinalized entries" onClose=${onClose}>
      <p class="confirm-message">
        ${count} ${count === 1 ? 'entry is' : 'entries are'} not finalized and will
        not be included in this export.
      </p>
      <div class="row-end">
        <button class="btn" onClick=${onClose}>Cancel</button>
        <button class="btn" onClick=${() => { onFinalize(); onClose(); }}>Finalize first</button>
        <button class="btn btn-primary" onClick=${() => { onExportAnyway(); onClose(); }}>Export finalized only</button>
      </div>
    <//>`;
}
