# stale-base fixture

Commit-count drift cannot be captured as a static file, so this scenario is
built as a real git repository in code (`createStaleBaseGitFixture()` in
`tools/observer.test.ts`), following the same bare-origin + worktree pattern
`createResidueGitFixture()` already uses for the terminal-task-parked tests:

1. `auto/integration` is created, committed, and pushed to a bare `origin`.
2. A task branch (`task/<slug>`) is cut from it, gets one commit, and is
   pushed.
3. `auto/integration` then advances past the branch point by N more commits
   and is pushed again (updating the local `origin/auto/integration`
   remote-tracking ref).

This reproduces REQ-F4 (`behindBase > 5` ⇒ `medium` finding via
`detectBranchBehindBase`) and, with `N <= 2`, the negative case (no finding).
REQ-F5 (severity elevation on `wm:ready`) is exercised by calling
`detectBranchBehindBase` directly with an injected `readPrLabels` — no test
ever shells out to `gh`.
