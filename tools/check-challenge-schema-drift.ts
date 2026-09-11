import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const contractPath = join(repoRoot, 'shared/lib/challenge-execution-contract.ts');
const schemaPath = join(repoRoot, 'shared/lib/eval-schema.json');
const builderPath = join(repoRoot, 'shared/lib/eval-record-builder.ts');

function exportedInterfaceBody(source: string, name: string): string {
  // Anchored on a non-identifier character after the name: a plain indexOf on
  // `export interface ChallengeExecutionIntent` matches
  // `ChallengeExecutionIntentSide` when that is declared first, and then every
  // property assertion silently checks the wrong interface.
  const marker = new RegExp(`export interface ${name}(?![\\w$])`);
  const found = marker.exec(source);
  if (!found) {
    throw new Error(`Missing exported interface ${name}`);
  }
  const start = found.index;
  const open = source.indexOf('{', start);
  if (open === -1) {
    throw new Error(`Malformed exported interface ${name}`);
  }

  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, index);
    }
  }
  throw new Error(`Unclosed exported interface ${name}`);
}

function propertyNamesFromInterface(source: string, name: string): string[] {
  const body = exportedInterfaceBody(source, name)
    .replace(/\/\*\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  const names = new Set<string>();
  const matcher = /^\s*([A-Za-z_$][\w$]*)\??\s*:/gm;
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(body))) {
    names.add(match[1]);
  }
  return [...names].sort();
}

function fail(messages: string[]): never {
  for (const message of messages) {
    console.error(`challenge-schema-drift: ${message}`);
  }
  process.exit(1);
}

const contractSource = readFileSync(contractPath, 'utf-8');
const builderSource = readFileSync(builderPath, 'utf-8');
const schema = JSON.parse(readFileSync(schemaPath, 'utf-8'));
const challengeSchema = schema.$defs?.ChallengeExecutionIntent;
const sideSchema = schema.$defs?.ChallengeSideIntent;
const errors: string[] = [];

if (!challengeSchema || typeof challengeSchema !== 'object') {
  errors.push('eval-schema.json is missing $defs.ChallengeExecutionIntent');
} else {
  const tsProperties = propertyNamesFromInterface(contractSource, 'ChallengeExecutionIntent');
  const schemaProperties = Object.keys(challengeSchema.properties ?? {}).sort();
  const missing = tsProperties.filter((name) => !schemaProperties.includes(name));
  if (missing.length > 0) {
    errors.push(`ChallengeExecutionIntent properties missing from schema: ${missing.join(', ')}`);
  }
  if (challengeSchema.additionalProperties !== false) {
    errors.push('ChallengeExecutionIntent must keep additionalProperties: false');
  }
}

if (!sideSchema || sideSchema.additionalProperties !== false) {
  errors.push('ChallengeSideIntent must exist and keep additionalProperties: false');
}

const projectionProperties = propertyNamesFromInterface(contractSource, 'ChallengeExecutionIntentProjection');
for (const required of ['pairId', 'challengeStage', 'primary', 'challenger']) {
  if (!projectionProperties.includes(required)) {
    errors.push(`ChallengeExecutionIntentProjection is missing ${required}`);
  }
}

if (!builderSource.includes('projectChallengeIntentForPersistence(input.intent)')) {
  errors.push('eval-record-builder.ts must project challenge intent before assigning record.challengeIntent');
}

if (/record\.challengeIntent\s*=\s*input\.intent\b/.test(builderSource)) {
  errors.push('eval-record-builder.ts directly assigns input.intent to record.challengeIntent');
}

// ── One builder, one schema ────────────────────────────────────────────────
//
// Two exported functions named buildChallengeExecutionIntent — one emitting an
// envelope with `selectedStage` and runtime-shaped sides, one emitting a
// projection with `challengeStage` and `expectedRoute` — is the exact split
// that let the rerouting merge read a shape it could not parse and silently
// discard the selected challenge arm. Both objects were persisted under the
// name `challengeIntent`, so which one a consumer received was incidental.

const challengeModePath = join(repoRoot, 'shared/lib/challenge-mode.ts');
const challengeModeSource = readFileSync(challengeModePath, 'utf-8');

const modeSideProperties = propertyNamesFromInterface(challengeModeSource, 'ChallengeExecutionIntentSide');
for (const required of ['side', 'pairId', 'challengeStage', 'expectedStageModel', 'expectedRoute']) {
  if (!modeSideProperties.includes(required)) {
    errors.push(
      `challenge-mode.ts ChallengeExecutionIntentSide is missing projection field ${required}; `
      + 'the persisted intent must be a superset readable by both the rerouting merge and eval attestation',
    );
  }
}
for (const required of ['planner', 'coder', 'reviewer']) {
  if (!modeSideProperties.includes(required)) {
    errors.push(`challenge-mode.ts ChallengeExecutionIntentSide is missing runtime field ${required}`);
  }
}

const modeIntentProperties = propertyNamesFromInterface(challengeModeSource, 'ChallengeExecutionIntent');
for (const required of ['selectedStage', 'challengeStage']) {
  if (!modeIntentProperties.includes(required)) {
    errors.push(
      `challenge-mode.ts ChallengeExecutionIntent must emit ${required}; `
      + 'consumers read one or the other and a missing key falls through to the implementation default',
    );
  }
}

// The projection must have exactly one implementation. Anything else drifts.
if (!challengeModeSource.includes('projectEntryToSideIntent')) {
  errors.push(
    'challenge-mode.ts must build side projections via projectEntryToSideIntent from '
    + 'challenge-execution-contract.ts rather than reimplementing them',
  );
}

// ── The shell merge must be able to read what the builders write ───────────
//
// wavemill-common.sh dereferences these keys off the persisted intent. If a
// builder stops emitting one, the merge degrades to a no-op — which is how
// this failed silently for a week.
const commonShPath = join(repoRoot, 'shared/lib/wavemill-common.sh');
const commonShSource = readFileSync(commonShPath, 'utf-8');
for (const dereferenced of ['expectedRoute', 'selectedStage', 'challengeStage']) {
  if (!commonShSource.includes(dereferenced)) {
    errors.push(
      `wavemill-common.sh no longer reads ${dereferenced}; the rerouting merge and the intent builders have diverged`,
    );
  }
}
// challengeArmPreserved was retired with the reroute arm-preservation path
// (HOK-2813): deferred materialisation means no challenger arm runs before
// the fork, so there is nothing to preserve through an expanded route. The
// merge still stamps challengeIntentApplied for intent application.
if (!commonShSource.includes('challengeIntentApplied')) {
  errors.push(
    'wavemill-common.sh must record challengeIntentApplied so a failed intent application is '
    + 'visible instead of being reported as applied',
  );
}

// ── The TypeScript union and the JSON enum must agree ──────────────────────
const invalidReasonMatch = contractSource.match(
  /export type InvalidChallengeReason =([\s\S]*?);/,
);
if (!invalidReasonMatch) {
  errors.push('Missing exported type InvalidChallengeReason');
} else {
  const unionMembers = [...invalidReasonMatch[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
  const schemaEnum = [...((schema.$defs?.InvalidChallengeReason?.enum as string[] | undefined) ?? [])].sort();
  if (JSON.stringify(unionMembers) !== JSON.stringify(schemaEnum)) {
    errors.push(
      'InvalidChallengeReason has drifted between challenge-execution-contract.ts and eval-schema.json: '
      + `union=[${unionMembers.join(', ')}] schema=[${schemaEnum.join(', ')}]`,
    );
  }
}

if (errors.length > 0) {
  fail(errors);
}

console.log('challenge-schema-drift: ok');
