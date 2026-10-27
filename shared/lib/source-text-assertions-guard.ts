// allow-source-text-assertion: this file *is* the source-text-assertions guard;
// its pattern table names every forbidden shape. It is auto-excluded from its
// own scan (see invariantPaths); the marker above is defensive.
/**
 * Preflight guard (HOK-3237, enforced by HOK-3236): fail on a test that
 * asserts against the *source text* of production code — reading, grepping,
 * hashing a file under `shared/lib/**` or `tools/**` as the oracle. Such tests
 * pass on real bugs (behaviour broke, text didn't) and fail on harmless
 * refactors (rename, re-split, re-order).
 *
 * Shapes caught — assertions whose oracle is the source bytes, not an
 * observable behaviour:
 *
 * - shell `grep`/`cat`/`awk`/`sed`/`head`/`tail`/`wc`/`md5sum`/`shasum` against
 *   the generated `$MILL_SCRIPT` / `$MONITOR_SCRIPT(_FILE)` variables (that is
 *   how the suite names the production source it should be driving);
 * - shell `grep`/`cat`/`awk`/`sed`/`head`/`tail`/`wc`/`md5sum`/`shasum` against
 *   a literal `shared/lib/...` or `tools/...` source path;
 * - TS `readFileSync(...)` of a `.ts`/`.sh`/`.mjs`/… file whose path contains
 *   `shared/lib/`, `tools/`, or `import.meta.url` (the sibling-source read);
 * - TS `sha256(readFileSync(... .ts))` and friends — hashing source bytes as a
 *   stamp key or oracle.
 *
 * `tests/check-*` lint guards are deliberately exempt (they *are* source
 * readers by design). Legacy offenders are listed in
 * `tools/source-text-assertions-allowlist.txt` with a `# reason`; the ratchet
 * only shrinks. New sites either suppress one line with
 * `// allow-source-text-assertion: <reason>` (or `#` in shell) or — the usual
 * answer — call the function, drive the entry point, and compare the
 * observable result against an independent oracle.
 */
import type { GuardSpec } from '../../tools/lib/source-guard.ts';

export const SOURCE_TEXT_ASSERTIONS_GUARD: GuardSpec = {
  name: 'source-text-assertions',
  findingNoun: 'source-text assertion(s) in tests',
  suppressionMarker: 'allow-source-text-assertion',
  allowlistFile: 'tools/source-text-assertions-allowlist.txt',
  invariantPaths: [
    'shared/lib/source-text-assertions-guard.ts',
    'tools/check-source-text-assertions.ts', // install-paths: allow invariantPaths list, not an argv target
  ],
  testsOnly: true,
  excludedPrefixes: [
    'features/',
    '.wavemill/',
    'node_modules/',
    'worktrees/',
    'spike/',
    '.git/',
    'shared/validators/',
    // tests/check-* are deliberate lint-shaped guards that read source as
    // their job (HOK-3236 framework). Exempting the whole prefix keeps them
    // out of the ratchet entirely.
    'tests/check-',
  ],
  patterns: [
    {
      name: 'shell-mill-monitor-script-read',
      description: 'test greps/cats/hashes the generated mill/monitor script — assert behaviour, not substrings',
      lang: 'sh',
      re: /\b(grep|awk|sed|cat|head|tail|wc|md5sum|sha256sum|shasum)\b[^|&;]*\$\{?(MILL|MONITOR)_SCRIPT(_FILE)?\}?/,
    },
    {
      name: 'shell-source-path-read',
      description: 'test greps/cats/hashes a shared/lib/** or tools/** path directly — assert behaviour, not source text',
      lang: 'sh',
      re: /\b(grep|awk|sed|cat|head|tail|wc|md5sum|sha256sum|shasum)\b[^|&;]*\b(shared\/lib|tools)\/[A-Za-z0-9_\-/.]+\.(ts|tsx|js|sh|mjs|cjs)\b/,
    },
    {
      name: 'ts-readfile-sibling-source',
      description: 'test readFileSync(..., import.meta.url) of a sibling source — assert behaviour, not source bytes',
      lang: 'ts',
      re: /readFileSync\s*\([^)]*import\.meta\.url/,
    },
    {
      name: 'ts-readfile-source-path',
      description: 'test readFileSync(...) of a shared/lib/** or tools/** source file — assert behaviour, not source bytes',
      lang: 'ts',
      re: /readFileSync\s*\([^)]*['"`][^'"`]*\b(shared\/lib|tools)\/[A-Za-z0-9_\-/.]+\.(ts|tsx|js|mjs|cjs|sh)['"`]/,
    },
    {
      name: 'ts-hash-source',
      description: 'test hashes a source file — depends on bytes, not behaviour',
      lang: 'ts',
      re: /(sha256|md5|createHash)\s*\([^)]*readFileSync[^)]*\.(ts|tsx|js|mjs|cjs|sh)\b/,
    },
  ],
  remediation: [
    'Tests must assert against behaviour, not source bytes. Call the function,',
    'drive the entry point, and compare the observable result against an',
    'independent oracle (fixture, inline expected value, deterministic input).',
    'Precede each new test with a one-line `// protects: <failure scenario>`',
    'comment (or encode the scenario in the test name). `tests/check-*` lint',
    'guards are already exempt.',
  ],
};
