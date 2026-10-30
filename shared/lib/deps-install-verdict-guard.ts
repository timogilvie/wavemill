/**
 * HOK-3315 — Preflight guard for deps-install-verdict invariant.
 *
 * Enforces that private lock-comparison or install-health decisions are
 * confined to the canonical shared/lib/deps-drift.ts checker.
 *
 * Patterns (calibrated post-refactor):
 *   1. hidden-lockfile-read: .package-lock.json access
 *   2. installed-version-probe: physical package.json reading
 *   3. lockfile-packages-version-map: private lock inventories
 *   4. lockfile-hash-verdict: byte equality as a health decision
 */

export const GUARD_SPEC = {
  name: 'deps-install-verdict',
  description: 'Enforces one semantic npm-install checker in shared/lib/deps-drift.ts',
  markerOnViolation: 'allow-deps-install-verdict',
  invariantPaths: [
    'shared/lib/deps-drift.ts',
    'shared/lib/deps-drift.sh',
    'tools/deps-drift.ts',
  ],
  patterns: [
    {
      pattern: '\\.package-lock\\.json',
      name: 'hidden-lockfile-read',
      description: 'npm hidden lockfile is read only by the checker',
    },
    {
      pattern: 'join\\([^)]*\\.package\\.json[^)]*node_modules[^)]*\\)',
      name: 'installed-version-probe',
      description: 'physical package.json version checking',
    },
    {
      pattern: '\\.packages\\[[\\s\'"`]node_modules/',
      name: 'lockfile-packages-version-map',
      description: 'private lock inventory access',
    },
    {
      pattern: '(lock_?[Hh]ash|lockHash)\\s*(==|===|!=|!==)',
      name: 'lockfile-hash-verdict',
      description: 'byte equality used as health decision',
    },
  ],
} as const;
