#!/usr/bin/env bash
# Monitor async ready-path checks (HOK-3206)
#
# The cross-PR revert guard, the PR CI status read, the ready watchdog, the
# plan->code expanded reroute and the pre-approval expansion recovery (HOK-3253)
# each used to run synchronously inside a monitor pass (19 s, ~2.5 s per PR,
# ~5 s, 30-60 s and up to 300 s respectively). They now run as
# tracked background jobs (`launch_tracked_job` / job-tracker.ts) and publish a
# condition-keyed result marker; the loop consumes the marker on a later pass.
#
# Contract (HOK-3172):
#   * A result is valid only for the condition it was computed against (task
#     head, PR head, base tip, packet hash). Readers re-check that condition on
#     every read, and the condition reconciler expires the marker when the
#     condition moves. A result for another head is never consumed.
#   * Absent / stale result -> "pending": launch the job (bounded) and let the
#     caller hold. Pending never reads as pass.
#   * A job that crashes or times out produces no result; its failure charges a
#     bounded-retry bucket (HOK-2924) keyed on the same condition. Exhaustion
#     terminalizes with a recorded reason instead of holding forever.
#
# Sourced by wavemill-monitor.sh after wavemill-common.sh, transient-marker.sh
# and bounded-retry.sh. Every function here resolves monitor helpers
# (launch_tracked_job, write_ready_attention_file, log, …) at call time.
#
# The sync fallbacks that let the pre-HOK-3206 inline paths run were retired
# in HOK-3235. Tests source `tests/lib/inline-ready-checks.sh` to pin the
# inline contract where they need it.

WAVEMILL_MONITOR_ASYNC_JOBS_LOADED=1

ASYNC_CHECK_JOB_RETRY_LIMIT="${WAVEMILL_ASYNC_CHECK_JOB_RETRY_LIMIT:-3}"
# Re-read CI for a PR at most this often while a result for its head exists.
PR_CI_STATUS_REFRESH_SECONDS="${WAVEMILL_PR_CI_STATUS_REFRESH_SECONDS:-30}"
# A CI result with no live PR head to compare against is trusted this long.
PR_CI_STATUS_MAX_AGE_SECONDS="${WAVEMILL_PR_CI_STATUS_MAX_AGE_SECONDS:-600}"

# Per-pass diagnostics for monitor-timing.json `.jobs` (launched / consumed /
# pending per kind). Reset by monitor_async_job_stats_reset each pass.
declare -A MONITOR_ASYNC_JOB_STATS=()

monitor_async_job_stats_reset() {
  MONITOR_ASYNC_JOB_STATS=()
}

monitor_async_job_stat() {
  local kind="$1" field="$2" key
  key="${kind}.${field}"
  MONITOR_ASYNC_JOB_STATS["$key"]=$(( ${MONITOR_ASYNC_JOB_STATS[$key]:-0} + 1 ))
}

# JSON object {kind: {launched, consumed, pending}} for monitor-timing.json.
monitor_async_job_stats_json() {
  local key pairs=""
  for key in "${!MONITOR_ASYNC_JOB_STATS[@]}"; do
    pairs+="${key}"$'\t'"${MONITOR_ASYNC_JOB_STATS[$key]}"$'\n'
  done
  printf '%s' "$pairs" | jq -R -s '
    split("\n") | map(select(length > 0) | split("\t"))
    | reduce .[] as $row ({}; ($row[0] | split(".")) as $k | .[$k[0]][$k[1]] = ($row[1] | tonumber))
  ' 2>/dev/null || echo '{}'
}

# ── Generic tracked-job launcher ─────────────────────────────────────────────

monitor_async_job_dir() {
  local job_id="$1" dir
  dir="${STATE_DIR:-/tmp/${SESSION:-wavemill}}/async-jobs/$(sanitize_job_token "$job_id")"
  mkdir -p "$dir" 2>/dev/null || true
  printf '%s\n' "$dir"
}

# Jobs older than this are never "running", even if their pid is alive: a
# restarted monitor must not wait forever on a pid the OS has reused.
ASYNC_JOB_MAX_RUNTIME_SECONDS="${WAVEMILL_ASYNC_JOB_MAX_RUNTIME_SECONDS:-3600}"

# Exit 0 while the job's background process is still alive.
monitor_async_job_running() {
  local job_id="$1" dir pid started_at
  dir="$(monitor_async_job_dir "$job_id")"
  read -r pid started_at 2>/dev/null < "$dir/inflight" || return 1
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  if [[ "$started_at" =~ ^[0-9]+$ ]] && (( $(date +%s) - started_at > ASYNC_JOB_MAX_RUNTIME_SECONDS )); then
    return 1
  fi
  kill -0 "$pid" 2>/dev/null
}

# monitor_async_job_launch <kind> <job_id> <issue> <pr_numbers> <timeout_s> <meta_json> <runner> [args...]
#
# Forks <runner> [args...] in a background subshell that registers itself as a
# tracked job (so job-tracker.ts supervises timeout and exit classification)
# and writes the tracker result file on exit. The runner writes its own
# condition-keyed result marker and returns 0 when it produced a verdict, or
# non-zero when it crashed without one. <meta_json> is stored beside the job
# so the poll arm can charge the right bounded-retry bucket on failure.
# No-op (exit 0) while a job with this id is already running.
monitor_async_job_launch() {
  local kind="$1" job_id="$2" issue="$3" pr_numbers="$4" timeout_s="$5" meta_json="$6" runner="$7"
  shift 7
  local dir log_path result_path pid
  monitor_async_job_running "$job_id" && return 0

  dir="$(monitor_async_job_dir "$job_id")"
  log_path="$dir/job.log"
  result_path="$dir/job-result.json"
  rm -f "$result_path"
  [[ -n "$meta_json" ]] || meta_json='{}'
  printf '%s\n' "$meta_json" > "$dir/meta.json" 2>/dev/null || true
  : > "$log_path"

  (
    # The ledger shadow mirror is for waiting-on markers, not job results.
    export WAVEMILL_LEDGER_SHADOW_DISABLED=1
    launch_tracked_job "$kind" "$job_id" "$issue" "" "" "$pr_numbers" "$BASHPID" "$timeout_s" "$log_path" "$result_path" \
      >>"$log_path" 2>&1 || true
    local rc=0
    _with_timeout "$timeout_s" "$runner" "$@" >>"$log_path" 2>&1 || rc=$?
    jq -cn --argjson rc "$rc" --arg kind "$kind" \
      '{ok: ($rc == 0), exitCode: $rc, kind: $kind} + (if $rc == 0 then {} else {reason: (if $rc == 124 then "timed_out" else "job_failed" end)} end)' \
      > "${result_path}.tmp" 2>/dev/null && mv "${result_path}.tmp" "$result_path"
  ) </dev/null >/dev/null 2>&1 &
  pid=$!
  printf '%s %s\n' "$pid" "$(date +%s)" > "$dir/inflight"
  disown "$pid" 2>/dev/null || true
  monitor_async_job_stat "$kind" launched
  return 0
}

