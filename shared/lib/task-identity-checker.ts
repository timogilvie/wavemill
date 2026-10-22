// allow-task-identity: this file *is* the task-identity guard; it necessarily
// contains every forbidden pattern as a literal. It is auto-excluded from its
// own scan (see invariantPaths); the marker above is defensive.
/**
 * Preflight guard (HOK-3118): every task-ID → Linear-ID derivation, challenger
 * check, and challenger-ID construction goes through
 * shared/lib/task-identity.{ts,sh}. Built on tools/lib/source-guard.ts.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkGuardSource,
  formatGuardResult,
  runSourceGuard,
  type GuardFinding,
  type GuardPattern,
  type GuardResult,
  type GuardSpec,
} from '../../tools/lib/source-guard.ts';

const __filename = fileURLToPath(import.meta.url);
const defaultRepoRoot = join(dirname(__filename), '..', '..');

// Deliberately narrow, operator-shaped patterns. The goal is to catch new
// ad-hoc `_c` derivations and inline issue-ID regexes — never to lint variable
// names that end in `_c` (`comp_c`) or prose issue IDs in strings/comments.
const PATTERNS: GuardPattern[] = [
  // --- TS/JS ---------------------------------------------------------------
  {
    name: 'ts-endswith-c',
    description: "`.endsWith('_c')` — challenger check; use isChallengerTaskId()",
    lang: 'ts',
    re: /\.endsWith\(\s*['"`]_c['"`]\s*\)/,
  },
  {
    name: 'c-anchor-regex',
    description: '`/_c$/` regex literal — stripping the challenger suffix inline',
    lang: 'both',
    re: /\/_c\$\//,
  },
  {
    name: 'ts-template-c',
    // allow-template-curly: literal description of the forbidden shape, not interpolation.
    description: '`${expr}_c` template literal — hand-built challenger ID; use challengerTaskId()',
    lang: 'ts',
    re: /\$\{[^}]+\}_c`/,
  },
  // --- Shell ---------------------------------------------------------------
  {
    name: 'sh-param-expand-c',
    // allow-template-curly: literal description of the forbidden shape, not interpolation.
    description: '`${var%_c}` parameter expansion — stripping the challenger suffix inline',
    lang: 'sh',
    re: /\$\{[A-Za-z_][A-Za-z0-9_]*%_c\}/,
  },
  {
    name: 'sh-glob-c',
    description: '`*_c ]]` glob test — ad-hoc challenger match; use is_challenger_task_id()',
    lang: 'sh',
    re: /\*_c\s*\]\]/,
  },
  {
    name: 'sh-build-c',
    // allow-template-curly: literal description of the forbidden shape, not interpolation.
    description: '`${var}_c` — hand-built challenger ID; use challenger_task_id()',
    lang: 'sh',
    re: /\$\{[^}]+\}_c(?=["'}\/\s]|$)/,
  },
  {
    name: 'sh-awk-sub-c',
    description: '`sub("_c$"…)` — awk stripping the challenger suffix inline',
    lang: 'sh',
    re: /sub\(\s*(?:"_c\$|\/_c\\?\$)/,
  },
  {
    name: 'sh-jq-endswith-c',
    description: '`endswith("_c")` — jq challenger check inline',
    lang: 'sh',
    re: /endswith\(\s*"_c"\s*\)/,
  },
  // --- Both: inline issue-ID regex literals --------------------------------
  // `[A-Z]+-\d+`, `[A-Z][A-Z0-9]*-\d+`, `[A-Z]{2,}-\d+`, and the `\\d`
  // (string-source) twin. Requires the characteristic `[A-Z` class start so a
  // comment or prose issue ID never fires.
  {
    name: 'issue-id-regex',
    description: 'inline issue-ID regex (`[A-Z…]-\\d+`) — use ISSUE_ID_RE / the task-identity exports',
    lang: 'both',
    re: /\[A-Z[^\n]{0,24}?-\\{1,2}d/,
  },
];

export type TaskIdentityFinding = GuardFinding;
export type TaskIdentityResult = GuardResult;

export const TASK_IDENTITY_GUARD: GuardSpec = {
  name: 'task-identity',
  findingNoun: 'ad-hoc task-identity derivation(s)',
  suppressionMarker: 'allow-task-identity',
  allowlistFile: 'tools/task-identity-allowlist.txt',
  // The invariant itself and this guard necessarily contain every forbidden pattern.
  invariantPaths: [
    'shared/lib/task-identity.ts',
    'shared/lib/task-identity.sh',
    'shared/lib/task-identity-checker.ts',
  ],
  patterns: PATTERNS,
  remediation: [
    'Every task-ID → Linear-ID derivation, challenger check, and challenger-ID',
    'construction must go through shared/lib/task-identity.{ts,sh} — never parse',
    'or build `_c` inline, and never author an inline issue-ID regex.',
  ],
  tsExtensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
  // Pre-framework scope: shell helpers under tests/lib are scanned; only pinned fixtures are not.
  excludedPrefixes: ['tests/fixtures/', 'features/', '.wavemill/', 'node_modules/', '.git/'],
  // Pre-framework allowlist semantics: reasons may sit on the line above and are not enforced.
  requireAllowlistReason: false,
  ratchet: false,
};

/**
 * Scan a single file's source text for ad-hoc task-identity derivations.
 *
 * Line-oriented: each applicable pattern is tested against every line, and a
 * finding is suppressed when `allow-task-identity:` appears on the same line or
 * the line immediately above.
 */
export function checkSourceText(fileName: string, sourceText: string): TaskIdentityFinding[] {
  return checkGuardSource(TASK_IDENTITY_GUARD, fileName, sourceText);
}

export function checkTaskIdentity(repoDir = defaultRepoRoot): TaskIdentityResult {
  return runSourceGuard(TASK_IDENTITY_GUARD, repoDir);
}

export function formatTaskIdentity(result: TaskIdentityResult): string {
  return formatGuardResult(TASK_IDENTITY_GUARD, result);
}
