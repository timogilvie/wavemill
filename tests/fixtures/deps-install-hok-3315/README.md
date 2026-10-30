# HOK-3315 Dependency Install Verdict Test Fixtures

Captured from the real main checkout on darwin-arm64 (node 22.22.2, npm 10.9.7) on 2026-10-30.

## Files

- `package.json` — Minimal root manifest (name, version, workspaces, dependencies only)
- `package-lock.json` — Real lock file with 240 packages entries (includes root "" entry)
- `hidden-package-lock.json` — Real node_modules/.package-lock.json (214 entries, no root)
- `installed-healthy.json` — Snapshot of physical install metadata (all packages at correct versions)
- `installed-incident.json` — Derived from healthy by setting two packages to wrong versions:
  - `node_modules/brace-expansion`: 1.1.21 (locked: 1.1.18)
  - `node_modules/fast-uri`: 3.1.8 (locked: 3.1.2)
- `capture.sh` — Read-only commands to regenerate fixtures from a real checkout

## Key Properties

- Both lockfiles have lockfileVersion 3
- Lock file contains "" (root) entry; hidden lock does not
- 25 absent `@esbuild/*` entries are all:
  - optional: true
  - os/cpu for non-darwin platforms
- Workspace link: `codex-tools` → `../codex`
- Two real version mismatches (brace-expansion, fast-uri) as reported in HOK-3315 incident

## Provenance

Incident fingerprint: `734f6f0e08feb7452b52ed08316a4c350740304a23751c03cb39f8ab3185218`
First observed: 2026-10-20T15:14:06.689Z
Evidence captured: 2026-10-30 (after live install was replaced)

## Derivation

The `installed-incident.json` is **not** a live capture; it's derived from the healthy install by mutating two package versions to match the reported incident state, with full documentation of the changes.
