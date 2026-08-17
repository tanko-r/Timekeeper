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
  //
  // Most carry a TEMPLATE NARRATIVE — the opening words every entry that timer
  // opens starts with, so a stop only has to finish the sentence. It is the
  // point of a per-matter timer button and it was invisible in this dataset
  // until 2026-08-16, which read as the feature being missing. One timer is
  // deliberately left without a template, so both states are on screen.
  const timers = {};
  timers.lease = await post('/api/timers', {
    name: 'Acme — lease dispute', cm_id: matters.lease.id, task_code: 'Review',
    narrative_template: 'Review correspondence and lease provisions regarding',
  });
  timers.merger = await post('/api/timers', {
    name: 'Acme — merger', cm_id: matters.merger.id, task_code: 'Draft',
    narrative_template: 'Draft and revise merger agreement provisions concerning',
  });
  timers.diligence = await post('/api/timers', {
    name: 'Northgate — diligence', cm_id: matters.diligence.id, task_code: 'Due Diligence',
    narrative_template: 'Review diligence materials and update the issues list regarding',
  });
  timers.appeal = await post('/api/timers', {
    name: 'Verity — appeal brief', cm_id: matters.appeal.id, task_code: 'Draft',
  });
  timers.quick = await post('/api/timers', { name: '' });

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

  const bulk = await seedScale(post, patch, today);

  // LAST, because timers are exclusive: every start in the bulk layer above
  // stops whatever else was running, so the one running timer has to be the
  // last start in the file. A running timer among eighty-four idle ones is the
  // single hardest thing for this board to make unmistakable, so the demo must
  // always have one.
  await post(`/api/timers/${timers.merger.id}/start`, {});

  return { matters, timers, bulk };
}

// ---------------------------------------------------------------------------
// THE BOARD AT REAL DENSITY (2026-08-16, owner: "I use dozens")
//
// The hand-built dataset above is five timers, and five timers hide the design
// problem the owner actually has. His live database carries EIGHTY-THREE. A
// board that reads well at five is a wall of tiles at eighty-three, and every
// question worth asking — what is on screen by default, how he reaches a
// dormant matter, whether grouping earns its place, whether the entries list is
// still reachable without scrolling past his whole practice — only has an
// answer at that scale.
//
// So the demo carries eighty-five. The distribution matters as much as the
// count, and it is drawn from how a practice actually looks:
//
//   • a long tail that is DORMANT. Most matters are open and untouched this
//     week. They must be findable and must not be in the way.
//   • names that COLLIDE. A dozen matters share a client prefix, so "scan for
//     the right one" is genuinely hard and the filter has to carry real weight.
//   • names that are LONG. Truncation is the normal case, not the edge case.
//   • a handful worked TODAY — the working set the board exists to serve.
//
// Every name is invented. No real client, matter or person may enter this repo.
// ---------------------------------------------------------------------------
const BULK_CLIENTS = [
  ['Acme Holdings', '100001', [
    ['Acme — Borealis merger: HSR clearance', 'Corporate'],
    ['Acme — Borealis merger: disclosure schedules', 'Corporate'],
    ['Acme — office lease, Harbor Street', 'Real estate'],
    ['Acme — office sublease, Fremont annex', 'Real estate'],
    ['Acme — supplier arbitration', 'Litigation'],
    ['Acme — employment: Reyes separation', 'Litigation'],
    ['Acme — trademark opposition (EU)', 'Corporate'],
    ['Acme — general corporate advice', 'Corporate'],
  ]],
  ['Northgate Partners', '100244', [
    ['Northgate — fund IV formation', 'Corporate'],
    ['Northgate — diligence: Sandpiper', 'Corporate'],
    ['Northgate — diligence: Kestrel Logistics', 'Corporate'],
    ['Northgate — LP side letters', 'Corporate'],
    ['Northgate — regulatory examination', 'Litigation'],
    ['Northgate — co-investment vehicle', 'Corporate'],
  ]],
  ['Verity Labs', '100377', [
    ['Verity — appeal, Ninth Circuit', 'Litigation'],
    ['Verity — patent licence renegotiation', 'Corporate'],
    ['Verity — clinical trial agreements', 'Corporate'],
    ['Verity — data protection audit', 'Corporate'],
    ['Verity — export controls review', 'Corporate'],
  ]],
  ['Harbor Lease Trust', '100455', [
    ['Harbor — estoppel certificates', 'Real estate'],
    ['Harbor — ground lease restructuring', 'Real estate'],
    ['Harbor — tenant default, Unit 4C', 'Litigation'],
    ['Harbor — CAM reconciliation dispute', 'Litigation'],
    ['Harbor — refinancing, tranche B', 'Real estate'],
  ]],
  ['Sandpiper Foods', '100512', [
    ['Sandpiper — supply agreement renewal', 'Corporate'],
    ['Sandpiper — recall response', 'Litigation'],
    ['Sandpiper — distribution: Midwest', 'Corporate'],
    ['Sandpiper — labelling compliance', 'Corporate'],
  ]],
  ['Kestrel Logistics', '100603', [
    ['Kestrel — fleet financing', 'Corporate'],
    ['Kestrel — driver classification claim', 'Litigation'],
    ['Kestrel — warehouse lease, Dock 9', 'Real estate'],
    ['Kestrel — insurance coverage dispute', 'Litigation'],
    ['Kestrel — cross-border customs advice', 'Corporate'],
  ]],
  ['Meridian Health', '100711', [
    ['Meridian — physician group affiliation', 'Corporate'],
    ['Meridian — HIPAA incident review', 'Corporate'],
    ['Meridian — payor contract renewals', 'Corporate'],
    ['Meridian — medical staff bylaws', 'Corporate'],
    ['Meridian — Stark self-disclosure', 'Corporate'],
  ]],
  ['Ellison Family Office', '100822', [
    ['Ellison — trust restructuring', 'Corporate'],
    ['Ellison — art collection loan agreement', 'Corporate'],
    ['Ellison — vineyard acquisition', 'Real estate'],
    ['Ellison — succession planning memo', 'Corporate'],
  ]],
  ['Calder Manufacturing', '100933', [
    ['Calder — plant expansion permitting', 'Real estate'],
    ['Calder — union grievance arbitration', 'Litigation'],
    ['Calder — environmental consent decree', 'Litigation'],
    ['Calder — equipment purchase, line 3', 'Corporate'],
    ['Calder — product liability, Model 7', 'Litigation'],
  ]],
  ['Ridgeway Capital', '101044', [
    ['Ridgeway — credit facility amendment', 'Corporate'],
    ['Ridgeway — portfolio company governance', 'Corporate'],
    ['Ridgeway — secondary sale, Fund II', 'Corporate'],
    ['Ridgeway — management fee dispute', 'Litigation'],
  ]],
  ['Whitlock Energy', '101155', [
    ['Whitlock — solar site acquisition', 'Real estate'],
    ['Whitlock — PPA negotiation, Basin 2', 'Corporate'],
    ['Whitlock — FERC filing response', 'Litigation'],
    ['Whitlock — turbine supply dispute', 'Litigation'],
    ['Whitlock — interconnection agreement', 'Corporate'],
  ]],
  ['Peregrine Media', '101266', [
    ['Peregrine — talent agreements, season 3', 'Corporate'],
    ['Peregrine — defamation claim, Hollis', 'Litigation'],
    ['Peregrine — music licensing clearance', 'Corporate'],
    ['Peregrine — studio lease, Stage 6', 'Real estate'],
    ['Peregrine — distribution: international', 'Corporate'],
  ]],
  ['Thornbury Insurance', '101377', [
    ['Thornbury — reinsurance treaty renewal', 'Corporate'],
    ['Thornbury — bad faith claim, Okafor', 'Litigation'],
    ['Thornbury — regulatory market conduct exam', 'Litigation'],
    ['Thornbury — policy wording overhaul', 'Corporate'],
    ['Thornbury — broker commission dispute', 'Litigation'],
  ]],
  ['Lyndon Grocers', '101488', [
    ['Lyndon — store acquisitions, tranche 1', 'Real estate'],
    ['Lyndon — wage and hour class action', 'Litigation'],
    ['Lyndon — private label supply terms', 'Corporate'],
    ['Lyndon — refrigeration equipment lease', 'Corporate'],
    ['Lyndon — ADA accessibility remediation', 'Litigation'],
  ]],
  ['Ashcombe University', '101599', [
    ['Ashcombe — research collaboration, MIT', 'Corporate'],
    ['Ashcombe — Title IX advisory', 'Litigation'],
    ['Ashcombe — endowment investment policy', 'Corporate'],
    ['Ashcombe — campus housing development', 'Real estate'],
    ['Ashcombe — tech transfer licensing', 'Corporate'],
  ]],
  ['Fairweather Pro Bono', '900001', [
    ['Fairweather — asylum petition', 'Pro bono'],
    ['Fairweather — housing clinic intake', 'Pro bono'],
    ['Fairweather — expungement clinic', 'Pro bono'],
  ]],
];

