---
title: Wavemill
---

**Wavemill** is a self-improving software factory for LLM-driven development. Run `wavemill mill` to pull work from your backlog, expand thin tasks, route each task to the right model, build in parallel, evaluate outcomes, and improve future routing.

Wavemill learns from your own workflow data by default. If you opt into Hokusai, it can also benefit from collective routing intelligence built from many teams' results.

```
Backlog → Expand → Route → Build → Review → Ready → Eval → Learn
                        ↑                                   |
                        └──── routing improves over time ───┘
```

Optional: enable [autonomous integration](autonomous-integration.md) and Wavemill also handles `Ready → Tend → Promote → main`, merging reviewed PRs into a staging branch and opening a managed promotion PR to your trunk.

## Default Workflow

1. **`wavemill mill`** pulls prioritized work and runs the factory loop.
2. **Task expansion** fills in missing implementation detail automatically when needed.
3. **Routing** picks planner, coder, and reviewer models based on historical outcomes.
4. **Parallel execution** launches isolated worktrees and monitors PR progress.
5. **Eval and challenge data** feed the router so future tasks are assigned better.

## Use Wavemill In Two Ways

### 1) Run the factory

Use [`wavemill mill`](mill-mode.md) as the default operating mode for continuous automated software development.

### 2) Use targeted tools when needed

Use supporting commands when you need to prepare work, inspect outcomes, or intervene manually:

- [`wavemill expand`](expand-mode.md) for task-packet generation
- [`wavemill plan`](plan-mode.md) for breaking down larger epics
- [`wavemill review`](review-mode.md) for targeted PR review
- [`wavemill eval`](eval-mode.md) for performance analysis
- [`wavemill route`](routing-and-hokusai.md) for inspecting routing decisions
- [`wavemill tend`](autonomous-integration.md) for autonomous merging into a staging branch before `main`
- [Adding Models](model-additions.md) for the maintainer checklist when new models become available
- [Native Launch Certification](native-launch-certification.md) for native model runability and launch certification status
- [Terminal Lifecycle Certification](terminal-lifecycle-certification.md) for cleanup shadow rollout, soak gates, and rollback
- [`wavemill context`](cli-reference.md) for maintaining agent-readable project memory

## Quick Start

```bash
# install
./install.sh

# configure a repo
wavemill init

# run the factory
wavemill mill
```

For setup and first-run details, start with [Getting Started](getting-started.md).

To understand the self-improving loop, see [Routing & Hokusai](routing-and-hokusai.md). For the full command surface, see [CLI Reference](cli-reference.md).

Wavemill is open source under the [MIT License](https://github.com/timogilvie/wavemill/blob/main/LICENSE).
