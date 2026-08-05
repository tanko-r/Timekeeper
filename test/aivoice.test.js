// The voice layer end-to-end (spec 2026-08-01): AI-authored narratives are
// flagged, editing clears the flag, and only unflagged text is ever taught
// back to the model as "the attorney's voice".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { buildVoiceContext, SEED_PAIRS } from '../server/routes/ai.js';

async function withServer(fn) {
  const t = await startTestServer();
  try { return await fn(t); } finally { await t.close(); }
}

async function makeCm(t, cm_number = '100001-000012', short_name = 'Cedar Lease') {
  return (await t.fetchJson('POST', '/api/cms', { cm_number, short_name })).body;
}

// Only finalized entries teach (2026-08-04): a draft autosaves every 600ms, so
// its narrative is a moving target. Tests that expect an entry in the pool must
// sign it off the way David does.
function finalize(t, id) {
  t.db.prepare("UPDATE entries SET status='finalized', ever_finalized=1 WHERE id=?").run(id);
}

// ── capture path ──────────────────────────────────────────────────────────

test('POST /api/entries records narrative_ai and ai_brief', async () => {
  await withServer(async (t) => {
    const cm = await makeCm(t);
    const r = await t.fetchJson('POST', '/api/entries', {
      date: '2026-08-01', cm_id: cm.id,
      narrative: 'Review Cedar Lease and confer with client regarding same.',
      narrative_ai: true, ai_brief: 'rev lease; conf w client',
    });
    assert.equal(r.status, 201);
    const row = t.db.prepare('SELECT narrative_ai, ai_brief FROM entries WHERE id=?').get(r.body.id);
    assert.equal(row.narrative_ai, 1);
    assert.equal(row.ai_brief, 'rev lease; conf w client');
  });
});

test('an entry typed by hand is not flagged as AI', async () => {
  await withServer(async (t) => {
    const cm = await makeCm(t);
    const r = await t.fetchJson('POST', '/api/entries', {
      date: '2026-08-01', cm_id: cm.id, narrative: 'Review Cedar Lease.',
    });
    assert.equal(t.db.prepare('SELECT narrative_ai FROM entries WHERE id=?')
      .get(r.body.id).narrative_ai, 0);
  });
});

test('editing an AI narrative clears the AI flag', async () => {
  await withServer(async (t) => {
    const cm = await makeCm(t);
    const r = await t.fetchJson('POST', '/api/entries', {
      date: '2026-08-01', cm_id: cm.id,
      narrative: 'Review Cedar Lease and confer with client regarding same.',
      narrative_ai: true, ai_brief: 'rev lease; conf w client',
    });
    await t.fetchJson('PATCH', `/api/entries/${r.body.id}`, {
      narrative: 'Review and analyze Cedar Lease; confer with client regarding same.',
    });
    const row = t.db.prepare('SELECT narrative_ai, ai_brief FROM entries WHERE id=?').get(r.body.id);
    assert.equal(row.narrative_ai, 0, 'a correction makes the entry the attorney\'s own');
    assert.equal(row.ai_brief, 'rev lease; conf w client', 'the brief survives, forming a pair');
  });
});

test('patching an unrelated field leaves the AI flag alone', async () => {
  await withServer(async (t) => {
    const cm = await makeCm(t);
    const r = await t.fetchJson('POST', '/api/entries', {
      date: '2026-08-01', cm_id: cm.id, narrative: 'Review Cedar Lease today.',
      narrative_ai: true, ai_brief: 'rev lease',
    });
    await t.fetchJson('PATCH', `/api/entries/${r.body.id}`, { billable: false });
    assert.equal(t.db.prepare('SELECT narrative_ai FROM entries WHERE id=?')
      .get(r.body.id).narrative_ai, 1);
  });
});

test('re-sending identical narrative text does not clear the flag', async () => {
  await withServer(async (t) => {
    const cm = await makeCm(t);
    const text = 'Review Cedar Lease and confer with client regarding same.';
    const r = await t.fetchJson('POST', '/api/entries', {
      date: '2026-08-01', cm_id: cm.id, narrative: text,
      narrative_ai: true, ai_brief: 'rev lease',
    });
    await t.fetchJson('PATCH', `/api/entries/${r.body.id}`, { narrative: text });
    assert.equal(t.db.prepare('SELECT narrative_ai FROM entries WHERE id=?')
      .get(r.body.id).narrative_ai, 1, 'an autosave of unchanged text is not a correction');
  });
});

// ── buildVoiceContext ─────────────────────────────────────────────────────