# Poll arm for check kinds (called from poll_tracked_jobs for unsettled jobs;
# succeeded check jobs are settled by job-tracker.ts itself). A failed or
# timed-out job charges its bounded-retry bucket keyed on the recorded
# condition, so the next launch backs off and eventually terminalizes.
handle_check_job_failure() {
  local job_id="$1" kind="$2" status="$3" reason="$4" result_path="$5" excerpt="${6:-}"
  local dir meta state_dir bucket key
  dir="$(dirname "$result_path")"
  meta="$(cat "$dir/meta.json" 2>/dev/null || echo '{}')"
  state_dir="$(jq -r '.stateDir // empty' <<<"$meta" 2>/dev/null || true)"
  bucket="$(jq -r '.bucket // empty' <<<"$meta" 2>/dev/null || true)"
  key="$(jq -r '.key // empty' <<<"$meta" 2>/dev/null || true)"
  if [[ -n "$state_dir" && -n "$bucket" && -n "$key" ]]; then
    bounded_retry_reset_if_new_head "$state_dir" "$bucket" "$key"
    bounded_retry_increment "$state_dir" "$bucket" "$key" >/dev/null
  fi
  # The watchdog is advisory: its consumer rate-limits failure logging.
  if [[ "$kind" != "ready-watchdog" ]]; then
    log_warn "${kind} job ${job_id} ${status} (${reason:-unknown}); log: $dir/job.log"
    if [[ -n "$excerpt" ]]; then
      while IFS= read -r line; do
        [[ -n "$line" ]] && log_warn "  $line"
      done <<<"$excerpt"
    fi
  fi
}

# _async_check_retry_gate <state_dir> <bucket> <key>
# Echoes the bounded_retry_gate decision for an async check's job budget.
_async_check_retry_gate() {
  bounded_retry_gate "$1" "$2" "$3" "$ASYNC_CHECK_JOB_RETRY_LIMIT" 15 120
}

# ── Cross-PR revert guard ────────────────────────────────────────────────────

CROSS_PR_GUARD_RESULT_MARKER=".cross-pr-guard-result.json"
CROSS_PR_GUARD_JOB_BUCKET="cross-pr-guard-job"

# Tip of the compare base the guard diffs against; part of the result's key
# (a base that moved can merge a PR the head now reverts).
_cross_pr_guard_base_sha() {
  local wt_dir="$1" base_branch="${2-}" ref
  [[ -n "$base_branch" ]] || { printf '\n'; return 0; }
  ref="$(wavemill_base_compare_ref "$base_branch")"
  git -C "$wt_dir" rev-parse --verify -q "${ref}^{commit}" 2>/dev/null || printf '\n'
}

# Background runner: run the guard, record {rc, stdout, stderr, baseSha} in a
# result marker keyed on the head it diffed. Returns non-zero (job failure)
# when the tool crashed without a verdict.
cross_pr_guard_job_run() {
  local wt_dir="$1" state_dir="$2" head_sha="$3" base_sha="$4" base_branch="${5-}"
  local result rc=0 stderr_file raw_error="" detail head_after
  local -a extra_args=()
  if [[ -n "$base_branch" ]]; then
    local compare_base_ref
    compare_base_ref="$(wavemill_base_compare_ref "$base_branch")"
    extra_args+=(--base-ref "$compare_base_ref" --integration-ref "$compare_base_ref")
  fi
  stderr_file="$(mktemp 2>/dev/null)" || stderr_file="/dev/null"
  result=$(cd "$wt_dir" && wavemill_run_tool "check-cross-pr-reverts.ts" --repo-dir "$wt_dir" "${extra_args[@]}" 2>"$stderr_file") || rc=$?
  [[ "$stderr_file" != "/dev/null" ]] && { raw_error="$(cat "$stderr_file" 2>/dev/null || true)"; rm -f "$stderr_file"; }

  # The guard diffs the checkout: a head that moved mid-run makes the verdict
  # ambiguous. Publish nothing; the next pass relaunches for the new head.
  head_after="$(git -C "$wt_dir" rev-parse HEAD 2>/dev/null || true)"
  if [[ "$head_after" != "$head_sha" ]]; then
    echo "cross-pr guard: head moved ${head_sha:0:7} -> ${head_after:0:7} during run; discarding verdict"
    return 0
  fi

  # 0 = pass, 1 = unacknowledged reverts, 2 + toolError = deterministic tool
  # verdict. Anything else is a crash: no verdict, charge the retry budget.
  if ! { (( rc == 0 || rc == 1 )) || { (( rc == 2 )) && printf '%s' "$result" | jq -e '.toolError' >/dev/null 2>&1; }; }; then
    jq -cn --argjson rc "$rc" --arg stderr "${raw_error:0:4096}" '{rc: $rc, stderr: $stderr}' \
      > "$state_dir/.cross-pr-guard-last-failure.json" 2>/dev/null || true
    echo "cross-pr guard crashed (exit $rc): ${raw_error:0:400}"
    return 1
  fi

  detail="$(jq -cn --argjson rc "$rc" --arg stdout "$result" --arg stderr "${raw_error:0:4096}" --arg baseSha "$base_sha" \
    '{rc: $rc, stdout: $stdout, stderr: $stderr, baseSha: $baseSha}')"
  marker_write "$state_dir/$CROSS_PR_GUARD_RESULT_MARKER" \
    --kind cross-pr-guard \
    --head "$head_sha" \
    --expires-on "head,operator-event" \
    --reason "cross-pr guard exit $rc" \
    --detail-json "$detail"
}

