#!/usr/bin/env bash
# Golden journey (HOK-3369): a challenge pair's challenger arm emulates the
# native OpenRouter contract — ownership row, session stream, direct
# provider-response stage result — for every stage. The pair runs end to end
# (plan → code → review → eval → compare → merge). Every subsequent monitor
# or CLI write that completes a stage must keep the direct provider-response
# evidence; without the HOK-3369 merge rule the agent-type gate would
# downgrade native evidence to inherited/runtime_fallback on completion.
export JOURNEY_NATIVE_ARM_EVIDENCE=1
export JOURNEY_PAIR_STAGE=plan
export JOURNEY_PAIR_NAME=native-arm-evidence
journey_post_assertions() {
  # HOK-3495: the real eval path must retain owned native turns even when
  # upstream generation lookup is unavailable. The fixture supplies usage,
  # not a claim that the model vendor was the upstream host.
  journey_assert "owned native provider evidence survives eval persistence" \
    node --input-type=module - "$STATE_DIR/evals" <<'JS'
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const [root] = process.argv.slice(2);
const records = [];
for (const file of readdirSync(root, { recursive: true })) {
  if (!/\.jsonl?$/.test(file)) continue;
  const text = readFileSync(join(root, file), 'utf8');
  for (const raw of [text, ...text.split('\n')]) {
    try { const value = JSON.parse(raw); if (value.challengeSide === 'challenger') records.push(value); } catch {}
  }
}
const evidence = records.flatMap(record => record.nativeProviderExecutions ?? []);
assert.ok(evidence.length > 0, 'no native provider evidence persisted by eval');
assert.ok(evidence.every(turn => turn.sessionRef && turn.ownershipAttemptIds.length && turn.transport === 'openrouter'));
assert.ok(evidence.some(turn => turn.responseId && turn.generation === null), 'missing upstream evidence must stay unknown');
JS
}
source "$(dirname "$0")/challenge-pair-eval.journey.sh"
