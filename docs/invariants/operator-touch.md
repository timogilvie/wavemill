---
title: Operator touch
---

# Operator touch

`human-touch-guard.ts` `HUMAN_TOUCH_GUARD` / `tools/check-human-touch.ts` - The one operator-touch classifier invariant (HOK-3455): every decision about whether a person had to act is made by `classifyOperatorTouch` in `shared/lib/operator-intervention.ts`. The guard forbids retired secondary filters (`NON_OPERATOR_EVAL_DETECTORS`, `WORKFLOW_AUTOMATION_PATTERNS`, `isWorkflowAutomationMessage`), private regexes over known mill-automated text, secondary `(NON_OPERATOR|AUTOMATION|HUMAN)_*` pattern tables, and reading transcript provenance (`isMeta`, `isCompactSummary`, `promptSource`, `origin.kind`) to judge a person outside the classifier and its one transcript reader. `tools/human-touch-allowlist.txt` is the ratchet; suppress one line with `// allow-human-touch: <reason>` (or `#` in shell). The guard runs in `test:preflight`.
