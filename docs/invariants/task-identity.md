---
title: Task identity
---

# Task identity

`shared/lib/task-identity.ts` / `shared/lib/task-identity.sh` - The task-identity invariant (HOK-3113..HOK-3118): every task-ID → Linear-issue-ID derivation, challenger check, and challenger-ID construction goes through this helper (`parseTaskId`, `resolveLinearIssueId`, `isChallengerTaskId`, `challengerTaskId`, `challengerTaskKey`, `isLinearWriter`, and the bash twins `task_identity_linear_id` / `task_identity_is_challenger` / `task_identity_challenger_id` / `task_identity_challenger_key`). Both are pinned against `tests/fixtures/task-identity-cases.json` and change together. **Never parse or build `_c` inline, and never author an inline issue-ID regex outside `task-identity.*`.** The HOK-3118 preflight guard (`tools/check-task-identity.ts`, in `test:preflight`) fails on `_c$`-anchored patterns (`endsWith('_c')`, `.replace(/_c$/…)`, `${…}_c`, `%_c`, `*_c ]]`, `sub("_c$"…)`, `endswith("_c")`) and inline issue-ID regex literals (`[A-Z]+-\d+` and variants) anywhere outside the invariant and its own guard. Narrow justified exceptions live in `tools/task-identity-allowlist.txt` with a reason; one-off suppressions use `// allow-task-identity: <reason>` (or `#` in shell) on the finding line or the line above.