# ready_cross_pr_revert_gate <issue> <state_dir> <wt_dir> <pr_number> [base_branch]
# Returns 0 = guard passed, 1 = blocked / tool error (Ready evidence and the
# attention marker are written exactly as the inline gate does), 4 = pending
# (the guard job is running or backing off; caller holds Ready).
ready_cross_pr_revert_gate() {
  local issue="$1" state_dir="$2" wt_dir="$3" pr_number="$4" base_branch="${5-}"
  local head_sha base_sha marker detail rc decision job_id meta failure

  head_sha="$(git -C "$wt_dir" rev-parse HEAD 2>/dev/null || true)"
  if [[ -z "$head_sha" ]]; then
    cross_pr_revert_gate_allows_merge "$issue" "$state_dir" "$wt_dir" "$pr_number" "$base_branch"
    return $?
  fi
  base_sha="$(_cross_pr_guard_base_sha "$wt_dir" "$base_branch")"
  marker="$state_dir/$CROSS_PR_GUARD_RESULT_MARKER"

  # Consume a verdict only for this exact head and base tip.
  if ! marker_is_stale "$marker" "$head_sha"; then
    detail="$(jq -c '.detail // {}' "$marker" 2>/dev/null || echo '{}')"
    if [[ "$(jq -r '.baseSha // ""' <<<"$detail")" == "$base_sha" ]]; then
      rc="$(jq -r '.rc // 2' <<<"$detail")"
      monitor_async_job_stat cross-pr-guard consumed
      cross_pr_revert_gate_apply_result "$issue" "$state_dir" "$pr_number" "$head_sha" "$rc" \
        "$(jq -r '.stdout // ""' <<<"$detail")" "$(jq -r '.stderr // ""' <<<"$detail")"
      return $?
    fi
  fi

  job_id="cross-pr-guard-$(sanitize_job_token "$issue")"
  monitor_async_job_stat cross-pr-guard pending
  monitor_async_job_running "$job_id" && return 4

  decision="$(_async_check_retry_gate "$state_dir" "$CROSS_PR_GUARD_JOB_BUCKET" "$head_sha")"
  case "$decision" in
    exhausted|exhausted-quiet)
      if [[ "$decision" == "exhausted" ]]; then
        bounded_retry_mark_exhausted "$state_dir" "$CROSS_PR_GUARD_JOB_BUCKET" \
          "Cross-PR revert guard job failed ${ASYNC_CHECK_JOB_RETRY_LIMIT} time(s) at ${head_sha:0:12}" || true
      fi
      # Terminal for this head: surface the last crash through the inline
      # gate's generic tool-failure path (attention marker, diagnostic).
      failure="$(cat "$state_dir/.cross-pr-guard-last-failure.json" 2>/dev/null || echo '{}')"
      cross_pr_revert_gate_apply_result "$issue" "$state_dir" "$pr_number" "$head_sha" \
        "$(jq -r '.rc // 3' <<<"$failure")" "" "$(jq -r '.stderr // "cross-pr guard job retries exhausted"' <<<"$failure")"
      return 1
      ;;
    backoff)
      return 4
      ;;
  esac

  meta="$(jq -cn --arg s "$state_dir" --arg b "$CROSS_PR_GUARD_JOB_BUCKET" --arg k "$head_sha" '{stateDir: $s, bucket: $b, key: $k}')"
  monitor_async_job_launch cross-pr-guard "$job_id" "$issue" "$pr_number" "${WAVEMILL_CROSS_PR_GUARD_TIMEOUT_SECONDS:-120}" "$meta" \
    cross_pr_guard_job_run "$wt_dir" "$state_dir" "$head_sha" "$base_sha" "$base_branch"
  return 4
}

# ── PR CI status ─────────────────────────────────────────────────────────────

PR_CI_STATUS_RESULT_MARKER=".pr-ci-status-result.json"
PR_CI_STATUS_JOB_BUCKET="pr-ci-status-job"

# Background runner: read live CI for a PR and publish it keyed on the PR's
# GitHub head (remote condition). A read that cannot name a head is a failure.
pr_ci_status_job_run() {
  local wt_dir="$1" state_dir="$2" pr_number="$3" base_branch="$4"
  local output head detail
  output=$(wavemill_run_tsx_tool "$TOOLS_DIR/pr-ci-status.ts" "$pr_number" --repo-dir "$wt_dir" --base "$base_branch") || return 1
  printf '%s' "$output" | jq -e '.conclusion' >/dev/null 2>&1 || { echo "pr-ci-status: unparseable output"; return 1; }
  head="$(printf '%s' "$output" | jq -r '.headSha // empty')"
  if [[ -z "$head" ]]; then
    echo "pr-ci-status: no PR head in result ($(printf '%s' "$output" | jq -r '.readError.reason // "unknown"'))"
    return 1
  fi
  detail="$(jq -cn --argjson ci "$output" --argjson at "$(date +%s)" '{ci: $ci, observedAtEpoch: $at}')"
  marker_write "$state_dir/$PR_CI_STATUS_RESULT_MARKER" \
    --kind pr-ci-status \
    --head "$head" \
    --observed "prHeadRefOid=$head" \
    --expires-on "remote,operator-event" \
    --reason "CI ${pr_number}@${head:0:7}" \
    --detail-json "$detail"
}

_pr_ci_pending_json() {
  local pr_number="$1" reason="$2" head="${3:-}"
  jq -cn --arg pr "$pr_number" --arg reason "$reason" --arg head "$head" '
    {conclusion: "unknown", observed: 0, passing: 0, failing: [], pending: [], missingRequired: [],
     requiredContexts: [], requiredSource: "none", pendingReason: $reason}
    + (if $head == "" then {} else {headSha: $head} end)'
}

_pr_ci_read_error_json() {
  local pr_number="$1"
  jq -cn --arg reason "pr-ci-status failed for PR #$pr_number" \
    '{conclusion:"unknown", observed:0, passing:0, failing:[], pending:[], missingRequired:[], requiredContexts:[], requiredSource:"none", readError:{errorType:"command-failed", reason:$reason}}'
}

