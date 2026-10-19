#!/usr/bin/env -S npx tsx
/**
 * Preflight guard (HOK-3205): fail when a precompiled schema validator in
 * shared/validators/ is out of sync with its schema, and when a hot schema no
 * longer compiles or the default model registry catalog no longer validates
 * (HOK-2908 incident class: a broken schema must fail loudly).
 *
 * Usage: npx tsx tools/check-schema-validators.ts [repoRoot] [validatorsDir]
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkPrecompiledValidators,
  compileSchemaValidator,
  DEFAULT_REPO_ROOT,
  PRECOMPILED_SCHEMAS,
  readRefSchemas,
} from '../shared/lib/schema-validators.ts';

const __filename = fileURLToPath(import.meta.url);

if (process.argv[1] === __filename) {
  const repoRoot = process.argv[2] ?? DEFAULT_REPO_ROOT;
  const validatorsDir = process.argv[3] ?? join(repoRoot, 'shared', 'validators'); // install-paths: allow repoRoot is install-dir derived
  const problems = checkPrecompiledValidators(repoRoot, validatorsDir);

  for (const spec of PRECOMPILED_SCHEMAS) {
    try {
      compileSchemaValidator(
        JSON.parse(readFileSync(join(repoRoot, spec.schemaPath), 'utf-8')),
        spec.ajvOptions,
        spec.ajvModule,
        readRefSchemas(spec, repoRoot),
      );
    } catch (error) {
      problems.push(`${spec.schemaPath}: schema does not compile (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  if (problems.length > 0) {
    console.error('Precompiled schema validators are out of sync:');
    for (const problem of problems) {
      console.error(`  - ${problem}`);
    }
    console.error('Fix the schema if it is broken, then run: npx tsx tools/generate-schema-validators.ts');
    process.exit(1);
  }
  console.log(`check-schema-validators: ${PRECOMPILED_SCHEMAS.length} precompiled validators in sync`);
}
