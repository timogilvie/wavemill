# Arbiter P2.6 — PR Attribution (`pr_attribution/v1`)

HOK-2808. The scan pipeline's attribution step: for every merged PR it emits
three independent attribution dimensions, and for every repo it emits coverage
by signal and by dimension plus the survival report gates. Built on the post-R4
contract (HOK-2791 / HOK-2944): R4 established that binary "some signal fired"
coverage is achievable (11/15 curated repos ≥60%), but exact model identity is
almost never observable from heuristics alone — so agent status, harness
identity and exact model identity are scored separately, never conflated.

- Engine (pure, no I/O): `shared/lib/pr-attribution.ts`
- GitHub enumeration (shared with the R4 tool): `shared/lib/merged-pr-fetcher.ts`
- CLI scan step: `tools/attribute-prs.ts`
- R4 measurement tool (frozen behaviour, shares the signature vocabulary):
  `tools/measure-repo-attribution.ts`

The step runs with no wavemill state — `gh` plus its inputs only — like the
rest of the scan pipeline, and is extracted to `@hokusai/scan` at S4.

```
npx tsx tools/attribute-prs.ts --repo owner/name --limit 50
npx tsx tools/attribute-prs.ts --repos-file repos.txt --config attribution.json --output report.json
npx tsx tools/attribute-prs.ts --repo owner/name --json --audit-sample 25 --audit-seed 7
```

Exit code 0 even at 0% coverage: low coverage is a reported result, not an
error.

## Per-PR record: three independent dimensions

```jsonc
{
  "number": 123,
  "mergedAt": "2026-09-01T00:00:00Z",
  "signals": ["botAuthor", "branchPrefix"],       // distinct signals that fired
  "agent":   { "status": "agent",      "confidence": "strong", "evidence": [ /* ... */ ] },
  "harness": { "status": "identified", "value": "github-copilot", "confidence": "strong", "evidence": [ /* ... */ ] },
  "model":   { "status": "unknown",    "evidence": [] },
  "diagnostics": []                                // stale heads, conflicts, malformed routes
}
```

- **agent** — was the PR observably produced by an agent? `agent | unknown`.
  There is deliberately no `human` value anywhere in the type system: missing
  signals never imply human authorship.
- **harness** — which agent product (Copilot, Claude Code, Codex, wavemill, …).
  `identified | unknown` with a harness id from the registry.
- **model** — the exact model, in `model-registry.ts` canonical vocabulary
  (e.g. `claude-fable-5`). Product names alone ("Copilot", "Claude Code")
  identify a harness, never a model.

Every dimension carries the full list of pointing evidence — including
outranked and conflicting pieces — so attributions are owner-auditable and
disputable.

**Score all PRs; label the attributed ones.** Unattributed PRs stay in the
per-repo `pullRequests` records with all-unknown dimensions; they still carry
survival labels downstream and still train the correctness head.

## Signals, tiers and precedence

| Signal | What it matches | Tier | Points at |
| --- | --- | --- | --- |
| `executedRoute` | HOK-2945 `executed_route` payload in `wavemill-meta` | verified | harness + exact model |
| `wavemillMeta` | parseable `<!-- wavemill-meta -->` block in the PR body | strong | harness (`wavemill`) |
| `botAuthor` | PR author login in a harness's bot logins | strong | harness |
| `coAuthoredBy` | `Co-Authored-By` trailer fragments | strong | harness; explicit model-version strings also give a strong model id |
| `commitSignature` | "Generated with …" style commit fragments | strong | harness; explicit model-version strings give a weak model id |
| `branchPrefix` | head-ref prefixes (`copilot/`, `codex/`, generic `ai-agent/`) | weak | harness (or agent-only for generic prefixes) |
| `label` | PR labels (`copilot`, generic `ai-generated`) | weak | harness (or agent-only for generic labels) |

Resolution per dimension: the unique value at the highest confidence tier wins
(`verified` > `strong` > `weak`). Two *different* values tied at the top tier
degrade to `unknown` with a `conflicting-*-evidence` diagnostic — conflicting
evidence never becomes an identification. The agent dimension is `agent`
whenever any signal fired, at the highest fired tier.

The exact-model dimension is `verified` only from an executed route; `strong`
only from an explicit model-version string in a trailer; `weak` from an
explicit model-version string elsewhere in a commit message; otherwise
`unknown`.

## First-party wavemill metadata (HOK-2945) — highest-confidence source

Wavemill publishes its executed planner/coder/reviewer route in the hidden
`wavemill-meta` PR-body block (HOK-2945 contract):

```
<!-- wavemill-meta
schema-version: 1
route_schema: 1
executed_route: {"head_sha":"abc123","planner":{"status":"executed","model":"claude-opus-5"},"coder":{"status":"executed","model":"claude-fable-5"},"reviewer":{"status":"executed","model":"gpt-5.5"}}
-->
```

