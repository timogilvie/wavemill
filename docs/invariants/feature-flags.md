---
title: Feature flags
---

# Feature flags

`feature-flag-checker.ts` `checkFeatureFlags()` / `tools/check-feature-flags.ts` - The feature-flag inventory invariant (HOK-3235): every `WAVEMILL_*` env token in non-test code must appear in `docs/feature-flags.md` (open-shadow, kill-switch or permanent table) or in the plumbing baseline `tools/feature-flags-baseline.txt`. Shadow and expiring rows carry owner-issue, removal-issue, added date and remove-by (at most 30 days past max(added, 2026-10-20); one explicit extension of at most 30 more days is allowed in the remove-by cell as `YYYY-MM-DD (extended from YYYY-MM-DD, HOK-123: reason)`, and `added` is never rewritten). Open-shadow rows are capped at `MAX_OPEN_SHADOWS = 5`; a new shadow requires retiring one. The baseline rejects any name matching the kill-switch pattern `(^|_)(DISABLED?|SKIP|SYNC|LIVE|SHADOW|LEGACY|AUTOFIX|ENABLED|FORCE|NO)(_|$)` and only shrinks (an entry whose name no longer appears in code is a failure). Suppress a non-flag mention in code with `// allow-feature-flag: <reason>` on the line or the line above. Overdue rows warn but do not fail CI. The guard runs in `test:preflight`. **New flag writers must add their row in the same PR as the flag — no new `WAVEMILL_*` without a doc entry.**
