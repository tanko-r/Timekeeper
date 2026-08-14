// Fictional demo dataset for UI screenshots and design review.
//
// Every name here is invented (Acme et al., the house fictional client) — no
// real client, matter, or person may ever enter this repo. The data is shaped
// to exercise the states a design pass has to survive: a running timer, idle
// timers, a matterless quick timer, entries with multiple task lines, a
// finalized entry, a draft that fails validation (no narrative), a
// non-billable matter, and a day that misses the daily target.
export async function seedDemo(base, { today }) {
  const post = async (path, body) => {
    const res = await fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`POST ${path} → ${res.status} ${await res.text()}`);
    return res.json();
  };
  const patch = async (path, body) => {
    const res = await fetch(base + path, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`PATCH ${path} → ${res.status} ${await res.text()}`);
    return res.json();
  };

  const dayBefore = (n) => {
    const d = new Date(`${today}T12:00:00`);
    d.setDate(d.getDate() - n);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  const matters = {};
  const mk = async (key, cm_number, short_name, opts = {}) => {
    matters[key] = await post('/api/cms', { cm_number, short_name, billable: 1, ...opts });
  };

  await mk('lease', '100001-000012', 'Acme lease dispute', { client_name: 'Acme Holdings', favorite: 1 });
  await mk('merger', '100001-000031', 'Acme — Borealis merger', { favorite: 1 });
  await mk('diligence', '100244-000002', 'Northgate diligence', { client_name: 'Northgate Partners' });
  await mk('appeal', '100377-000004', 'Verity appeal', { client_name: 'Verity Labs' });
  await mk('admin', '999000-000001', 'Firm administration', { client_name: 'Internal', billable: 0 });

  // Timers: one running, two idle with time on the clock, one quick timer.
  const timers = {};
  timers.lease = await post('/api/timers', {
    name: 'Acme — lease dispute', cm_id: matters.lease.id, task_code: 'Review',
  });
  timers.merger = await post('/api/timers', {
    name: 'Acme — merger', cm_id: matters.merger.id, task_code: 'Draft',
  });
  timers.diligence = await post('/api/timers', {
    name: 'Northgate — diligence', cm_id: matters.diligence.id, task_code: 'Due Diligence',
  });
  timers.appeal = await post('/api/timers', {
    name: 'Verity — appeal brief', cm_id: matters.appeal.id, task_code: 'Draft',
  });
  timers.quick = await post('/api/timers', { name: '' });

  await post(`/api/timers/${timers.merger.id}/start`, {});

  // Entries for today: two solid drafts, one finalized, one that fails
  // validation (blank narrative) so the day view shows a real warning.
  const lease = await post('/api/entries', {
    date: today, cm_id: matters.lease.id, source: 'timer',
    tasks: [
      { task_code: 'Review', duration: 1.4, fragment: 'reviewed the landlord’s termination notice and the underlying lease' },
      { task_code: 'Correspondence', duration: 0.3, fragment: 'corresponded with client regarding response options' },
    ],
  });
  await post('/api/entries', {
    date: today, cm_id: matters.merger.id, source: 'timer',
    tasks: [
      { task_code: 'Draft', duration: 2.1, fragment: 'drafted the disclosure schedules for the merger agreement' },
      { task_code: 'Call/Conference', duration: 0.5, fragment: 'conferred with opposing counsel regarding closing mechanics' },
    ],
  });
  await post('/api/entries', {
    date: today, cm_id: matters.diligence.id,
    tasks: [{ task_code: 'Due Diligence', duration: 0.8, fragment: '' }],
  });
  await post('/api/entries', {
    date: today, cm_id: matters.admin.id, billable: 0,
    tasks: [{ task_code: 'Review', duration: 0.4, fragment: 'reviewed internal conflicts memo' }],
  });

  // Prior days: a finalized, exported-looking week so Calendar, Stats, and
  // Export all have something real to render.
  for (let i = 1; i <= 9; i += 1) {
    const d = dayBefore(i);
    const e1 = await post('/api/entries', {
      date: d, cm_id: matters.lease.id, source: 'timer',
      // A one-line entry never auto-builds a narrative (buildNarrative needs
      // two substantive lines), so this one carries its own.
      narrative: 'Reviewed correspondence from opposing counsel and prepared a summary of the open issues for the client.',
      tasks: [
        { task_code: 'Review', duration: 1.2 + (i % 3) * 0.4, fragment: 'reviewed correspondence and prepared summary of open issues' },
      ],
    });
    const e2 = await post('/api/entries', {
      date: d, cm_id: matters.appeal.id,
      tasks: [
        { task_code: 'Draft', duration: 2.3 - (i % 4) * 0.3, fragment: 'drafted the statement of facts for the opening brief' },
        { task_code: 'Research', duration: 0.9, fragment: 'researched the standard of review in the Ninth Circuit' },
      ],
    });
    if (i > 1) {
      await post(`/api/entries/${e1.id}/finalize`, {});
      await post(`/api/entries/${e2.id}/finalize`, {});
    }
  }

  // One finalized entry today, so the day view shows the locked state next to
  // drafts and the finalize flow has something already done.
  await post(`/api/entries/${lease.id}/finalize`, {}).catch(() => {});
  await patch('/api/settings', { target: { daily: 8 } }).catch(() => {});

  return { matters, timers };
}
