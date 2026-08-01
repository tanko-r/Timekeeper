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
    await t.fetchJson('POST', '/api/entries', {
      date: '2026-08-01', cm_id: cm.id,
      narrative: 'Correspondence with client by email or other electronic means regarding matters.',
      narrative_ai: true, ai_brief: 'email client',
    });
    await t.fetchJson('POST', '/api/entries', {
      date: '2026-08-01', cm_id: cm.id,
      narrative: 'Review Cedar Lease and confer with client regarding same.',
    });
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
      await t.fetchJson('POST', '/api/entries', {
        date: '2026-08-01', cm_id: cm.id,
        narrative: `Review agreement number ${i} and confer with client regarding same.`,
        ai_brief: `rev agmt ${i}`,
      });
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
