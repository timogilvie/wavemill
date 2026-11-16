#!/usr/bin/env bash
# Endpoint qualifications coexist and refuse missing/wrong evidence while a native challenge settles normally.
export JOURNEY_NATIVE_ARM_EVIDENCE=1
export JOURNEY_PAIR_STAGE=plan
export JOURNEY_PAIR_NAME=endpoint-qualification
journey_post_assertions() {
  journey_assert "endpoint qualifications remain isolated and production refuses an unqualified host" \
    node --input-type=module - "$JOURNEY_INSTALL_DIR" "$JOURNEY_TMP/endpoint-store" <<'JS'
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const [install, root] = process.argv.slice(2);
const { replayEndpointQualification } = await import(pathToFileURL(join(install, 'tests/fixtures/endpoint-qualification/replay.ts')));
replayEndpointQualification(root);
JS
}
source "$(dirname "$0")/challenge-pair-eval.journey.sh"
