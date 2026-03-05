---
title: Getting Started
---

## Prerequisites

- Node.js 18+
- npm
- `tmux`
- `jq`
- Linear API key (`LINEAR_API_KEY`)
- Optional: GitHub CLI (`gh`)

## 1) Install Wavemill

```bash
git clone https://github.com/timogilvie/wavemill/ wavemill
cd wavemill
./install.sh
wavemill help
```

## 2) Configure Linear Access

```bash
export LINEAR_API_KEY="your-key-here"
```

Add that export to your shell profile for persistence.

## 3) Initialize Repo Config

In the target project repo:

```bash
wavemill init
```

This creates a comprehensive `.wavemill-config.json` with all available sections:

- **linear**: Project name for backlog queries
- **mill**: Continuous execution settings (parallelism, agent, worktree root)
- **expand**: Batch expansion settings
- **plan**: Epic decomposition settings
- **eval**: LLM evaluation with judge model, pricing, and intervention penalties
- **autoEval**: Auto-run eval after workflow completion
- **review**: Self-review loop configuration
- **router**: Model routing based on historical eval data
- **validation**: Task packet validation layers
- **constraints**: Constraint rule validation
- **ui**: UI review and design verification settings
- **permissions**: Auto-approve patterns for agent tools

Edit `.wavemill-config.json` and set:

- Linear project name (required)
- Base branch (usually `main`)
- Parallelism and agent defaults as needed
- Enable/disable features like autoEval, router, review, etc.

### Config Versioning

The config includes a `configVersion` field to track format compatibility. When running `wavemill mill`, `expand`, or `plan`, you'll be prompted to upgrade if your config is outdated.

To manually upgrade:

```bash
npx tsx tools/sync-config.ts
```

To skip version checks:

```bash
SKIP_CONFIG_CHECK=true wavemill mill
```

## Next Steps

- For guided feature execution: [Feature Workflow](feature-workflow.md)
- For autonomous backlog processing: [Mill Mode](mill-mode.md)

## See Also

- [Mill Mode](mill-mode.md) — autonomous parallel backlog processing
- [Plan Mode](plan-mode.md) — decompose epics into well-scoped sub-issues
- [Expand Mode](expand-mode.md) — batch expand issues into task packets
- [Eval Mode](eval-mode.md) — evaluate LLM performance on workflows
- [Troubleshooting](troubleshooting.md) — common issues and fixes
