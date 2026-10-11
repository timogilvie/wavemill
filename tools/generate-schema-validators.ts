#!/usr/bin/env -S npx tsx
/**
 * Regenerate the Ajv standalone validators in shared/validators/ (HOK-3205).
 * Run after editing any schema listed in PRECOMPILED_SCHEMAS; preflight
 * (tools/check-schema-validators.ts) fails until the artifacts are refreshed.
 */
import { relative } from 'node:path';
import { DEFAULT_REPO_ROOT, writePrecompiledValidators } from '../shared/lib/schema-validators.ts';

for (const path of writePrecompiledValidators()) {
  console.log(`wrote ${relative(DEFAULT_REPO_ROOT, path)}`);
}
