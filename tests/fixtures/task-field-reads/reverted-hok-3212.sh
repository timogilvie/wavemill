#!/usr/bin/env bash
# Fixture: a reverted-HOK-3212 snapshot. These are the exact drift reads the
# merge-label reconciler shipped with: a task-record field name no writer
# ever sets (`prNumber`). The task-field-read guard must flag both forms —
# the `get_task_meta` call and the jq `.tasks[$i].prNumber` path — so the
# A4 guard proves it would have caught HOK-3212 before merge.
#
# This file lives under tests/fixtures/; the guard's main sweep skips the
# `tests/` prefix, so it never fires in CI. The unit test invokes the
# checker on this fixture directly.

reconcile_merge_labels_for_pr() {
  local issue="$1" state
  state="$(cat .wavemill/workflow-state.json)"
  local pr
  pr=$(get_task_meta "$issue" prNumber)
  echo "$state" | jq --arg i "$issue" '.tasks[$i].prNumber // empty'
}