const TEMPLATES = {
  Litigation: 'Reviewed the pleadings and correspondence and prepared a summary regarding',
  Corporate: 'Reviewed and revised the transaction documents concerning',
  'Real estate': 'Reviewed the lease provisions and title materials regarding',
  'Pro bono': 'Met with the client and reviewed the supporting documents regarding',
};

const TASK_OF = {
  Litigation: 'Review', Corporate: 'Draft', 'Real estate': 'Review', 'Pro bono': 'Call/Conference',
};

async function seedScale(post, patch, today) {
  const groups = {};
  for (const name of ['Litigation', 'Corporate', 'Real estate', 'Pro bono', 'Internal']) {
    groups[name] = await post('/api/timer-groups', { name });
  }

  const made = [];
  for (const [client, prefix, mattersOf] of BULK_CLIENTS) {
    let n = 0;
    for (const [shortName, groupName] of mattersOf) {
      n += 1;
      const cm = await post('/api/cms', {
        cm_number: `${prefix}-${String(n * 11).padStart(6, '0')}`,
        short_name: shortName,
        client_name: client,
        billable: groupName === 'Pro bono' ? 0 : 1,
      });
      const timer = await post('/api/timers', {
        name: shortName,
        cm_id: cm.id,
        task_code: TASK_OF[groupName],
        group_id: groups[groupName].id,
        narrative_template: TEMPLATES[groupName],
      });
      made.push({ cm, timer, groupName });
    }
  }

  // THE WORKING SET. Six of the eighty-five carry time today; the rest are the
  // dormant tail. One is left running, because the board's whole job is to make
  // the running one unmistakable among eighty-four that are not.
  const worked = [made[2], made[14], made[27], made[41], made[58], made[70]].filter(Boolean);
  for (let i = 0; i < worked.length; i += 1) {
    const w = worked[i];
    await post(`/api/timers/${w.timer.id}/start`, { minutesAgo: 30 + i * 25 });
    const stop = await post(`/api/timers/${w.timer.id}/stop`, {});
    // Three get their sentence written; three are left unwritten, which is the
    // ordinary state of a day that is not closed out yet.
    if (i < 3 && stop && stop.entry) {
      await patch(`/api/entries/${stop.entry.id}`, {
        narrative: `${TEMPLATES[w.groupName]} ${w.cm.short_name.split('— ')[1] || w.cm.short_name}.`,
        narrative_manual: 1,
      });
    }
  }

  return made.length;
}

