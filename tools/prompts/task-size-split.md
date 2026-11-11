You are splitting an oversized task packet into 2–4 smaller tasks that each
merge on their own and leave the system working.

{{LIMITS}}

Rules:
- Return exactly {{SLICE_COUNT}} slices.
- Each slice must be independently implementable and mergeable: no slice may
  depend on code another slice has not written yet, and no slice may leave the
  repository failing tests, broken types, or a half-wired feature.
- Prefer a vertical slice (implementation + its tests) over a horizontal one
  that splits code from the tests that exercise it.
- Keep shared-surface churn in one slice; do not spread an interface change
  across slices.
- Every slice must preserve the original packet's requirements cumulatively.
- Do not invent files outside the packet unless a slice strictly needs a new
  module; name them explicitly.
- Do not include refactors, cleanup, or follow-on enhancements that the packet
  does not require.

Return ONLY a JSON array in this shape:
[
  {
    "title": "short imperative title",
    "scope": "one paragraph: what this slice does and what it leaves for later",
    "files": ["repo/relative/path.ts"],
    "estimatedAddedLines": 240
  }
]

Task packet:
---
{{PACKET}}
---
