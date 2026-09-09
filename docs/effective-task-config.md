---
title: Effective Task Configuration
---

## Overview

Wavemill records the effective per-task lifecycle configuration at launch and
uses that persisted contract for monitor, status, Tend, Observer, and cleanup
decisions. This prevents mutable repo config from changing the meaning of an
already-running task.

## Precedence

Highest priority first:

1. Task `lifecycle.launchContract`
2. `.wavemill/runtime-env/<issue>.json` legacy runtime snapshot
3. User config at `~/.wavemill/config.json`
4. Repository config at `.wavemill-config.json`
5. Built-in defaults

Each resolved field carries a source label: `launch-contract`, `runtime-env`,
`cli`, `user-config`, `repo-config`, or `default`. When the winning value differs
from repository config, status and Observer render the repo value as drift so an
operator can see intentional launch/runtime overrides.

Runtime snapshots are an explicit allowlist: issue, session, run epoch, base
branch, confirmation policy, merge method, source labels, and capture time. They
must not contain arbitrary environment variables or secrets.

`WAVEMILL_EFFECTIVE_CONFIG_LEGACY=1` bypasses launch-contract reads in the
resolver. It is a compatibility adapter for rollback and does not delete stored
contract or provenance data.