# ready_ci_json_cached <wt_dir> <pr_number> <base_branch> <issue> <state_dir>
# Drop-in for ready_live_ci_json on the merge-queue tick. Prints the last CI
# result recorded for the PR's current GitHub head (from the per-pass PR
# cache), refreshing it in the background when older than
# PR_CI_STATUS_REFRESH_SECONDS. With no result for this head, prints a
# conclusion:"unknown" pending shape (never a pass) and launches the read.
ready_ci_json_cached() {
  local wt_dir="$1" pr_number="$2" base_branch="$3" issue="$4" state_dir="$5"
  local marker live_head="" result_head="" observed_at age now detail job_id meta decision key valid="false"

  marker="$state_dir/$PR_CI_STATUS_RESULT_MARKER"
  live_head="$(wavemill_pr_cache_lookup_pr "$pr_number" headRefOid 2>/dev/null || true)"
  now="$(date +%s)"
  age=999999
  if detail="$(marker_read "$marker" 2>/dev/null)" && [[ -n "$detail" ]]; then
    result_head="$(jq -r '.headSha // empty' <<<"$detail")"
    observed_at="$(jq -r '.detail.observedAtEpoch // 0' <<<"$detail")"
    [[ "$observed_at" =~ ^[0-9]+$ ]] && age=$(( now - observed_at ))
    if [[ -n "$result_head" ]]; then
      if [[ -n "$live_head" ]]; then
        [[ "$result_head" == "$live_head" ]] && valid="true"
      elif (( age <= PR_CI_STATUS_MAX_AGE_SECONDS )); then
        valid="true"
      fi
    fi
  fi

  job_id="pr-ci-status-$(sanitize_job_token "$issue")"
  key="${live_head:-${result_head:-unknown}}"
  if [[ "$valid" == "true" ]]; then
    monitor_async_job_stat pr-ci-status consumed
    if (( age >= PR_CI_STATUS_REFRESH_SECONDS )) && ! monitor_async_job_running "$job_id"; then
      decision="$(_async_check_retry_gate "$state_dir" "$PR_CI_STATUS_JOB_BUCKET" "$key")"
      if [[ "$decision" == "proceed" ]]; then
        meta="$(jq -cn --arg s "$state_dir" --arg b "$PR_CI_STATUS_JOB_BUCKET" --arg k "$key" '{stateDir: $s, bucket: $b, key: $k}')"
        monitor_async_job_launch pr-ci-status "$job_id" "$issue" "$pr_number" "${API_TIMEOUT:-30}" "$meta" \
          pr_ci_status_job_run "$wt_dir" "$state_dir" "$pr_number" "$base_branch"
      fi
    fi
    jq -c '.detail.ci' <<<"$detail"
    return 0
  fi

  monitor_async_job_stat pr-ci-status pending
  if ! monitor_async_job_running "$job_id"; then
    decision="$(_async_check_retry_gate "$state_dir" "$PR_CI_STATUS_JOB_BUCKET" "$key")"
    case "$decision" in
      exhausted|exhausted-quiet)
        # The budget for this head is spent: report the read failure the way
        # the inline reader did, so consumers see readError, not a pass.
        _pr_ci_read_error_json "$pr_number"
        return 0
        ;;
      proceed)
        meta="$(jq -cn --arg s "$state_dir" --arg b "$PR_CI_STATUS_JOB_BUCKET" --arg k "$key" '{stateDir: $s, bucket: $b, key: $k}')"
        monitor_async_job_launch pr-ci-status "$job_id" "$issue" "$pr_number" "${API_TIMEOUT:-30}" "$meta" \
          pr_ci_status_job_run "$wt_dir" "$state_dir" "$pr_number" "$base_branch"
        ;;
    esac
  fi
  _pr_ci_pending_json "$pr_number" "pr-ci-status-running" "$live_head"
}

# ── Ready watchdog ───────────────────────────────────────────────────────────

READY_WATCHDOG_JOB_ID="ready-watchdog"
READY_WATCHDOG_SWEEP_INTERVAL_SECONDS="${WAVEMILL_READY_WATCHDOG_SWEEP_INTERVAL_SECONDS:-30}"

# Background runner: one `ready-watchdog.ts --once` sweep; stdout is published
# atomically to output.json with a sequence number the consumer tracks.
ready_watchdog_job_run() {
  local out_dir="$1" output rc=0 stderr_file err=""
  stderr_file="$(mktemp 2>/dev/null)" || stderr_file="/dev/null"
  output=$(wavemill_run_tool "ready-watchdog.ts" --once --repo-dir "$REPO_DIR" --state-file "$STATE_FILE" --json 2>"$stderr_file") || rc=$?
  [[ "$stderr_file" != "/dev/null" ]] && { err="$(tail -n 1 "$stderr_file" 2>/dev/null | tr '\n' ' ')"; rm -f "$stderr_file"; }
  if (( rc != 0 )) || ! printf '%s' "$output" | jq -e . >/dev/null 2>&1; then
    jq -cn --arg err "${err:-command exited non-zero ($rc)}" --argjson at "$(date +%s)" '{error: $err, at: $at}' \
      > "$out_dir/failure.json.tmp" && mv "$out_dir/failure.json.tmp" "$out_dir/failure.json"
    return 1
  fi
  jq -cn --argjson out "$output" --argjson seq "$(date +%s)$$" --argjson at "$(date +%s)" \
    '{seq: $seq, at: $at, output: $out}' > "$out_dir/output.json.tmp" && mv "$out_dir/output.json.tmp" "$out_dir/output.json"
  rm -f "$out_dir/failure.json"
}

