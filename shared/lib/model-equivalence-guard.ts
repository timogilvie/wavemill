// allow-model-equivalence: this file *is* the model-equivalence guard; its
// pattern table names every forbidden shape. It is auto-excluded from its own
// scan (see invariantPaths); the marker above is defensive.
/**
 * Preflight guard for the one model-identity decision (HOK-3321): challenge
 * code must never decide "are these two spellings of the same model?" with
 * raw string equality. Every such decision goes through
 * `challengeModelIdsEquivalent` (shared/lib/challenge-comparison.ts), which is
 * backed by the effective registry and canonicalises OpenRouter aliases
 * (`qwen/qwen3-coder` ⇄ `qwen-3-coder`) and provider-native ids
 * (`claude-haiku-4-5-20251001` ⇄ `claude-haiku-4-5`).
 *
 * The HOK-3313 incident: `attestEvalRecordChallengeExecution` invalidated a
 * valid Qwen planning experiment as `stage_override_lost` because the expected
 * spelling and the provider-reported spelling differed for the same registry
 * entry. Raw `===`/`!==` on a model-named identifier reintroduces exactly that
 * false positive, so the guard rejects it in the scoped challenge files.
 *
 * Scoped to the challenge decision files (defence-in-depth, plan §3.5);
 * elsewhere model ids may legitimately be compared as opaque strings
 * (dedupe, reporting, router tables).
 *
 * `typeof x === 'string'` checks on model-named fields are type probes, not
 * identity decisions, and do not fire.
 */
import type { GuardSpec, StructuralMatch } from '../../tools/lib/source-guard.ts';

/** Model-named identifiers whose comparison is a model-identity decision. */
const MODEL_NAMED_ID = String.raw`\b(?:expected|actual|requested|resolved|route|stage|primary|challenger|intended|wire|target|canonical|effective|executed)[A-Za-z]*Model[A-Za-z]*`;

/** `typeof x === 'string'` and friends: type probes, not identity decisions. */
const TYPEOF_LITERAL = String.raw`(?:'(?:string|number|boolean|bigint|symbol|function|object|undefined)'|"(?:string|number|boolean|bigint|symbol|function|object|undefined)")`;

const LEFT_OF_EQUALITY = new RegExp(`${MODEL_NAMED_ID}\\s*(?:===|!==)(?!\\s*${TYPEOF_LITERAL})`);
const RIGHT_OF_EQUALITY = new RegExp(`(?:===|!==)\\s*[\\w.$]*${MODEL_NAMED_ID}`);

function isCommentLine(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*');
}

function findRawModelEquality(
  sourceText: string,
  re: RegExp,
  detail: string,
): StructuralMatch[] {
  const matches: StructuralMatch[] = [];
  sourceText.split(/\r?\n/).forEach((line, index) => {
    if (isCommentLine(line)) return;
    if (re.test(line)) {
      matches.push({ line: index + 1, detail });
    }
  });
  return matches;
}

const GUARDED_FILES = [
  'shared/lib/challenge-execution-contract.ts',
  'shared/lib/challenge-pair-recovery.ts',
  'shared/lib/challenge-attestation-backfill.ts',
  'shared/lib/challenge-coverage-selector.ts',
  // HOK-3369: executionTruthFields' runtime_fallback decision reads two
  // model-named identifiers, so the one model-identity rule applies here too.
  'shared/lib/stage-result.ts',
  'shared/lib/executed-model-resolver.ts',
  'tools/backfill-stage-executed-model.ts',
];

export const MODEL_EQUIVALENCE_GUARD: GuardSpec = {
  name: 'model-equivalence',
  findingNoun: 'raw model string comparison(s)',
  suppressionMarker: 'allow-model-equivalence',
  allowlistFile: 'tools/model-equivalence-allowlist.txt',
  // Line-level shapes live in the structural checks below so the guard stays
  // scoped to the challenge decision files; patterns stay empty.
  patterns: [],
  invariantPaths: [
    'shared/lib/challenge-comparison.ts',
    'shared/lib/model-equivalence-guard.ts',
    'tools/check-model-equivalence.ts', // install-paths: allow invariantPaths list, not an argv target
  ],
  structuralChecks: [
    {
      name: 'raw-model-equality-operand-left',
      description: 'model-named identifier compared with === / !== — route the decision through challengeModelIdsEquivalent',
      paths: GUARDED_FILES,
      find: (sourceText) => findRawModelEquality(sourceText, LEFT_OF_EQUALITY, 'model operand on the left of ==='),
    },
    {
      name: 'raw-model-equality-operand-right',
      description: 'model-named identifier compared with === / !== — route the decision through challengeModelIdsEquivalent',
      paths: GUARDED_FILES,
      find: (sourceText) => findRawModelEquality(sourceText, RIGHT_OF_EQUALITY, 'model operand on the right of ==='),
    },
  ],
  remediation: [
    'There is exactly one model-identity decision (HOK-3321): challengeModelIdsEquivalent',
    'in shared/lib/challenge-comparison.ts, backed by the effective registry.',
    'Raw === / !== on a model-named identifier false-invalidates equivalent spellings',
    '(HOK-3313: qwen-3-coder vs qwen/qwen3-coder stamped stage_override_lost).',
  ],
};
