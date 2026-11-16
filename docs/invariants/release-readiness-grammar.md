---
title: Release Readiness grammar
---

# Release Readiness grammar

`shared/lib/task-packet-utils.ts` `extractReleaseReadiness()` /
`tools/check-release-readiness-grammar.ts` (HOK-3499).

"What does this plan's Release Readiness section say?" has exactly one
answer. `extractReleaseReadiness` is the only parser: the planning gate
(`validateFinalPlanningArtifact`), the task-packet validator
(`validateReleaseReadiness`) and the ready-stage consumer all read the section
through it.

The grammar it owns:

- Heading: `##` or `###`, an optional numeric prefix, and an optional suffix
  after `Release Readiness` (`## Release Readiness (v2)`). Headings inside
  fenced code blocks are ignored.
- Field bullet: optional `-`/`*` marker, bold name, with the colon either
  inside or outside the bold — `- **field**: value` and `- **field:** value`
  both parse.
- Required fields: `database_change_risk`, `env_changes`, `config_changes`,
  `manual_steps` (`RELEASE_READINESS_FIELDS`, in gate order).

The parse returns the fields plus `missingFields` — the required fields the
section does not declare. A missing `database_change_risk` is `undefined` and
listed in `missingFields`; it is never invented as `none`. The gate turns the
first missing field into `missing_release_readiness_<field>`, the same reason
names `PLAN_REPAIR_INSTRUCTIONS` and the failure policy already use.

**Never author a second Release Readiness grammar.** A regex literal naming a
required field (for example `/\*\*database_change_risk\*\*/`) outside
`task-packet-utils.ts` fails preflight. Prompts and canary fixtures are not
scanned; test files are excluded. Suppress a justified line with
`// allow-release-readiness-grammar: <reason>`.