# Async body of run_ready_watchdog_tick: consume the newest unconsumed sweep
# (dispatching its findings exactly as the inline tick did), then start the
# next sweep. Findings older than 2x the sweep timeout are dropped unread.
ready_watchdog_tick_async() {
  local watchdog_timeout="$1"
  local dir output_file seq consumed at now failure err
  dir="$(monitor_async_job_dir "$READY_WATCHDOG_JOB_ID")"
  output_file="$dir/output.json"
  now="$(date +%s)"

  if [[ -f "$output_file" ]]; then
    seq="$(jq -r '.seq // empty' "$output_file" 2>/dev/null || true)"
    at="$(jq -r '.at // 0' "$output_file" 2>/dev/null || echo 0)"
    consumed="$(cat "$dir/consumed-seq" 2>/dev/null || true)"
    if [[ -n "$seq" && "$seq" != "$consumed" ]]; then
      printf '%s\n' "$seq" > "$dir/consumed-seq"
      if [[ "$at" =~ ^[0-9]+$ ]] && (( now - at <= 2 * watchdog_timeout + 60 )); then
        monitor_async_job_stat ready-watchdog consumed
        LAST_READY_WATCHDOG_FAILURE_DETAIL=""
        LAST_READY_WATCHDOG_FAILURE_AT=0
        ready_watchdog_dispatch_findings "$(jq -c '.output' "$output_file")"
      fi
    fi
  fi

  failure="$dir/failure.json"
  if [[ -f "$failure" ]]; then
    err="$(jq -r '.error // empty' "$failure" 2>/dev/null || true)"
    [[ -n "$err" ]] || err="command exited non-zero or timed out after ${watchdog_timeout}s"
    if [[ "${LAST_READY_WATCHDOG_FAILURE_DETAIL:-}" != "$err" || $(( now - ${LAST_READY_WATCHDOG_FAILURE_AT:-0} )) -ge "${READY_WATCHDOG_FAILURE_LOG_INTERVAL:-300}" ]]; then
      log_warn "ready watchdog tick failed: $err"
      LAST_READY_WATCHDOG_FAILURE_DETAIL="$err"
      LAST_READY_WATCHDOG_FAILURE_AT=$now
    fi
  fi

  # Passes are now fast, so cap the sweep cadence (the watchdog's own
  # thresholds are minutes); the inline tick ran once per (slow) pass.
  local launched_at
  launched_at="$(cat "$dir/launched-at" 2>/dev/null || echo 0)"
  [[ "$launched_at" =~ ^[0-9]+$ ]] || launched_at=0
  if (( now - launched_at >= READY_WATCHDOG_SWEEP_INTERVAL_SECONDS )) \
    && ! monitor_async_job_running "$READY_WATCHDOG_JOB_ID"; then
    printf '%s\n' "$now" > "$dir/launched-at"
    monitor_async_job_launch ready-watchdog "$READY_WATCHDOG_JOB_ID" "" "" "$watchdog_timeout" '{}' \
      ready_watchdog_job_run "$dir"
  fi
}

# ── Expanded reroute at the plan->code handoff ───────────────────────────────

EXPANDED_REROUTE_RESULT_MARKER=".expanded-reroute-result.json"
EXPANDED_REROUTE_JOB_BUCKET="route-task-job"

# Content hash of the task's expanded packet (the reroute input). Empty when
# the packet is absent (the inline path then reports not_eligible cheaply).
expanded_reroute_packet_hash() {
  local feature_dir="$1"
  local -a files=()
  if [[ -f "$feature_dir/task-packet.md" ]]; then
    files=("$feature_dir/task-packet.md")
  elif [[ -f "$feature_dir/task-packet-header.md" && -f "$feature_dir/task-packet-details.md" ]]; then
    files=("$feature_dir/task-packet-header.md" "$feature_dir/task-packet-details.md")
  else
    return 0
  fi
  cat "${files[@]}" | shasum -a 256 2>/dev/null | awk '{print $1}'
}

expanded_reroute_job_run() {
  local issue="$1" slug="$2" feature_dir="$3" packet_hash="$4" rc=0 detail
  reroute_expanded_packets_for_coding_handoff "$issue" "$slug" "$feature_dir" || rc=$?
  detail="$(jq -cn --argjson rc "$rc" --arg reason "${REROUTE_EXPANDED_LAST_REASON:-}" '{rc: $rc, reason: $reason}')"
  # Keyed on the packet content, not git head: a regenerated packet must be
  # rerouted. Only an operator event otherwise expires it.
  marker_write "$feature_dir/$EXPANDED_REROUTE_RESULT_MARKER" \
    --kind expanded-reroute \
    --head "$packet_hash" \
    --expires-on "operator-event" \
    --reason "expanded reroute rc=$rc" \
    --detail-json "$detail"
}

# expanded_reroute_gate <issue> <slug> <feature_dir>
# Returns 0 = reroute done, 1 = reroute failed (REROUTE_EXPANDED_LAST_REASON
# set, caller runs handle_expanded_reroute_handoff_failure), 4 = pending (the
# route-tasks job is running; caller holds the handoff and re-enters next pass).
expanded_reroute_gate() {
  local issue="$1" slug="$2" feature_dir="$3"
  local packet_hash marker detail rc job_id meta decision
  REROUTE_EXPANDED_LAST_REASON=""

  # router.enabled=false (ROUTER_ENABLED) must hold for the whole task, not
  # only the launch route: an expanded reroute would otherwise swap in a
  # routed planner/coder/reviewer the operator turned routing off to avoid.
  # "disabled" is already a skip reason for the handoff (keep current route).
  if [[ "${ROUTER_ENABLED:-true}" != "true" ]]; then
    REROUTE_EXPANDED_LAST_REASON="disabled"
    return 1
  fi

  packet_hash="$(expanded_reroute_packet_hash "$feature_dir")"
  if [[ -z "$packet_hash" ]]; then
    reroute_expanded_packets_for_coding_handoff "$issue" "$slug" "$feature_dir"
    return $?
  fi

  marker="$feature_dir/$EXPANDED_REROUTE_RESULT_MARKER"
  if ! marker_is_stale "$marker" "$packet_hash"; then
    detail="$(jq -c '.detail // {}' "$marker" 2>/dev/null || echo '{}')"
    rc="$(jq -r '.rc // 1' <<<"$detail")"
    REROUTE_EXPANDED_LAST_REASON="$(jq -r '.reason // ""' <<<"$detail")"
    monitor_async_job_stat route-task consumed
    [[ "$rc" == "0" ]] && return 0
    return 1
  fi

  job_id="route-task-$(sanitize_job_token "$issue")"
  monitor_async_job_stat route-task pending
  monitor_async_job_running "$job_id" && return 4

  decision="$(_async_check_retry_gate "$feature_dir" "$EXPANDED_REROUTE_JOB_BUCKET" "$packet_hash")"
  case "$decision" in
    exhausted|exhausted-quiet)
      [[ "$decision" == "exhausted" ]] && bounded_retry_mark_exhausted "$feature_dir" "$EXPANDED_REROUTE_JOB_BUCKET" \
        "Expanded reroute job failed ${ASYNC_CHECK_JOB_RETRY_LIMIT} time(s) for packet ${packet_hash:0:12}" || true
      REROUTE_EXPANDED_LAST_REASON="routing_error"
      return 1
      ;;
    backoff)
      return 4
      ;;
  esac

  meta="$(jq -cn --arg s "$feature_dir" --arg b "$EXPANDED_REROUTE_JOB_BUCKET" --arg k "$packet_hash" '{stateDir: $s, bucket: $b, key: $k}')"
  monitor_async_job_launch route-task "$job_id" "$issue" "" "$(( ${API_TIMEOUT:-30} + 30 ))" "$meta" \
    expanded_reroute_job_run "$issue" "$slug" "$feature_dir" "$packet_hash"
  return 4
}