test('buildVoiceContext omits AI-authored narratives from the exemplars', async () => {
  await withServer(async (t) => {
    const cm = await makeCm(t);
    const ai = await t.fetchJson('POST', '/api/entries', {
      date: '2026-08-01', cm_id: cm.id,
      narrative: 'Correspondence with client by email or other electronic means regarding matters.',
      narrative_ai: true, ai_brief: 'email client',
    });
    const mine = await t.fetchJson('POST', '/api/entries', {
      date: '2026-08-01', cm_id: cm.id,
      narrative: 'Review Cedar Lease and confer with client regarding same.',
    });
    finalize(t, ai.body.id);
    finalize(t, mine.body.id);
    const v = buildVoiceContext(t.db, { cmId: cm.id, brief: 'rev lease' });
    assert.match(v.prompt, /Review Cedar Lease and confer with client/);
    assert.doesNotMatch(v.prompt, /electronic means/,
      'the model must never be taught from its own output');
  });
});

test('buildVoiceContext includes the shortcuts glossary', async () => {
  await withServer(async (t) => {
    await t.fetchJson('POST', '/api/shortcuts', {
      abbrev: 'psa', phrase: 'Purchase and Sale Agreement',
    });
    const v = buildVoiceContext(t.db, {});
    assert.match(v.prompt, /psa = Purchase and Sale Agreement/);
  });
});

test('buildVoiceContext falls back to seed pairs when no real pairs exist', async () => {
  await withServer(async (t) => {
    const v = buildVoiceContext(t.db, {});
    assert.equal(v.turns.length, SEED_PAIRS.length * 2);
    assert.equal(v.turns[0].role, 'user');
    assert.equal(v.turns[1].role, 'assistant');
  });
});

test('buildVoiceContext promotes a corrected entry into a real few-shot pair', async () => {
  await withServer(async (t) => {
    const cm = await makeCm(t);
    const r = await t.fetchJson('POST', '/api/entries', {
      date: '2026-08-01', cm_id: cm.id,
      narrative: 'Correspondence with client regarding various matters of the lease.',
      narrative_ai: true, ai_brief: 'emailed jane about the lease',
    });
    // David corrects it — the correction becomes the teaching example.
    await t.fetchJson('PATCH', `/api/entries/${r.body.id}`, {
      narrative: 'Email with J. Curtis regarding Cedar Lease.',
    });
    finalize(t, r.body.id);
    const v = buildVoiceContext(t.db, { cmId: cm.id, brief: 'emailed bob about the easement' });
    const briefs = v.turns.filter((x) => x.role === 'user').map((x) => x.content);
    const answers = v.turns.filter((x) => x.role === 'assistant').map((x) => x.content);
    assert.ok(briefs.some((b) => b.includes('emailed jane about the lease')));
    assert.ok(answers.includes('Email with J. Curtis regarding Cedar Lease.'));
  });
});

test('buildVoiceContext holds the slot count flat as the pool grows', async () => {
  await withServer(async (t) => {
    const cm = await makeCm(t);
    for (let i = 0; i < 40; i++) {
      const e = await t.fetchJson('POST', '/api/entries', {
        date: '2026-08-01', cm_id: cm.id,
        narrative: `Review agreement number ${i} and confer with client regarding same.`,
        ai_brief: `rev agmt ${i}`,
      });
      finalize(t, e.body.id);
    }
    const v = buildVoiceContext(t.db, { cmId: cm.id, brief: 'rev agmt' });
    assert.ok(v.turns.length <= 12, `expected at most 6 pairs, got ${v.turns.length / 2}`);
  });
});

test('buildVoiceContext is safe with no database', () => {
  assert.deepEqual(buildVoiceContext(null, {}), { prompt: '', turns: [] });
});

// Regression guard for a measured failure (2026-08-01): prose rules could not
// stop the model resolving an unmatchable first name to a surname borrowed
// from the exemplars — "mike" came back as a real client contact's name, which
// in a billing narrative means billing a conference with the wrong person.
// Two demonstration pairs fixed what two rule rewrites could not, so they are
// load-bearing, not decorative.
test('seed pairs demonstrate keeping an unmatchable name as typed', () => {
  const keepsName = SEED_PAIRS.find((p) => /\bmike\b/i.test(p.brief));
  assert.ok(keepsName, 'a seed pair must demonstrate the bare-first-name case');
  assert.match(keepsName.narrative, /\bMike\b/,
    'the demonstrated output keeps the name the attorney typed');
  assert.doesNotMatch(keepsName.narrative, /\bM\.\s*[A-Z][a-z]+/,
    'it must not demonstrate inventing a surname');
});

test('seed pairs demonstrate leaving an unnamed party unnamed', () => {
  const keepsParty = SEED_PAIRS.find((p) => /\bcounty\b/i.test(p.brief));
  assert.ok(keepsParty, 'a seed pair must demonstrate the generic-party case');
  assert.match(keepsParty.narrative, /\bCounty\b/);
});

test('no seed pair duplicates an eval brief', async () => {
  // A seed whose brief matches a test input makes the model echo the seed and
  // then pad — it silently corrupts the eval it is meant to be measured by.
  const { readFile } = await import('node:fs/promises');
  const evalSrc = await readFile(new URL('../scripts/ai-eval.mjs', import.meta.url), 'utf8');
  for (const p of SEED_PAIRS) {
    assert.ok(!evalSrc.includes(`'${p.brief}'`),
      `seed pair "${p.brief}" also appears as an eval brief`);
  }
});

