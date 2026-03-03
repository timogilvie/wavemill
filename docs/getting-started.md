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

Edit `.wavemill-config.json` and set:

- Linear project name
- Base branch (usually `main`)
- Parallelism and agent defaults as needed

## Next Steps

- For guided feature execution: [Feature Workflow](feature-workflow.md)
- For autonomous backlog processing: [Mill Mode](mill-mode.md)

## See Also

- [Mill Mode](mill-mode.md) — autonomous parallel backlog processing
- [Plan Mode](plan-mode.md) — decompose epics into well-scoped sub-issues
- [Expand Mode](expand-mode.md) — batch expand issues into task packets
- [Eval Mode](eval-mode.md) — evaluate LLM performance on workflows
- [Troubleshooting](troubleshooting.md) — common issues and fixes
