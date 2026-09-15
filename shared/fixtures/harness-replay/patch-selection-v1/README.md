# Patch-Selection Replay Corpus

This directory contains the ground-truth patch-selection instances for Phase 2-3 of the Hokusai Arbiter program.

## Overview

The patch-selection corpus pairs tasks with multiple candidate patches (including a known-good and known-bad) to measure whether a selection strategy correctly identifies the best patch. This is the evaluation ground truth for:

- **Phase 2**: Training the patch-selection scoring model
- **Phase 3**: Held-out evaluation ("beats the blinded judge on the held-out replay corpus")

## Schema

Each instance contains:
- **id**: Stable unique identifier
- **taskTitle**: Human-readable task name
- **taskDescription**: Sanitized task description
- **baseSha**: Optional git commit where the task was encountered
- **candidates**: Array of candidate patches with content and metadata
- **knownGoodCandidateId**: The id of the correct/merged patch
- **knownBadCandidateIds**: IDs of known incorrect patches
- **source**: Provenance (challenge pair, incident, PR, etc.)
- **heldOut**: Whether this instance is in the held-out evaluation set
- **curatedAt**: Timestamp when the instance was curated

For details on all fields, see `schema.ts`.

## Curation Criteria

Instances are added only when there is concrete known-good/known-bad evidence:

- **merged_winner**: The good candidate was merged in a PR; the bad candidate was rejected
- **incident_fix**: The bad candidate was the original implementation; the good candidate is the fix
- **eval_implied**: Challenge/swap-test has both diffs and clear winner determination
- **survival_confirmed**: A regression or recovery incident validates the known-good patch

Ambiguous or inconclusive pairs are not added.

## Privacy Boundary

All committed fixtures must be:
- Sanitized or public-diff based (never raw private task text or prompts)
- Explicitly marked as sanitized in the source metadata
- Free of customer/sensitive data

## Held-Out Split

The `split.heldOutIds` array defines instances excluded from training. By default, corpus loading excludes held-out instances:

```bash
npx tsx tools/run-wavemill-router-eval.ts --corpus manifest.json --split train
```

To include held-out instances:

```bash
npx tsx tools/run-wavemill-router-eval.ts --corpus manifest.json --split all
```

## Adding a New Instance

Use the incident capture tool:

```bash
npx tsx tools/challenge-replay-capture.ts <incident-id>
```

This creates a fixture draft. Once patches are confirmed, mark it `scoreable: true` and merge.

Alternatively, create a manual entry and add it to the manifest:

1. Create instance JSON in `instances/` or inline in the manifest
2. Ensure all required fields are present
3. Run validation: `node --test src/evaluation/adapters/wavemill-router-adapter.test.ts`
4. Update `updatedAt` timestamp

## Refresh Policy

- Refresh the manifest after adding ≥10 new instances
- Archive old instances to a separate file if the manifest exceeds 100KB
- Check `split.heldOutIds` matches current instance ids

## Stats

- **Total instances**: See `split.heldOutIds` length for held-out count
- **Training instances**: Total - heldOut
- **Minimum target**: 100 scoreable instances before Phase 3 training

---

See the Arbiter Program Brief and Plan of Record for broader context:
https://linear.app/hokusai/document/hokusai-arbiter-plan-of-record-90de5fa36b75
