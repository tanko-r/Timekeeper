// Pure logic for the Alt+drag UI-feedback capture (screenshot + note →
// feedback/ file + TODO.md entry). Filesystem work stays in the route.

const SECTION = '## UI feedback (screenshots)';

// Parse a browser-produced data URL into bytes. Only png/jpeg, capped size —
// this is written to disk verbatim, so be strict about what counts.
export function parseImageDataUrl(dataUrl, maxBytes = 8 * 1024 * 1024) {
  const m = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) return null;
  let buf;
  try { buf = Buffer.from(m[2], 'base64'); } catch { return null; }
  if (buf.length === 0 || buf.length > maxBytes) return null;
  return { buf, ext: m[1] === 'png' ? 'png' : 'jpg' };
}

const pad = (n) => String(n).padStart(2, '0');

// One checkbox line for TODO.md. `when` is stamped in local (box) time —
// same convention as the rest of the app's dates.
export function feedbackTodoEntry({ note, file, route, when }) {
  const d = when;
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    + ` ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const where = `${file || 'no screenshot'}${route ? ` · ${route}` : ''}`;
  return `- [ ] ${stamp} — ${note} (${where})`;
}

// Append an entry under the UI-feedback section, creating the section at the
// end of the file the first time. Idempotent about the section header.
export function appendFeedbackTodo(todoText, entry) {
  let text = String(todoText ?? '');
  if (!text.includes(SECTION)) {
    if (text.length > 0 && !text.endsWith('\n')) text += '\n';
    text += `\n${SECTION}\n\nCaptured in-app with Alt+drag. Address the item, then DELETE the\nreferenced screenshot (see CLAUDE.md).\n`;
  }
  if (!text.endsWith('\n')) text += '\n';
  return `${text}${entry}\n`;
}
