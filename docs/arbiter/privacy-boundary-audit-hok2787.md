# HOK-2787 — Privacy boundary conformance audit (Arbiter S5)

**Audited:** 2026-09-16. **Canonical enumeration:** §5.1 of the Linear document
*Arbiter Program Brief and Decision Log* (every egress path, its allowlist,
enforcement point, test reference and conformance status lives there — this
file is the local pointer, not the source of truth).

## The boundary

Derived features and aggregates leave a repo. Source, prompts, task text and
diffs do not (public repos excepted, where diffs are already public).
September 2026 additions: vendor telemetry identity fields (`user.email`,
`organization.id`, `user.account_uuid`, raw session/account identifiers,
transcript paths, prompts, provider payloads) and reviewer evidence (raw
review prompts, structured findings, reproduction evidence, remediation
patches) are protected local-only material, dropped before persistence in any
shareable projection or queue.

## One fixture, four repos

The shared default-deny fixture is `FORBIDDEN_CONTRIBUTION_KEYS`, exported
from `@hokusai/core` (`packages/core/src/contribution/schema.ts`) and
mirrored as `FORBIDDEN_KEYS` in hokusai-data-pipeline
(`src/api/services/contribution_fidelity.py`) and
`packages/web/src/lib/contribution/forbidden-keys.ts` in hokusai-site.
Wavemill pins the same fields as redaction sentinels via
`PROTECTED_EGRESS_FIELD_FIXTURE` in `shared/lib/hokusai-redaction.ts`.
New egress paths adopt this fixture; they do not invent a second mechanism.

## What changed per repo

- **wavemill** (this branch): protected-field fixture + sentinel tests across
  redaction, submission trigger, and queue drain; drain-body test proving the
  local provenance envelope (`evalId`, identity fingerprints, promotion
  metadata) never transits; `CURRENT_CONSENT_VERSION` bumped to 1.1 with the
  vendor-telemetry and reviewer-evidence exclusions named in `CONSENT_TEXT`
  (1.0 consent is invalidated, users re-confirm).
- **hokusai-sdk** (local branch `task/arbiter-s5-privacy-boundary-conformance`,
  commit b473e86): `FORBIDDEN_CONTRIBUTION_KEYS` extended with the September
  fields and exported; parametrized schema deny tests; builder tests proving a
  raw telemetry spread never reaches a built row. Wavemill consumes this via
  the next `@hokusai/core` release.
- **hokusai-data-pipeline** (local branch
  `task/arbiter-s5-privacy-boundary-conformance`): forbidden scan now runs on
  **every** accepted tier — canonical v1/v2 and legacy passthrough rows were
  previously unscanned — and on client-supplied batch metadata
  (`extra="allow"`), before persistence.
- **hokusai-site** (local branch
  `task/arbiter-s5-privacy-boundary-conformance`, commit 2b74c02): the
  contribution proxy rejects rows carrying protected fields with a 400 naming
  every violating path, before any upstream fetch.

The three sibling-repo branches are local; raise PRs from them separately
(base `auto/integration` in each repo).

## Named gaps (not quiet exceptions)

- SDK legacy `reportOutcome` telemetry bridge pre-dates the fixture and has
  not adopted it; adopt or retire.
- Not yet implemented, must add a §5.1 row and adopt the fixture at landing:
  scanner `--contribute`, Rework Risk Check `contribute:` input, hosted
  report `hokus.ai/r/…` + social card, Model A arbitration rows (HOK-2817).
- The bare key `source` remains allowed as a closed-enum provenance
  discriminator; source *content* keys (`source_code`, `source_diff`,
  `file_contents`, `diff`, `patch`) are denied.