# ── Task-input preparation before plan approval (HOK-3253) ──────────────────
#
# A raw issue whose planner wrote plan.md without expanding it needs the
# expansion recovery (expand-issue.ts + expanded reroute, minutes of LLM time)
# BEFORE the plan may be offered for approval. It used to run synchronously at
# the plan->code handoff, after the approval, which is what made HOK-3220 ask
# for approval twice. It now runs as a tracked job; the monitor holds planning
# at `running` until the packet lands.
#
# Budget: every launch is one attempt in the `expansion-recovery-job` bucket,
# keyed on the raw task input (selected-task.json). Counting at launch (not in
# the poll arm) bounds the loop even when a job dies without a tracker result.
# Exhaustion terminalizes with the recovery's recorded detail.

PREPARE_TASK_INPUTS_JOB_BUCKET="expansion-recovery-job"

# Content hash of the raw task input the expansion reads; "none" when absent.
task_inputs_raw_input_hash() {
  local feature_dir="$1" hash=""
  if [[ -f "$feature_dir/selected-task.json" ]]; then
    hash="$(jq -r '[(.title // ""), (.description // "")] | join("\n\n")' "$feature_dir/selected-task.json" 2>/dev/null \
      | shasum -a 256 2>/dev/null | awk '{print $1}')"
  fi
  printf '%s\n' "${hash:-none}"
}

prepare_task_inputs_job_run() {
  local issue="$1" slug="$2" feature_dir="$3"
  expansion_recovery_rearm "$feature_dir" || true
  recover_missing_expansion_artifact "$issue" "$slug" "$feature_dir"
}

# prepare_task_inputs_gate <issue> <slug> <feature_dir>
# Returns 1 = failed for good (PREPARE_TASK_INPUTS_LAST_DETAIL set), 4 = pending
# (job running or backing off; the caller holds planning).
prepare_task_inputs_gate() {
  local issue="$1" slug="$2" feature_dir="$3"
  local key job_id decision meta detail
  PREPARE_TASK_INPUTS_LAST_DETAIL=""


  job_id="prepare-task-inputs-$(sanitize_job_token "$issue")"
  monitor_async_job_stat prepare-task-inputs pending
  monitor_async_job_running "$job_id" && return 4

  key="$(task_inputs_raw_input_hash "$feature_dir")"
  decision="$(_async_check_retry_gate "$feature_dir" "$PREPARE_TASK_INPUTS_JOB_BUCKET" "$key")"
  case "$decision" in
    exhausted|exhausted-quiet)
      detail="$(expansion_recovery_detail "$feature_dir")"
      PREPARE_TASK_INPUTS_LAST_DETAIL="expansion recovery failed ${ASYNC_CHECK_JOB_RETRY_LIMIT} time(s) (last: ${detail:-no result recorded})"
      [[ "$decision" == "exhausted" ]] && bounded_retry_mark_exhausted "$feature_dir" "$PREPARE_TASK_INPUTS_JOB_BUCKET" \
        "Task-input preparation: $PREPARE_TASK_INPUTS_LAST_DETAIL for input ${key:0:12}" || true
      return 1
      ;;
    backoff)
      return 4
      ;;
  esac

  bounded_retry_increment "$feature_dir" "$PREPARE_TASK_INPUTS_JOB_BUCKET" "$key" >/dev/null
  # No bucket in meta: attempts are charged here, not by handle_check_job_failure.
  meta="$(jq -cn --arg s "$feature_dir" '{stateDir: $s}')"
  monitor_async_job_launch prepare-task-inputs "$job_id" "$issue" "" \
    "$(( $(get_expansion_handshake_timeout_seconds "$REPO_DIR") + ${API_TIMEOUT:-30} + 30 ))" "$meta" \
    prepare_task_inputs_job_run "$issue" "$slug" "$feature_dir"
  log "status" "$issue → preparing task inputs before plan approval (expansion recovery job, input ${key:0:12})"
  return 4
}

# ── Live launch routing (launch_task) ────────────────────────────────────────
#
# launch_task's live route-task.ts call (30-60 s on a cache miss) runs as a
# tracked job instead. The launch is deferred: dispatch_task_and_persist queues
# the selection, and drain_deferred_launches re-dispatches it once the route is
# ready. The job writes the same saved-route files the batch-route cache uses,
# with source "route-job", so launch_task consumes it on the existing cache-hit
# path. A failed job falls back to the inline live route exactly once.

LAUNCH_ROUTE_JOB_BUCKET="launch-route-job"
LAUNCH_TASK_DEFERRED_RC=75

# Fields are separated by US (0x1f), not tab: tab is IFS whitespace, so an
# empty override-base field would collapse on read.
DEFERRED_LAUNCH_SEP=$'\x1f'

deferred_launches_file() {
  printf '%s\n' "${STATE_DIR:-/tmp/${SESSION:-wavemill}}/deferred-launches.list"
}

