You are analyzing a backlog subset to infer task dependency edges.

changedTaskIds: {{CHANGED_TASK_IDS}}

Context tasks:
{{CONTEXT_TASKS}}

Rules:
- You MUST only propose edges where at least one endpoint task ID appears in `changedTaskIds`.
- Do NOT propose edges between two context-only tasks.
- Only emit concrete task relationships, not plans, waves, queues, scheduling, sequencing, or execution order commentary.
- Use `depends_on` when one task must happen before another.
- Use `shared_surface` when two tasks should avoid parallel execution because they touch the same user-visible or code surface.
- `reason` must be at most 12 words. No prose, no reasoning, no lead-ins.

Return JSON only, no prose, no markdown fences, in this exact shape:
{
  "edges": [
    {
      "from": "HOK-1",
      "to": "HOK-2",
      "type": "depends_on",
      "reason": "HOK-2 extends API from HOK-1"
    }
  ]
}
