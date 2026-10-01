You are judging the execution order of pairs of software tasks for a parallel work planner.

The planner has already predicted, from the repository itself, which files each task will modify (its touch set) and scored each pair deterministically. Your only job is to judge the pairs below. Do not invent new pairs, and do not plan waves or schedules.

Touch-set sources: `explicit` = path written in the task, `resolved` = a named file or function resolved with git, `predicted` = an LLM guess (weakest evidence).

Pair signals: `file_overlap` (same file in both touch sets), `hot_file` (an overlapping file is a merge-conflict hotspot), `region_overlap` / `disjoint_regions` (same / different functions inside a hot file), `co_change` (files historically edited together), `series` ("n/m" titles), `cross_reference` (one task names the other), `sweep` (a repo-wide mechanical change), `explicit_dependency` (already linked in Linear).

Tasks:
{{TASKS}}

Pairs to judge:
{{PAIRS}}

Classify each pair `(a, b)` as exactly one of:
- `must_precede`: `a` MUST finish before `b` starts, because `b` consumes something `a` creates or changes (a new function, schema, file, or API).
- `should_precede`: `a` SHOULD go first (series order, `b` builds on `a`, or `b` is much easier to write after `a` lands), but `b` is not impossible without `a`.
- `conflict`: the two tasks edit the same code region and would produce merge conflicts if run in parallel, with no meaningful order between them.
- `independent`: safe to run in parallel.

Rules:
- You MUST give an `evidence` string for every verdict other than `independent`. Evidence must cite something concrete from the input: a shared file path, a function name, a series marker, or a sentence from a task description. A verdict without concrete evidence is discarded and treated as `independent`.
- If you cannot point to concrete evidence, answer `independent`. Shared subject matter alone is not evidence.
- For `must_precede` and `should_precede`, `a` is the task that goes first. You may swap the pair's order to express the direction.
- Prefer `conflict` over an ordering verdict when the only connection is the same file.
- Files in different, unrelated regions of a large hot file (`disjoint_regions`) are usually `independent` unless the descriptions show they edit the same function.
- Use each pair at most once.

Return JSON only, no markdown fence, in exactly this shape:
{
  "verdicts": [
    { "a": "HOK-1", "b": "HOK-2", "verdict": "conflict", "evidence": "Both modify the poll loop in shared/lib/wavemill-monitor.sh" },
    { "a": "HOK-3", "b": "HOK-4", "verdict": "independent" }
  ]
}
