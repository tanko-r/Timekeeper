# Running matter briefs

The app maintains a compact, source-linked brief for each recently billed matter.
The brief builder is a separate, stronger installed model from the narrative
writer. The narrative writer stays `timekeeper-narrative:v3`.

Initial selection uses the last 30 local calendar days (including today) of
**finalized, billable, nondeleted entries**. For each selected matter, the builder
reads its finalized billable history through the cutoff, in chronological chunks.
It never borrows from sibling matters. Each brief contains an overview, important
documents, people, latest recorded status, open issues, recent developments and
uncertainties. Claims distinguish literal source statements from conservatively labeled synthesis/inference
and cite exact entry IDs. Citations establish provenance; they do not certify
that a model's interpretation is correct.

At 02:00 server local time, the existing 30-second background-job tick starts
an asynchronous pass through the previous local day. After downtime it catches
up from the last successful cutoff. It also detects newly finalized, edited or
backdated entries since the prior successful pass, and invalidated existing
briefs. Late entries and changed/deleted/moved sources cause a chronological
rebuild. Otherwise only new entries plus the previous brief go to the model.
An unchanged source hash avoids inference. Failure leaves the previous version
intact; a partial nightly pass retries after 15 minutes without advancing its
successful cutoff. Timer rollover and HTTP handling continue independently.

A database lease prevents overlapping CLI, manual and nightly passes. Its
heartbeat expires after ten minutes so a crashed worker is recoverable. Each
model call has a four-minute timeout; semantic/schema/truncation failures get
one corrective retry. Every saved version retains the normalized source narrative snapshot,
identity, source hash, model, as-of date and run ID. Source changes during
inference reject the result. Empty source histories remove the current brief
while retaining previous versions for review.

Live AI requests receive a brief capped at 2,400 characters plus up to 2,300
characters of recent/relevant raw history. Query-relevant claims rank first
within each section; one claim per section gets a turn before more inventory items
are added, keeping the latest status visible. Status/open-issue/development claims
show their latest cited date. Nonliteral paraphrases are conservatively labeled
inferred, and a named person must appear in the cited records. Inference is visibly qualified, historical status is dated,
and the prompt says past activities are not proof of today's work. Briefs with
changed source text/eligibility or a future cutoff are omitted. Historical
training-pair export still uses only its original strictly earlier raw history.

Settings → AI assist → Running matter briefs provides the model, nightly hour,
enable switch, initial/update buttons, run progress/errors, version history and
clickable billing sources. The source records and finalized narratives are never
rewritten by the brief worker. New installations default to nightly updates off;
this machine is enabled after the initial pass succeeds.

API routes (protected by the app's existing auth and origin middleware):

- `GET /api/matter-briefs`: settings, counts, recent runs and errors.
- `GET /api/matter-briefs/:id`: current brief and whether it is usable.
- `GET /api/matter-briefs/:id/versions[/:version]`: history and source snapshots.
- `POST /api/matter-briefs/run`: `{mode:"initial"}` or `{mode:"matter",matter_id:123}`.
- `PATCH /api/settings`: `{matterBriefs:{enabled:true,model:"qwen3.6-35b:latest",hour:2}}`.

Local commands share the same database lease and generation path:

```sh
node scripts/update-matter-briefs.mjs --initial --model qwen3.6-35b:latest --enable
node scripts/update-matter-briefs.mjs --matter 123
node scripts/update-matter-briefs.mjs --nightly --from 2026-11-03 --through 2026-11-03
node scripts/e2e-matter-briefs.mjs
```

The builder uses Ollama's [structured-output JSON schema](https://docs.ollama.com/capabilities/structured-outputs),
then independently checks shape, section limits and every source ID. Allowed IDs also constrain model decoding, and a per-matter person-to-entry index helps preserve attribution. A corrective retry receives all detected citation problems and the rejected draft. Local model
pilots and rollout receipts are under ignored `data/matter-briefs-2026-11-04/`.
Database migration v21 stores briefs, immutable versions and durable run records;
the ordinary nightly database backup includes all three tables.