launch_route_job_run() {
  local issue="$1" packet_file="$2" feature_dir="$3" packet_hash="$4" saved_route="$5" source_file="$6"
  local route_json rc=0 stderr_file stderr_output
  local -a cost_args=()
  [[ -n "${DEFAULT_MAX_COST_USD:-}" ]] && cost_args=(--max-cost "$DEFAULT_MAX_COST_USD")
  stderr_file=$(mktemp 2>/dev/null) || stderr_file=""
  if [[ -n "$stderr_file" ]]; then
    route_json=$(wavemill_run_tool "$TOOLS_DIR/route-task.ts" --json --file "$packet_file" --repo-dir "$REPO_DIR" \
      --feature-dir "$feature_dir" --source live --input-kind task-packet "${cost_args[@]}" 2>"$stderr_file") || rc=$?
    stderr_output=$(cat "$stderr_file" 2>/dev/null || echo "")
    rm -f "$stderr_file"
  else
    route_json=$(wavemill_run_tool "$TOOLS_DIR/route-task.ts" --json --file "$packet_file" --repo-dir "$REPO_DIR" \
      --feature-dir "$feature_dir" --source live --input-kind task-packet "${cost_args[@]}") || rc=$?
    stderr_output=""
  fi
  if (( rc != 0 )) || ! printf '%s' "$route_json" | jq -e '.planner and .coder and .reviewer' >/dev/null 2>&1; then
    if [[ -n "$stderr_output" ]]; then
      echo "route-task failed for $issue (exit $rc): $stderr_output"
    else
      echo "route-task failed for $issue (exit $rc)"
    fi
    return 1
  fi
  printf '%s\n' "$route_json" > "${saved_route}.tmp" && mv "${saved_route}.tmp" "$saved_route"
  printf 'route-job:%s\n' "$packet_hash" > "$source_file"
}

# Exit 0 when launch_task would run a live route-task.ts call: no challenge
# model, FORCE_MODEL or explicit agent, router on, and no batch-route cache hit.
launch_task_needs_live_route() {
  local issue="$1" challenge_model="${2:-}"
  local saved_route="/tmp/${SESSION}-${issue}-route.json"
  [[ -z "$challenge_model" && -z "${FORCE_MODEL:-}" ]] || return 1
  [[ "${AGENT_CMD_EXPLICIT:-}" != "true" && "${ROUTER_ENABLED:-true}" == "true" ]] || return 1
  [[ -f "${TOOLS_DIR:-}/route-task.ts" ]] || return 1
  if [[ "$(cat "/tmp/${SESSION}-${issue}-route-source.txt" 2>/dev/null)" == "batch-cache" ]] \
    && jq -e '.planner and .coder and .reviewer' "$saved_route" >/dev/null 2>&1; then
    return 1
  fi
  return 0
}

# launch_task_route_prefetch <issue> <packet_file> <feature_dir>
# Called by launch_task before any worktree / Linear side effect, only when a
# live route is needed and deferral is allowed. Returns 0 = route ready (or
# fall back to inline routing), LAUNCH_TASK_DEFERRED_RC = launch deferred.
launch_task_route_prefetch() {
  local issue="$1" packet_file="$2" feature_dir="$3"
  local saved_route="/tmp/${SESSION}-${issue}-route.json"
  local source_file="/tmp/${SESSION}-${issue}-route-source.txt"
  local packet_hash job_id job_dir decision meta

  [[ -s "$packet_file" ]] || return 0
  packet_hash="$(shasum -a 256 "$packet_file" 2>/dev/null | awk '{print $1}')"
  [[ -n "$packet_hash" ]] || return 0
  if [[ "$(cat "$source_file" 2>/dev/null)" == "route-job:$packet_hash" ]] \
    && jq -e '.planner and .coder and .reviewer' "$saved_route" >/dev/null 2>&1; then
    monitor_async_job_stat route-task consumed
    return 0
  fi

  job_id="launch-route-$(sanitize_job_token "$issue")"
  monitor_async_job_running "$job_id" && return "$LAUNCH_TASK_DEFERRED_RC"
  job_dir="$(monitor_async_job_dir "$job_id")"
  decision="$(bounded_retry_gate "$job_dir" "$LAUNCH_ROUTE_JOB_BUCKET" "$packet_hash" 1 15 120)"
  case "$decision" in
    exhausted|exhausted-quiet) return 0 ;;   # one async try spent: inline route
    backoff) return "$LAUNCH_TASK_DEFERRED_RC" ;;
  esac

  meta="$(jq -cn --arg s "$job_dir" --arg b "$LAUNCH_ROUTE_JOB_BUCKET" --arg k "$packet_hash" '{stateDir: $s, bucket: $b, key: $k}')"
  # A route saved for an older packet must never be consumed for this one.
  rm -f "$saved_route" "$source_file"
  monitor_async_job_stat route-task pending
  monitor_async_job_launch route-task "$job_id" "$issue" "" "$(( ${API_TIMEOUT:-30} * 2 ))" "$meta" \
    launch_route_job_run "$issue" "$packet_file" "$feature_dir" "$packet_hash" "$saved_route" "$source_file"
  return "$LAUNCH_TASK_DEFERRED_RC"
}

# ── Terminal cleanup decision (HOK-3312) ────────────────────────────────────
#
# The monitor's terminal-cleanup callers (cleanup_completed_task,
# cleanup_aborted_challenge_arm) delegate the reap / archive-and-reap /
# retain decision to shared/lib/terminal-inbox-cleanup.ts::decideTerminalTask.
# The TS tool runs as a tracked async job; the shell callers consume the
# condition-keyed result marker on a later pass.

CLEANUP_DECISION_RESULT_MARKER=".cleanup-decision.json"
CLEANUP_DECISION_JOB_BUCKET="cleanup-decision-job"

# cleanup_decision_job_run <state_dir> <issue> <head_sha> <marker_path> <role>
# Invokes `tools/decide-terminal-cleanup.ts` and writes a condition-keyed
# marker containing the TS decider's {action, decision} JSON.
cleanup_decision_job_run() {
  local state_dir="$1" issue="$2" head_sha="$3" marker="$4" role="${5:-primary}"
  local tmp_out output rc=0 detail
  tmp_out="$(mktemp 2>/dev/null)" || tmp_out=""
  if [[ -z "$tmp_out" ]]; then
    echo "cleanup-decision: could not create temp file for $issue"
    return 1
  fi
  local -a cmd=(decide-terminal-cleanup.ts --issue "$issue" --repo-dir "$REPO_DIR" --role "$role" --out "$tmp_out")
  [[ -n "${BASE_BRANCH:-}" ]] && cmd+=(--base-branch "$BASE_BRANCH")
  wavemill_run_tool "${cmd[@]}" >/dev/null 2>&1 || rc=$?
  if (( rc != 0 )); then
    rm -f "$tmp_out"
    echo "cleanup-decision: tool exited $rc for $issue"
    return 1
  fi
  output="$(cat "$tmp_out" 2>/dev/null || true)"
  rm -f "$tmp_out"
  if ! printf '%s' "$output" | jq -e '.action' >/dev/null 2>&1; then
    echo "cleanup-decision: unparseable output for $issue"
    return 1
  fi
  detail="$output"
  marker_write "$marker" \
    --kind cleanup-decision \
    --head "$head_sha" \
    --expires-on "head,operator-event,remote" \
    --reason "cleanup decision role=$role" \
    --detail-json "$detail"
}

