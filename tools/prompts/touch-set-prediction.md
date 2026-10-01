You are predicting which existing repository files each software task will modify.

These tasks did not name any file or function, so their touch sets must be predicted. Use only paths that plausibly exist in this repository: the directory tree and keyword hits below are your ground truth. Do not invent new files; list only existing files that the task will edit.

Repository directories:
{{DIRECTORY_TREE}}

Tasks:
{{TASKS}}

Rules:
- Return at most 8 files per task, most likely first.
- Use repo-relative paths (for example `shared/lib/config.ts`), never absolute paths.
- If you cannot make a grounded prediction for a task, return an empty `files` array for it.

Return JSON only, no markdown fence, in exactly this shape:
{
  "predictions": [
    { "id": "HOK-1", "files": ["shared/lib/example.ts", "tools/example.ts"] }
  ]
}
