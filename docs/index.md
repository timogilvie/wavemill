---
title: Wavemill
---

Wavemill helps developers build software more effectively with LLMs. It connects a backlog in Linear with tools to plan and build faster. Wavemill supports using Linear as backlog planner and Claude/Codex as implementation agents but makes it easy to extend to other tools.

## What Wavemill Handles

- Pulls prioritized tasks from Linear.
- Expands thin issues into implementation-ready packets.
- Runs parallel agent worktrees with conflict safeguards.
- Tracks PR and workflow progress with validation gates.

## Core Modes

### 1) Autonomous mill mode

Use `wavemill mill` to continuously process backlog tasks in parallel. 

### 2) Epic planning

Use `wavemill plan` to break an epic/larger body of work into chunks that LLMs can handle and add them as Linear tasks that can be milled later.

### 3) LLM-powered code review

Use `review-changes` or `review-pr` to get structured, LLM-powered code review that catches major issues — logic bugs, security concerns, plan deviations, and UI inconsistencies. Runs automatically in the feature workflow.

### 4) Human-in-the-loop workflow

Use workflow commands to move one feature from backlog to PR with explicit review gates.

## Quick Command Reference

```bash
# install + verify
./install.sh
wavemill help

# configure repo
wavemill init

# autonomous backlog loop
wavemill mill

# Expand an epic
wavemill plan

# expand backlog issues into task packets
wavemill expand
```

For full setup, go to [Getting Started](getting-started.md).

Wavemill is open source under the [MIT License](https://github.com/timogilvie/wavemill/blob/main/LICENSE).
