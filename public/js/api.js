// Thin JSON API client. 401s flip the app into the login screen via an event.
// Errors reject with ApiError; handlers that don't catch are backstopped by
// the global unhandledrejection → toast bridge in app.js.

export class ApiError extends Error {
  constructor(status, body) {
    super((body && (body.message || body.error)) || `HTTP ${status}`);
    this.status = status;
    this.body = body || {};
  }
}

async function request(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  let json = null;
  const text = await res.text();
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  if (res.status === 401) {
    window.dispatchEvent(new CustomEvent('tk:auth-required'));
    throw new ApiError(res.status, json);
  }
  if (!res.ok) throw new ApiError(res.status, json);
  return json;
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, body = {}) => request('POST', path, body),
  patch: (path, body) => request('PATCH', path, body),
  put: (path, body) => request('PUT', path, body),
  del: (path) => request('DELETE', path),
};

// Streaming POST for NDJSON endpoints (/api/ai/narrate): calls onLine(obj)
// per line as tokens arrive. Non-2xx rejects with ApiError before any line
// is delivered (the server only streams after committing to 200). An
// optional AbortSignal cancels mid-stream (rejects with AbortError) — the
// server aborts its Ollama fetch on disconnect, so this stops generation.
export async function streamNdjson(path, body, onLine, signal) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'same-origin',
    signal,
  });
  if (res.status === 401) {
    window.dispatchEvent(new CustomEvent('tk:auth-required'));
    throw new ApiError(401, null);
  }
  if (!res.ok) {
    let json = null;
    try { json = await res.json(); } catch { /* keep null */ }
    throw new ApiError(res.status, json);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) onLine(JSON.parse(line));
      }
    }
  } finally {
    // onLine can throw (e.g. a mid-stream {"error":"ai_stream_failed"} line);
    // cancel so the reader/underlying connection doesn't linger open.
    reader.cancel().catch(() => {});
  }
}

export function downloadText(filename, text, mime = 'text/csv') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
