// Thin JSON API client. 401s flip the app into the login screen via an event;
// other errors surface as toasts (listener lives in app.js).

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

export function downloadText(filename, text, mime = 'text/csv') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
