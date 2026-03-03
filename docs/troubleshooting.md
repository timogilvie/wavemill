---
title: Troubleshooting
---

## Command Not Found: `wavemill`

- Confirm install ran successfully: `./install.sh`
- Confirm binary is on your `PATH`
- Restart shell and rerun `wavemill help`

## Linear API Errors

- Verify `LINEAR_API_KEY` is set in the current shell
- Verify configured project exists in `.wavemill-config.json`
- Retry with explicit environment export

## `tmux` Session Problems in Mill Mode

- Confirm `tmux` is installed and available in shell
- Check existing session names for conflicts
- Set `SESSION=<name>` to isolate runs

## PR/Workflow Drift

Symptoms: plan does not match implementation or tests are skipped.

Fix:

1. stop current phase
2. reconcile plan vs code changes
3. rerun tests
4. resume only after explicit phase approval
