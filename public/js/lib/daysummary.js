// Plain-text rendition of a day's (or range's) entries — client, matter,
// hours, narrative — for reading back and pasting into email.
//
// Pure and standalone by design: it takes already-enriched entries (the shape
// /api/entries and /api/dashboard return) and returns a string, so it runs in
// node:test and works offline against cached data. It deliberately does NOT
// import from ui.js, which needs `window`.
//
// This is a review tool, not an export — drafts, non-billable time, and
// matterless entries all appear. The Export page's own terser text blob
// (server/routes/export.js) stays as it is; that one is tied to what was
// actually sent to billing.

const WRAP = 76;
const INDENT = '  ';

function decimalsFor(increment) {
  const s = String(increment ?? 0.1);
  const dot = s.indexOf('.');
  return dot === -1 ? 1 : Math.max(1, s.length - dot - 1);
}

// Stored durations are formatted, never re-rounded — display precision must
// not change what the numbers mean.
const hours = (h, decimals) => `${Number(h || 0).toFixed(decimals)}h`;

const sum = (entries) => Math.round(entries.reduce((a, e) => a + (Number(e.total) || 0), 0) * 10000) / 10000;

function dateFull(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  return new Date(y, m - 1, d, 12).toLocaleDateString(undefined, {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });
}

// "Acme Holdings — Series B Financing (123456-000123)", degrading through a
// missing client name, a missing matter name, and a matterless entry.
function matterLabel(cm) {
  if (!cm) return '(no matter)';
  const client = String(cm.client_name || '').trim();
  const matter = String(cm.short_name || '').trim();
  const number = String(cm.cm_number || '').trim();
  const name = [client, matter].filter(Boolean).join(' — ');
  if (!name) return number ? `(${number})` : '(no matter)';
  return number ? `${name} (${number})` : name;
}

const cmp = (a, b) => String(a || '').localeCompare(String(b || ''), undefined, { sensitivity: 'base' });

function byClientThenMatter(a, b) {
  return cmp(a.cm?.client_name, b.cm?.client_name)
    || cmp(a.cm?.short_name, b.cm?.short_name)
    || ((Number(a.id) || 0) - (Number(b.id) || 0));
}

// Greedy word wrap. A token longer than the width overruns rather than being
// hyphenated — a URL stays clickable. Existing newlines are honoured.
function wrapLines(text, width) {
  const out = [];
  for (const raw of String(text).split('\n')) {
    const words = raw.trim().split(/\s+/).filter(Boolean);
    let line = '';
    for (const word of words) {
      if (!line) line = word;
      else if (line.length + 1 + word.length <= width) line += ` ${word}`;
      else { out.push(line); line = word; }
    }
    if (line) out.push(line);
  }
  return out;
}

function block(entry, decimals) {
  const tag = entry.billable ? '' : ' [non-billable]';
  const head = `${matterLabel(entry.cm)} — ${hours(entry.total, decimals)}${tag}`;
  const body = wrapLines(entry.narrative || '', WRAP);
  const lines = body.length ? body : ['(no narrative)'];
  return [head, ...lines.map((l) => INDENT + l)].join('\n');
}

export function buildDaySummary(entries, { title = '', increment = 0.1, showDates = false } = {}) {
  const decimals = decimalsFor(increment);
  const all = (entries || []).slice();

  const total = sum(all);
  const billable = sum(all.filter((e) => e.billable));
  const nonbillable = Math.round((total - billable) * 10000) / 10000;
  // The split says nothing new when it is all billable — the common case.
  const split = nonbillable > 0
    ? ` (${hours(billable, decimals)} billable / ${hours(nonbillable, decimals)} non-billable)`
    : '';
  const header = `${title} — ${hours(total, decimals)}${split}`;

  if (all.length === 0) return `${header}\n\nNo entries.`;

  let sections;
  if (showDates) {
    const dates = [...new Set(all.map((e) => e.date))].sort();
    sections = dates.map((date) => {
      const ofDay = all.filter((e) => e.date === date).sort(byClientThenMatter);
      return [`${dateFull(date)} — ${hours(sum(ofDay), decimals)}`,
        ...ofDay.map((e) => block(e, decimals))].join('\n\n');
    });
  } else {
    sections = all.sort(byClientThenMatter).map((e) => block(e, decimals));
  }

  return [header, ...sections].join('\n\n');
}