// Reopening a flagged entry does not restore the client's in-session record of
// what the model produced. If the editor asserted narrative_ai on every save,
// an unrelated edit (a date fix) would silently strip the flag and leak AI
// text into the pool. Omitting the field leaves the server's rule in charge.
test('a save that omits narrative_ai leaves the stored flag intact', async () => {
  await withServer(async (t) => {
    const cm = await makeCm(t);
    const r = await t.fetchJson('POST', '/api/entries', {
      date: '2026-08-01', cm_id: cm.id,
      narrative: 'Review Cedar Lease and confer with client regarding same.',
      narrative_ai: true, ai_brief: 'rev lease',
    });
    await t.fetchJson('PATCH', `/api/entries/${r.body.id}`, { date: '2026-08-02' });
    assert.equal(t.db.prepare('SELECT narrative_ai FROM entries WHERE id=?')
      .get(r.body.id).narrative_ai, 1);
  });
});

// ── teach only from the signed-off version ────────────────────────────────

test('a draft entry never reaches the exemplars or the pairs', async () => {
  await withServer(async (t) => {
    const cm = await makeCm(t);
    await t.fetchJson('POST', '/api/entries', {
      date: '2026-08-01', cm_id: cm.id,
      narrative: 'Review Cedar Lease and confer with client regarding same.',
      // deliberately unlike any seed brief, so a hit can only come from the pool
      ai_brief: 'rev cedar dox; ping counsel',
    });
    const v = buildVoiceContext(t.db, { cmId: cm.id, brief: 'rev cedar' });
    assert.doesNotMatch(v.prompt, /Cedar Lease and confer/,
      'a draft is still being edited — it is not what David stands behind');
    assert.ok(v.turns.every((x) => !x.content.includes('rev cedar dox')));
  });
});

test('finalizing the same entry admits it', async () => {
  await withServer(async (t) => {
    const cm = await makeCm(t);
    const r = await t.fetchJson('POST', '/api/entries', {
      date: '2026-08-01', cm_id: cm.id,
      narrative: 'Review Cedar Lease and confer with client regarding same.',
      ai_brief: 'rev lease; conf w client',
    });
    finalize(t, r.body.id);
    const v = buildVoiceContext(t.db, { cmId: cm.id, brief: 'rev lease' });
    assert.match(v.prompt, /Cedar Lease and confer/);
  });
});

// ── ai_draft: keep what the model got wrong ───────────────────────────────

test('ai_draft records the model output and survives the correction', async () => {
  await withServer(async (t) => {
    const cm = await makeCm(t);
    const draft = 'Correspondence with client by email regarding various matters of the lease.';
    const r = await t.fetchJson('POST', '/api/entries', {
      date: '2026-08-01', cm_id: cm.id, narrative: draft,
      narrative_ai: true, ai_brief: 'emailed jane re lease', ai_draft: draft,
    });
    await t.fetchJson('PATCH', `/api/entries/${r.body.id}`, {
      narrative: 'Email with J. Curtis regarding Cedar Lease.',
    });
    const row = t.db.prepare('SELECT narrative, ai_draft, ai_brief, narrative_ai FROM entries WHERE id=?')
      .get(r.body.id);
    assert.equal(row.ai_draft, draft, 'what the model wrote is preserved');
    assert.equal(row.narrative, 'Email with J. Curtis regarding Cedar Lease.');
    assert.equal(row.narrative_ai, 0);
    assert.equal(row.ai_brief, 'emailed jane re lease');
  });
});

test('a later save without ai_draft does not erase the stored draft', async () => {
  await withServer(async (t) => {
    const cm = await makeCm(t);
    const draft = 'Correspondence with client regarding various matters.';
    const r = await t.fetchJson('POST', '/api/entries', {
      date: '2026-08-01', cm_id: cm.id, narrative: draft,
      narrative_ai: true, ai_brief: 'emailed jane', ai_draft: draft,
    });
    await t.fetchJson('PATCH', `/api/entries/${r.body.id}`, { date: '2026-08-02' });
    assert.equal(t.db.prepare('SELECT ai_draft FROM entries WHERE id=?')
      .get(r.body.id).ai_draft, draft);
  });
});

test('a fresh generation replaces the stored draft', async () => {
  await withServer(async (t) => {
    const cm = await makeCm(t);
    const r = await t.fetchJson('POST', '/api/entries', {
      date: '2026-08-01', cm_id: cm.id, narrative: 'First draft text.',
      narrative_ai: true, ai_brief: 'x', ai_draft: 'First draft text.',
    });
    await t.fetchJson('PATCH', `/api/entries/${r.body.id}`, {
      narrative: 'Second draft text.', narrative_ai: 1, ai_draft: 'Second draft text.',
    });
    assert.equal(t.db.prepare('SELECT ai_draft FROM entries WHERE id=?')
      .get(r.body.id).ai_draft, 'Second draft text.');
  });
});