This is the scanner's highest-confidence first-party source: when present and
valid it outranks every heuristic (`verified` tier) and supplies both harness
(`wavemill`) and exact model (the **coder** role's resolved canonical model).

Extraction is deliberately lenient (`extractExecutedRoute`): only the
`route_schema` and `executed_route` lines are read, so unknown sibling fields
never break extraction and HOK-2945 can add fields freely. Evidence is
discarded (degrading to `unknown`, with a machine-readable diagnostic on the PR
record) whenever it cannot be proven to describe the merged head's execution:

- `stale-route-head` — the payload's `head_sha` differs from the PR's merged
  head SHA. A stale route described an older head; it never becomes execution.
- `executed-route-no-executed-roles` — no role has `status: "executed"`
  (`inherited`, `not_run` and `unknown` roles are never credited).
- `malformed-executed-route` / `unsupported-route-schema` /
  `executed-route-missing-schema` — unparseable or unversioned payloads.

### Route decision (HOK-3098, `route_schema: 2`)

Since HOK-3098 wavemill writes `route_schema: 2` and adds a `route_decision`
sibling recording what the router **decided** (as opposed to what ran):

```
route_schema: 2
executed_route: {...unchanged...}
route_decision: {"decided_at":"2026-09-28T12:00:00.000Z","decision_id":"<traceId or uuid>","policy_version":"model30-2026.09","recommended":{"coder":"claude-haiku-5","planner":"claude-opus-5","reviewer":"gpt-5.5"},"source":"hokusai"}
```

`route_schema` 1 and 2 share the `executed_route` shape, so both are credited
identically. `extractExecutedRoute` also returns the decision (camelCased as
`ExtractedRouteDecision`), and `attributePullRequest` surfaces it as
`PrAttribution.routeDecision` — the join key between a PR's survival label and
its route decision. It is never an identity signal: `recommended` is what the
router chose, not what ran. Diagnostics:

- `route-decision-schema-mismatch` — `route_decision` on a `route_schema: 1`
  block (or without `route_schema`); ignored.
- `malformed-route-decision` — not JSON, not an object, or missing
  `decision_id` / `source`; ignored. The executed route is still credited.

Recommendations, intended routes and conflicting evidence never become
execution. A discarded route still leaves the `wavemillMeta` signal (strong,
harness only) when the block itself parses.

## Per-repo summary and coverage

`summarizeRepoAttribution` emits, per repo: per-signal counts and coverage,
union/unattributed counts, per-dimension identified counts, coverage percent
(0.1 precision), confidence histograms and value histograms, plus
`eligiblePrCount` and `eligibleForFeasibilityGate` (≥ `minEligiblePrs`,
default 20). `aggregateAttribution` pools repos into **macro** (unweighted mean
of per-repo coverage) and **micro** (pooled per-PR) coverage per signal and per
dimension; the feasibility-gate verdict pools over eligible repos only.

Coverage is always surfaced in the report — including, and especially, when a
section is suppressed.

## Report gates (suppression rule)

`evaluateReportGates` is the pure, boundary-tested suppression rule:

- **survival-by-model** renders iff exact-model coverage ≥
  `coverageFloorPercent` (default 60) AND `eligiblePrCount ≥ minEligiblePrs`.
- **survival-by-harness** renders iff harness coverage clears the same test.

Comparisons use the same 0.1-precision percentage arithmetic as the coverage
figures, so 60.0 renders and 59.9 suppresses. A suppressed gate carries
`render: false`, the coverage figure, and an explicit human-readable `reason` —
the report must say why a section is missing, never hide the number. Harness
coverage at the floor supports a table titled **survival-by-harness**, never
"survival-by-model". Per-cell n≥20 enforcement is the report renderer's job
(P3.W3), not this step's.

Precision auditing: `sampleForPrecisionAudit` (CLI `--audit-sample N
--audit-seed S`) draws a deterministic seeded sample of *attributed* PRs per
repo for the manually-audited-precision requirement.

## Configuration

A standalone JSON file passed via `--config` (not `.wavemill-config.json` — the
scan runs with no wavemill state). All keys optional; unknown keys are typed
errors. Defaults: `coverageFloorPercent: 60`, `minEligiblePrs: 20`.

```jsonc
{
  "coverageFloorPercent": 60,
  "minEligiblePrs": 20,
  "extraBotLogins": ["inhouse-agent[bot]"],        // agent-only evidence, no harness
  "extraBranchPrefixes": ["bots/"],
  "extraCoAuthorFragments": [],
  "extraLabelNames": [],
  "extraCommitSignatureFragments": [],
  "extraHarnesses": [                               // fully identified products
    { "id": "acme-bot", "displayName": "Acme Bot", "botLogins": ["acme-coder[bot]"], "coAuthorFragments": ["acme coder"] }
  ],
  "extraModelSignatures": [                         // explicit model-version strings only
    { "fragment": "acme-large-9", "modelId": "acme-large-9" }
  ],
  "disabledSignals": ["label"],
  "repos": {                                        // per-repo overrides
    "owner/name": { "extraBotLogins": ["repo-specific[bot]"], "coverageFloorPercent": 40 }
  }
}
```

Resolution: defaults ← file-level keys ← `repos["owner/name"]`. Scalars
replace; `extra*` lists and `disabledSignals` are additive. Every per-repo
section is validated eagerly, even when scanning a different repo. Attribution
is a heuristic and owner-correctable by design: signature gaps are closed with
config, and the report's dispute affordance (P3.W6) covers misattributions.

## Relationship to the R4 tool

`tools/measure-repo-attribution.ts` is the frozen R4 measurement instrument;
its checked-in evidence (`docs/arbiter/attribution-coverage-report.md`,
`attribution-coverage-results.json`) is not regenerated. It re-derives its flat
`DETECTOR_SIGNATURES` lists from the shared `HARNESS_REGISTRY` via
`legacyDetectorSignatures()` — a golden parity test asserts the projection
reproduces the pre-refactor literals exactly (order included) — so there is one
signature vocabulary and the two tools cannot drift.

## Schema note (S1)

Attribution emits its own versioned record (`schemaVersion: 1` on the report,
`pr_attribution/v1` in program terms) consumed by the S3 report data contract
(HOK-2804) and Report v1.5 (P3.W3). It adds no fields to the candidate feature
schema (HOK-2786); if P2.D1 later wants provenance features, that is a separate
schema amendment.
