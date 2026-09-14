# Decision Log Entry - HOK-2806

Date: 2026-09-14 America/New_York

Entry:

**2026-09-14 · HOK-2806 · wavemill → scanner / Check / SDK** — Static collection now emits the S1 field names `type_errors`, `lint_errors`, `build_ok`, and `complexity_delta` with explicit null semantics. Null means evidence was unavailable; zero and false are observed values. The extractor is checkout-plus-ref driven and does not read wavemill workflow state.

Decisions:

- Complexity uses the versioned dependency-free metric `hok-branch-count/1`: candidate-minus-base delta in branch-decision token counts over supported source files read from git objects. The metric is deterministic in a bare checkout and a wavemill worktree, and future metric changes must use a new version string.
- Type and lint counts are collected from configured tools, not script names alone: `tsc`/`mypy` for types; `eslint`/`ruff`, then a bounded package `lint` script fallback for lint. Missing configuration or dependencies yields null, not zero.
- `build_ok` evidence uses the ladder: package `build` script terminal result first, then terminal GitHub CI evidence, then null. Legacy no-CI evidence (`ran:false`) maps to null.
- Backfill is limited to reconstructable fields. `complexity_delta` is backfillable from git objects; `build_ok` is backfillable from GitHub check conclusions. Historical `type_errors` and `lint_errors` are not backfillable because the exact dependency tree and tool execution environment for old revisions cannot be faithfully reconstructed.

Manual follow-up:

- Mirror this entry into the Arbiter Program Brief Decision Log in Linear.
