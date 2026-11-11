/**
 * Preflight guard for the one install-health verdict (HOK-3315): there is
 * exactly one semantic dependency-install decision, shared/lib/deps-drift.ts
 * (wrapped by deps-drift.sh / deps-drift-cli.ts for shell and CLI callers).
 *
 * Byte/hash equality of package-lock.json and hand-rolled `.packages` diffs
 * are exactly the defect this consolidation deleted: real installs differ
 * from the committed lockfile in representation-only ways (formatting, the
 * empty root-package entry, platform-omitted optional binaries), so a raw
 * byte or jq-slurp compare reports false "degraded" health. The one
 * legitimate byte-identity use — `depsLockfileFingerprint` as a
 * bounded-retry cache key — lives inside the invariant source itself and is
 * never a drift verdict.
 */
import type { GuardSpec } from '../../tools/lib/source-guard.ts';

/** Files allowed to import the primitive directly; everyone else goes through deps-drift.sh / deps-drift-cli.ts. */
const ALLOWED_DEPS_DRIFT_IMPORTERS = [
  'shared/lib/wavemill-incident-detector.ts',
  'shared/lib/deps-drift-cli.ts',
];

export const INSTALL_VERDICT_GUARD: GuardSpec = {
  name: 'install-verdict',
  invariantDocs: ['docs/invariants/install-health-verdict.md'],
  findingNoun: 'private install-health/lock-comparison decision(s)',
  suppressionMarker: 'allow-install-verdict',
  allowlistFile: 'tools/install-verdict-allowlist.txt',
  invariantPaths: [
    'shared/lib/deps-drift.ts',
    'shared/lib/deps-drift.sh',
    'shared/lib/deps-drift-cli.ts',
    'shared/lib/install-verdict-guard.ts',
    'tools/check-install-verdict.ts', // install-paths: allow invariantPaths list, not an argv target
  ],
  patterns: [
    {
      name: 'private-lockfile-hash',
      description: 'byte/hash comparison of a lockfile outside the one semantic verdict (shared/lib/deps-drift.ts) — representation diffs are not drift',
      lang: 'both',
      re: /(?=.*\b(?:sha256sum|md5sum|shasum|createHash)\b)(?=.*(?:package-lock\.json|\.package-lock\.json))/,
    },
    {
      name: 'private-lockfile-diff',
      description: 'hand-rolled jq lockfile .packages diff outside the one semantic verdict (shared/lib/deps-drift.ts)',
      lang: 'sh',
      re: /\bjq\s+-[A-Za-z]*s[A-Za-z]*\b.*\.packages\b/,
    },
    {
      name: 'private-lockfile-diff',
      description: 'hand-rolled lockfile JSON.parse diff outside the one semantic verdict (shared/lib/deps-drift.ts)',
      lang: 'ts',
      re: /JSON\.parse\([^)]*package-lock/,
    },
    {
      name: 'deps-drift-direct-import',
      description: 'deps-drift.ts imported directly outside the allowed consumer list — go through deps-drift.sh (shell) or the CLI instead',
      lang: 'ts',
      re: /from\s+['"](?:\.\.?\/)*(?:[\w.-]+\/)*deps-drift\.ts['"]/,
      excludePaths: ALLOWED_DEPS_DRIFT_IMPORTERS,
    },
  ],
  remediation: [
    'There is exactly one install-health verdict (HOK-3315): shared/lib/deps-drift.ts,',
    'wrapped by shared/lib/deps-drift.sh and shared/lib/deps-drift-cli.ts for shell/CLI callers.',
    'Byte/hash lockfile comparisons and hand-rolled .packages diffs reintroduce the false',
    '"degraded" verdicts this consolidation deleted.',
  ],
};
