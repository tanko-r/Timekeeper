// Where each entry sits on the way to billing, for the calendar's Status
// lens (2026-09-29 feedback: "show me unexported and unfinalized time on
// each day"). Pure and import-free so node:test can exercise it directly.
//
//   unfinalized — still a draft (including one exported once, then reopened:
//                 it has to be finalized and sent again)
//   unexported  — finalized, never sent to billing
//   exported    — finalized and sent

export function pipelineBucket(entry) {
  if (entry.status !== 'finalized') return 'unfinalized';
  return entry.exported_at ? 'exported' : 'unexported';
}

const round = (n) => Math.round(n * 10000) / 10000;
const empty = () => ({ unfinalized: 0, unexported: 0, exported: 0, total: 0 });

// Map of date → hours per bucket. Days with no entries are absent.
export function pipelineByDay(entries) {
  const days = new Map();
  for (const e of entries || []) {
    if (!days.has(e.date)) days.set(e.date, empty());
    const d = days.get(e.date);
    const h = Number(e.total) || 0;
    const b = pipelineBucket(e);
    d[b] = round(d[b] + h);
    d.total = round(d.total + h);
  }
  return days;
}

// Adds day summaries (undefined = a day with no entries).
export function sumPipeline(days) {
  const t = empty();
  for (const d of days) {
    if (!d) continue;
    for (const k of Object.keys(t)) t[k] = round(t[k] + d[k]);
  }
  return t;
}