# cleanup_decision_marker_action <marker>
# Prints the TS decider's `action` from the marker (reap|archive-and-reap|
# retain|kept|not-terminal) or an empty string.
cleanup_decision_marker_action() {
  local marker="$1"
  [[ -f "$marker" ]] || { printf '\n'; return 0; }
  jq -r '.detail.action // empty' "$marker" 2>/dev/null || printf '\n'
}

# cleanup_decision_launch_job <state_dir> <issue> <role> <feature_dir>
# Common fast-path block for the cleanup consumers: consume a non-stale
# marker's action, or (bounded-retry gated) launch the async decision job
# and return 4 to signal "pending".
#
# Prints the action on success (reap|archive-and-reap|retain|kept|not-terminal)
# and returns 0; prints empty and returns 4 while the decision is pending;
# prints empty and returns 1 when the budget is spent for this head.
cleanup_decision_launch_job() {
  local state_dir="$1" issue="$2" role="${3:-primary}" feature_dir="${4:-}" wt_dir="${5:-}"
  local marker head_sha job_id decision meta action
  marker="$state_dir/$CLEANUP_DECISION_RESULT_MARKER"
  # Head is the task worktree's HEAD; falls back to the repo head when the
  # worktree is already gone. An empty head still condition-keys the marker
  # for the operator-event / remote reconcilers.
  head_sha=""
  if [[ -n "$wt_dir" && -d "$wt_dir" ]]; then
    head_sha="$(git -C "$wt_dir" rev-parse HEAD 2>/dev/null || true)"
  fi
  [[ -n "$head_sha" ]] || head_sha="$(git -C "$REPO_DIR" rev-parse HEAD 2>/dev/null || true)"
  [[ -n "$head_sha" ]] || head_sha="no-head"

  if ! marker_is_stale "$marker" "$head_sha"; then
    action="$(cleanup_decision_marker_action "$marker")"
    if [[ -n "$action" ]]; then
      monitor_async_job_stat cleanup-decision consumed
      printf '%s\n' "$action"
      return 0
    fi
  fi

  job_id="cleanup-decision-$(sanitize_job_token "$issue")"
  monitor_async_job_stat cleanup-decision pending
  monitor_async_job_running "$job_id" && { printf '\n'; return 4; }

  decision="$(_async_check_retry_gate "$state_dir" "$CLEANUP_DECISION_JOB_BUCKET" "$head_sha")"
  case "$decision" in
    exhausted|exhausted-quiet)
      if [[ "$decision" == "exhausted" ]]; then
        bounded_retry_mark_exhausted "$state_dir" "$CLEANUP_DECISION_JOB_BUCKET" \
          "Cleanup-decision job failed ${ASYNC_CHECK_JOB_RETRY_LIMIT} time(s) at ${head_sha:0:12}" || true
      fi
      printf '\n'
      return 1
      ;;
    backoff)
      printf '\n'
      return 4
      ;;
  esac

  meta="$(jq -cn --arg s "$state_dir" --arg b "$CLEANUP_DECISION_JOB_BUCKET" --arg k "$head_sha" '{stateDir: $s, bucket: $b, key: $k}')"
  monitor_async_job_launch cleanup-decision "$job_id" "$issue" "" 120 "$meta" \
    cleanup_decision_job_run "$state_dir" "$issue" "$head_sha" "$marker" "$role"
  printf '\n'
  return 4
}

# Queue a deferred launch (idempotent per issue).
enqueue_deferred_launch() {
  local issue="$1" slug="$2" title="$3" remaining="${4:-1}" override_base="${5:-}" file
  file="$(deferred_launches_file)"
  grep -q "^${issue}${DEFERRED_LAUNCH_SEP}" "$file" 2>/dev/null && return 0
  printf '%s\n' "${issue}${DEFERRED_LAUNCH_SEP}${slug}${DEFERRED_LAUNCH_SEP}${title}${DEFERRED_LAUNCH_SEP}${remaining}${DEFERRED_LAUNCH_SEP}${override_base}${DEFERRED_LAUNCH_SEP}$(date +%s)" >> "$file"
}

deferred_launch_count() {
  local file
  file="$(deferred_launches_file)"
  [[ -s "$file" ]] || { echo 0; return 0; }
  grep -c . "$file" 2>/dev/null || echo 0
}

# Re-dispatch queued launches whose route job is no longer running. Each
# re-dispatch either consumes the job's route, falls back to inline routing
# (job failed), or re-queues while a backoff holds. DEFERRED_LAUNCHES_DISPATCHED
# counts this pass's re-dispatches so the caller can hold their slots until
# the launched tasks appear in active_count on the next pass.
drain_deferred_launches() {
  local file tmp issue slug title remaining override_base queued_at
  DEFERRED_LAUNCHES_DISPATCHED=0
  file="$(deferred_launches_file)"
  [[ -s "$file" ]] || return 0
  tmp="$(mktemp "${file}.XXXXXX" 2>/dev/null)" || return 0
  mv "$file" "$tmp"
  while IFS="$DEFERRED_LAUNCH_SEP" read -r issue slug title remaining override_base queued_at; do
    [[ -n "$issue" ]] || continue
    if monitor_async_job_running "launch-route-$(sanitize_job_token "$issue")"; then
      printf '%s\n' "${issue}${DEFERRED_LAUNCH_SEP}${slug}${DEFERRED_LAUNCH_SEP}${title}${DEFERRED_LAUNCH_SEP}${remaining}${DEFERRED_LAUNCH_SEP}${override_base}${DEFERRED_LAUNCH_SEP}${queued_at}" >> "$file"
      continue
    fi
    dispatch_task_and_persist "$issue" "$slug" "$title" "$remaining" "$override_base"
    DEFERRED_LAUNCHES_DISPATCHED=$((DEFERRED_LAUNCHES_DISPATCHED + 1))
  done < "$tmp"
  rm -f "$tmp"
}
