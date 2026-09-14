#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MILL_SCRIPT="$REPO_DIR/shared/lib/wavemill-mill.sh"
MONITOR_SCRIPT_FILE="$REPO_DIR/shared/lib/wavemill-monitor.sh"
COMMON_SCRIPT="$REPO_DIR/shared/lib/wavemill-common.sh"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

check_eq() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    pass "$name"
  else
    echo "    expected: $expected"
    echo "    actual:   $actual"
    fail "$name"
  fi
}

check_contains() {
  local name="$1" haystack="$2" needle="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    pass "$name"
  else
    echo "    missing: $needle"
    fail "$name"
  fi
}

check_not_contains() {
  local name="$1" haystack="$2" needle="$3"
  if [[ "$haystack" != *"$needle"* ]]; then
    pass "$name"
  else
    echo "    unexpected: $needle"
    fail "$name"
  fi
}

extract_monitor_heredoc() {
  cat "$MONITOR_SCRIPT_FILE"
}

extract_function() {
  local source_file="$1"
  local function_name="$2"
  awk -v name="$function_name" '
    function brace_delta(line, stripped, opens, closes) {
      stripped = line
      gsub(/"([^"\\]|\\.)*"/, "\"\"", stripped)
      gsub(/\047([^\047\\]|\\.)*\047/, "\047\047", stripped)
      opens = gsub(/\{/, "{", stripped)
      closes = gsub(/\}/, "}", stripped)
      return opens - closes
    }
    $0 ~ "^" name "\\(\\)[[:space:]]*\\{" {
      capture = 1
      depth = 0
    }
    capture {
      print
      depth += brace_delta($0)
      if (depth == 0) {
        exit
      }
    }
  ' "$source_file"
}

TEST_TMP="$(mktemp -d)"
trap 'rm -rf "$TEST_TMP"' EXIT

MONITOR_BODY="$TEST_TMP/monitor-body.sh"
extract_monitor_heredoc > "$MONITOR_BODY"

FUNCTIONS_FILE="$TEST_TMP/task-selection-renderer-funcs.sh"
{
  # refresh_backlog_cache calls filter_parent_issues, which the real monitor
  # gets by sourcing wavemill-common.sh. Extract it so the isolated harness
  # exercises the real implementation rather than a stub.
  extract_function "$COMMON_SCRIPT" "filter_parent_issues"
  echo
  extract_function "$MONITOR_BODY" "refresh_backlog_cache"
  echo
  extract_function "$MONITOR_BODY" "print_cached_candidates"
  echo
  extract_function "$MONITOR_BODY" "fetch_candidates"
  echo
  extract_function "$MONITOR_BODY" "record_fetch_queue_plan_failure"
  echo
  extract_function "$MONITOR_BODY" "log_fetch_queue_plan_failure"
  echo
  extract_function "$MONITOR_BODY" "classify_queue_failure_reason"
  echo
  extract_function "$MONITOR_BODY" "get_queue_failure_reason"
  echo
  extract_function "$MONITOR_BODY" "run_queue_planner_with_policy"
  echo
  extract_function "$MONITOR_BODY" "build_queue_plan_once"
  echo
  extract_function "$MONITOR_BODY" "invoke_first_wave_helper"
  echo
  extract_function "$MONITOR_BODY" "fetch_queue_plan"
  echo
  extract_function "$MONITOR_BODY" "render_grouped_task_list"
} > "$FUNCTIONS_FILE"

if [[ ! -s "$FUNCTIONS_FILE" ]]; then
  echo "Could not extract task selection renderer helpers"
  exit 1
fi

CANDIDATES=$'HOK-10|foundation-task|Foundation task|core|98|0\nHOK-11|depends-on-foundation|Depends on foundation|core|95|1\nHOK-12|also-depends-on-foundation|Also depends on foundation|core|92|1\nHOK-13|shares-surface-with-hok-11|Shares surface with HOK-11|ux|90|0\nHOK-14|broken-dependency|Broken dependency|core|80|1'

LINEAR_BACKLOG_JSON=$(cat <<'EOF'
[
  { "identifier": "HOK-10", "title": "Foundation task", "inverseRelations": { "nodes": [] } },
  { "identifier": "HOK-11", "title": "Depends on foundation", "inverseRelations": { "nodes": [{ "type": "blocks", "issue": { "identifier": "HOK-10" } }] } },
  { "identifier": "HOK-12", "title": "Also depends on foundation", "inverseRelations": { "nodes": [{ "type": "blocks", "issue": { "identifier": "HOK-10" } }] } },
  { "identifier": "HOK-13", "title": "Shares surface with HOK-11", "sharedSurface": ["HOK-11"], "inverseRelations": { "nodes": [] } },
  { "identifier": "HOK-14", "title": "Broken dependency", "inverseRelations": { "nodes": [{ "type": "blocks", "issue": { "identifier": "HOK-99" } }] } }
]
EOF
)

render_prompt_under_test() {
  local available="$1" avail_unblocked avail_blocked avail_blocked_count queue_plan_json queue_plan_diag_file queue_plan_diag_previous
  avail_unblocked=$(echo "$available" | awk -F'|' '$6 == 0 || $6 == ""')
  avail_blocked=$(echo "$available" | awk -F'|' '$6 > 0')
  avail_blocked_count=0
  [[ -n "$avail_blocked" ]] && avail_blocked_count=$(echo "$avail_blocked" | grep -c .)

  echo "Next tasks:"
  queue_plan_json=""
  queue_plan_diag_file=""
  queue_plan_diag_previous="${FETCH_QUEUE_PLAN_DIAGNOSTICS_FILE:-}"
  queue_plan_diag_file="$(mktemp -t wavemill-fqp-diagnostics.XXXXXX 2>/dev/null || true)"
  FETCH_QUEUE_PLAN_DIAGNOSTICS_FILE="$queue_plan_diag_file"
  GROUPED_DISPLAY=""
  GROUPED_SELECT_FROM=""
  if queue_plan_json=$(fetch_queue_plan 2>/dev/null); then
    render_grouped_task_list "$queue_plan_json" "$available" || true
    if [[ -n "$GROUPED_DISPLAY" ]]; then
      echo "$GROUPED_DISPLAY"
      select_from="$GROUPED_SELECT_FROM"
      USING_GROUPED_VIEW=true
    fi
  fi
  if [[ -z "$GROUPED_DISPLAY" ]]; then
    USING_GROUPED_VIEW=false
    if [[ -z "$queue_plan_json" ]]; then
      local _queue_reason
      _queue_reason="$(get_queue_failure_reason "${queue_plan_diag_file:-}")"
      log_warn "queue analysis unavailable (reason: ${_queue_reason:-unknown}), falling back to flat list"
      [[ -n "$queue_plan_diag_file" ]] && log_fetch_queue_plan_failure "$queue_plan_diag_file"
    fi
    if [[ -n "$avail_unblocked" ]]; then
      echo "$avail_unblocked" | head -9 | awk -F'|' '{printf "  %s. %s - %s (score: %.0f)\n", NR, $1, $3, $5}'
    else
      echo "  (no unblocked tasks)"
    fi
    if (( avail_blocked_count > 0 )); then
      echo ""
      echo "  ($avail_blocked_count blocked task(s) hidden - enter 'm' to show all)"
    fi
  fi
  rm -f "$queue_plan_diag_file"
  FETCH_QUEUE_PLAN_DIAGNOSTICS_FILE="$queue_plan_diag_previous"
}

RENDER_PROMPT_FILE="$TEST_TMP/render-prompt-under-test.sh"
declare -f render_prompt_under_test > "$RENDER_PROMPT_FILE"

test_fetch_queue_plan_transforms_linear_backlog() {
  local output
  output=$(FUNCTIONS_FILE="$FUNCTIONS_FILE" REPO_DIR="$REPO_DIR" LINEAR_BACKLOG_JSON="$LINEAR_BACKLOG_JSON" bash -lc '
    set -euo pipefail
    # shellcheck source=/dev/null
    source "$FUNCTIONS_FILE"
    BACKLOG_CACHE_TTL=60
    BACKLOG_JSON_CACHE="$LINEAR_BACKLOG_JSON"
    QUEUE_PLAN_CACHE=""
    LAST_QUEUE_PLAN_FETCH=0
    TOOLS_DIR="$REPO_DIR/tools"
    _with_timeout() {
      shift
      "$@"
    }

    fetch_queue_plan
  ')

  check_contains "fetch_queue_plan emits availableNow" "$output" '"availableNow"'
  check_contains "fetch_queue_plan maps ready tasks" "$output" '"HOK-10"'
  check_contains "fetch_queue_plan maps dependency queue" "$output" '"taskId": "HOK-11"'
  check_contains "fetch_queue_plan preserves shared-surface clusters" "$output" '"avoidRunningTogether"'
  check_contains "fetch_queue_plan preserves shared-surface ids" "$output" '"HOK-13"'
  check_contains "fetch_queue_plan keeps externally blocked task queued" "$output" '"taskId": "HOK-14"'
}

test_backlog_refresh_persists_cache_in_parent_shell() {
  local output
  output=$(FUNCTIONS_FILE="$FUNCTIONS_FILE" REPO_DIR="$REPO_DIR" LINEAR_BACKLOG_JSON="$LINEAR_BACKLOG_JSON" bash -lc '
    set -euo pipefail
    # shellcheck source=/dev/null
    source "$FUNCTIONS_FILE"
    BACKLOG_CACHE_TTL=60
    BACKLOG_CACHE=""
    BACKLOG_JSON_CACHE=""
    QUEUE_PLAN_CACHE="stale-plan"
    LAST_BACKLOG_FETCH=0
    LAST_QUEUE_PLAN_FETCH=42
    PROJECT_NAME="hok"
    TOOLS_DIR="$REPO_DIR/tools"
    score_and_rank_issues() {
      cat <<'"'"'EOF'"'"'
HOK-10|foundation-task|Foundation task|core|98|false|0
HOK-11|depends-on-foundation|Depends on foundation|core|95|false|1
EOF
    }
    _with_timeout() {
      shift
      if [[ "${1-}" == "npx" && "${2-}" == "tsx" && "${3-}" == *"list-backlog-json.ts" ]]; then
        printf "%s\n" "$LINEAR_BACKLOG_JSON"
      else
        "$@"
      fi
    }

    candidates_subshell="$(fetch_candidates)"
    if [[ -n "${BACKLOG_JSON_CACHE:-}" ]]; then
      echo "legacy_cache=present"
    else
      echo "legacy_cache=missing"
    fi

    refresh_backlog_cache
    candidates_parent="$(print_cached_candidates)"
    queue_plan_json="$(fetch_queue_plan)"

    [[ -n "$BACKLOG_JSON_CACHE" ]] && echo "parent_cache=present"
    [[ -z "$QUEUE_PLAN_CACHE" ]] || echo "queue_cache_rebuilt=yes"
    [[ -n "$candidates_subshell" ]] && echo "legacy_candidates=present"
    [[ -n "$candidates_parent" ]] && echo "parent_candidates=present"
    [[ -n "$queue_plan_json" ]] && echo "queue_plan=present"
    [[ "$queue_plan_json" == *'"'"'"availableNow"'"'"'* ]] && echo "queue_plan_shape=ok"
  ')

  check_contains "legacy command substitution keeps candidate output" "$output" "legacy_candidates=present"
  check_contains "legacy command substitution does not persist cache" "$output" "legacy_cache=missing"
  check_contains "parent refresh persists backlog cache" "$output" "parent_cache=present"
  check_contains "parent cached candidates available" "$output" "parent_candidates=present"
  check_contains "queue plan builds after parent refresh" "$output" "queue_plan=present"
  check_contains "queue plan has expected shape" "$output" "queue_plan_shape=ok"
}

test_filter_keeps_issue_with_no_children() {
  local backlog output ids
  backlog='[
    { "identifier": "HOK-leaf", "title": "Leaf", "children": { "nodes": [] } }
  ]'

  output=$(FUNCTIONS_FILE="$FUNCTIONS_FILE" BACKLOG_JSON="$backlog" bash -lc '
    set -euo pipefail
    # shellcheck source=/dev/null
    source "$FUNCTIONS_FILE"
    filter_parent_issues "$BACKLOG_JSON"
  ')
  ids="$(jq -r '.[].identifier' <<<"$output")"

  check_eq "filter keeps issue with no children" "HOK-leaf" "$ids"
}

test_filter_drops_issue_with_active_children() {
  local backlog output stderr_text stderr_file
  stderr_file="$TEST_TMP/filter-active.err"
  backlog='[
    {
      "identifier": "HOK-active-parent",
      "children": {
        "nodes": [
          { "id": "child-active", "identifier": "HOK-active-child", "state": { "type": "started" } }
        ]
      }
    }
  ]'

  output=$(FUNCTIONS_FILE="$FUNCTIONS_FILE" BACKLOG_JSON="$backlog" bash -lc '
    set -euo pipefail
    # shellcheck source=/dev/null
    source "$FUNCTIONS_FILE"
    filter_parent_issues "$BACKLOG_JSON"
  ' 2>"$stderr_file")
  stderr_text="$(cat "$stderr_file")"

  check_eq "filter drops issue with active children" "0" "$(jq 'length' <<<"$output")"
  check_contains "filter active child warns" "$stderr_text" "WARN: Skipping parent issue HOK-active-parent"
}

test_filter_keeps_parent_with_all_terminal_children() {
  local backlog output stderr_text stderr_file
  stderr_file="$TEST_TMP/filter-terminal.err"
  backlog='[
    {
      "identifier": "HOK-2917",
      "state": { "name": "Backlog" },
      "children": {
        "nodes": [
          { "id": "child-done", "identifier": "HOK-2895", "state": { "name": "Done", "type": "completed" } }
        ]
      }
    }
  ]'

  output=$(FUNCTIONS_FILE="$FUNCTIONS_FILE" BACKLOG_JSON="$backlog" bash -lc '
    set -euo pipefail
    # shellcheck source=/dev/null
    source "$FUNCTIONS_FILE"
    filter_parent_issues "$BACKLOG_JSON"
  ' 2>"$stderr_file")
  stderr_text="$(cat "$stderr_file")"

  check_eq "filter keeps all-terminal parent" "HOK-2917" "$(jq -r '.[0].identifier' <<<"$output")"
  check_contains "filter all-terminal info" "$stderr_text" "INFO: Keeping parent issue HOK-2917 (all 1 children terminal: HOK-2895)"
}

test_filter_uses_completed_at_fallback() {
  local backlog output
  backlog='[
    {
      "identifier": "HOK-terminal-fallback",
      "children": {
        "nodes": [
          { "id": "child-done", "identifier": "HOK-done-child", "completedAt": "2026-09-13T12:00:00.000Z" }
        ]
      }
    }
  ]'

  output=$(FUNCTIONS_FILE="$FUNCTIONS_FILE" BACKLOG_JSON="$backlog" bash -lc '
    set -euo pipefail
    # shellcheck source=/dev/null
    source "$FUNCTIONS_FILE"
    filter_parent_issues "$BACKLOG_JSON"
  ' 2>/dev/null)

  check_eq "filter uses completedAt fallback" "HOK-terminal-fallback" "$(jq -r '.[0].identifier' <<<"$output")"
}

test_filter_treats_unknown_state_as_nonterminal() {
  local backlog output stderr_text stderr_file
  stderr_file="$TEST_TMP/filter-unknown.err"
  backlog='[
    {
      "identifier": "HOK-unknown-parent",
      "children": {
        "nodes": [
          { "id": "child-unknown", "identifier": "HOK-unknown-child" }
        ]
      }
    }
  ]'

  output=$(FUNCTIONS_FILE="$FUNCTIONS_FILE" BACKLOG_JSON="$backlog" bash -lc '
    set -euo pipefail
    # shellcheck source=/dev/null
    source "$FUNCTIONS_FILE"
    filter_parent_issues "$BACKLOG_JSON"
  ' 2>"$stderr_file")
  stderr_text="$(cat "$stderr_file")"

  check_eq "filter treats unknown child state as nonterminal" "0" "$(jq 'length' <<<"$output")"
  check_contains "filter unknown state warns" "$stderr_text" "WARN: Skipping parent issue HOK-unknown-parent"
}

test_filter_dedupes_all_terminal_info() {
  local backlog stderr_text stderr_file info_count
  stderr_file="$TEST_TMP/filter-dedupe.err"
  backlog='[
    {
      "identifier": "HOK-2917",
      "children": {
        "nodes": [
          { "id": "child-done", "identifier": "HOK-2895", "state": { "type": "completed" } }
        ]
      }
    }
  ]'

  FUNCTIONS_FILE="$FUNCTIONS_FILE" BACKLOG_JSON="$backlog" bash -lc '
    set -euo pipefail
    # shellcheck source=/dev/null
    source "$FUNCTIONS_FILE"
    filter_parent_issues "$BACKLOG_JSON" >/dev/null
    filter_parent_issues "$BACKLOG_JSON" >/dev/null
  ' 2>"$stderr_file"
  stderr_text="$(cat "$stderr_file")"
  info_count="$(grep -c "INFO: Keeping parent issue HOK-2917" "$stderr_file" || true)"

  check_eq "filter dedupes all-terminal info" "1" "$info_count"
  check_contains "filter dedupe still announces once" "$stderr_text" "all 1 children terminal"
}

test_invoke_first_wave_helper_packs_priority_without_violating_dependencies() {
  local wave_result
  wave_result=$(FUNCTIONS_FILE="$FUNCTIONS_FILE" REPO_DIR="$REPO_DIR" LINEAR_BACKLOG_JSON="$LINEAR_BACKLOG_JSON" CANDIDATES="$CANDIDATES" bash -lc '
    set -euo pipefail
    # shellcheck source=/dev/null
    source "$FUNCTIONS_FILE"
    BACKLOG_CACHE_TTL=60
    BACKLOG_JSON_CACHE="$LINEAR_BACKLOG_JSON"
    QUEUE_PLAN_CACHE=""
    LAST_QUEUE_PLAN_FETCH=0
    TOOLS_DIR="$REPO_DIR/tools"
    MAX_PARALLEL=3
    _with_timeout() {
      shift
      "$@"
    }

    queue_plan=$(build_queue_plan_once "$LINEAR_BACKLOG_JSON")
    invoke_first_wave_helper "$queue_plan" "$CANDIDATES" 3
  ')

  check_contains "wave helper selects highest-priority ready task" "$wave_result" '"HOK-10"'
  check_contains "wave helper keeps ready shared-surface task in wave" "$wave_result" '"HOK-13"'
  check_not_contains "wave helper does not pull blocked dependency into wave" "$wave_result" '"HOK-11"'
  check_contains "wave helper defers blocked work even if highly scored" "$wave_result" '"deferred"'
}

test_grouped_render_with_fixture_output() {
  local queue_plan output line3 line5 line7
  queue_plan=$(cd "$REPO_DIR" && npx tsx tools/plan-queue.ts --backlog-file fixtures/plan-queue/backlog-basic.json --json)
  output=$(FUNCTIONS_FILE="$FUNCTIONS_FILE" CANDIDATES="$CANDIDATES" QUEUE_PLAN="$queue_plan" bash -lc '
    set -euo pipefail
    # shellcheck source=/dev/null
    source "$FUNCTIONS_FILE"
    GROUPED_DISPLAY=""
    GROUPED_SELECT_FROM=""
    render_grouped_task_list "$QUEUE_PLAN" "$CANDIDATES"
    echo "$GROUPED_DISPLAY"
    echo
    echo "---SELECT---"
    printf "%s\n" "$GROUPED_SELECT_FROM"
  ')

  check_contains "render prints available section" "$output" "Available Now - Parallel Wave 1"
  check_contains "render prints queued section" "$output" "Queued After Dependencies"
  check_not_contains "render skips avoid section after de-dup precedence" "$output" "Avoid Running Together"
  check_not_contains "render hides external blockers from triage section" "$output" "Needs Triage"
  check_contains "render annotates blockers" "$output" "3. HOK-11 - Depends on foundation (blocked by: HOK-10)"
  check_not_contains "render omits conflict cluster after de-dup precedence" "$output" "[conflict cluster 1]"
  check_not_contains "render hides off-deck external blocker from queued section" "$output" "HOK-14 - Broken dependency (blocked by: HOK-99)"

  line3=$(awk '/---SELECT---/{flag=1; next} flag {print; exit}' <<<"$output")
  line5=$(awk '/---SELECT---/{flag=1; next} flag {count++; if (count == 3) { print; exit }}' <<<"$output")
  line7=$(awk '/---SELECT---/{flag=1; next} flag {count++; if (count == 5) { print; exit }}' <<<"$output")
  check_eq "selection line 1 matches first rendered task" "HOK-10|foundation-task|Foundation task|core|98|0" "$line3"
  check_eq "selection line 3 matches queued task order" "HOK-11|depends-on-foundation|Depends on foundation|core|95|1" "$line5"
  check_eq "selection line 5 omits off-deck external dependency task" "" "$line7"
}

test_grouped_render_orders_available_by_score() {
  local output scored_candidates queue_plan
  scored_candidates=$'HOK-1|low-score|Low score|core|20|0\nHOK-2|focus-score|Focus score|core|130|0\nHOK-3|medium-score|Medium score|core|90|0'
  queue_plan='{"availableNow":["HOK-1","HOK-2","HOK-3"],"queuedAfterDependencies":[],"avoidRunningTogether":[],"needsTriage":[]}'

  output=$(FUNCTIONS_FILE="$FUNCTIONS_FILE" CANDIDATES="$scored_candidates" QUEUE_PLAN="$queue_plan" bash -lc '
    set -euo pipefail
    # shellcheck source=/dev/null
    source "$FUNCTIONS_FILE"
    GROUPED_DISPLAY=""
    GROUPED_SELECT_FROM=""
    render_grouped_task_list "$QUEUE_PLAN" "$CANDIDATES"
    echo "$GROUPED_DISPLAY"
    echo
    echo "---SELECT---"
    printf "%s\n" "$GROUPED_SELECT_FROM"
  ')

  check_contains "render promotes highest scored available task" "$output" "1. HOK-2 - Focus score"
  check_contains "render keeps second scored available task next" "$output" "2. HOK-3 - Medium score"
  check_contains "render demotes low scored available task" "$output" "3. HOK-1 - Low score"
}

test_scoring_boosts_focus_and_near_milestones() {
  local output first second
  output=$(REPO_DIR="$REPO_DIR" bash -lc '
    set -euo pipefail
    # shellcheck source=/dev/null
    source "$REPO_DIR/shared/lib/wavemill-common.sh"
    WAVEMILL_BACKLOG_SCORE_TODAY=2026-05-13
    backlog_json=$(cat <<'"'"'EOF'"'"'
[
  {
    "identifier": "HOK-200",
    "title": "Later launch urgent task",
    "description": "",
    "state": { "name": "Backlog" },
    "labels": { "nodes": [] },
    "priority": 1,
    "estimate": null,
    "projectMilestone": { "name": "Phase 7: Mainnet deploy", "targetDate": "2026-05-29" },
    "relations": { "nodes": [] },
    "inverseRelations": { "nodes": [] }
  },
  {
    "identifier": "HOK-201",
    "title": "Focused milestone task",
    "description": "",
    "state": { "name": "Backlog" },
    "labels": { "nodes": [] },
    "priority": 2,
    "estimate": null,
    "projectMilestone": { "name": "Three Contracts Tested", "targetDate": "2026-05-19" },
    "relations": { "nodes": [] },
    "inverseRelations": { "nodes": [] }
  }
]
EOF
)
    score_and_rank_issues "$backlog_json" 2 "[\"Three Contracts Tested\"]"
  ')

  first="$(sed -n '1p' <<<"$output" | cut -d'|' -f1)"
  second="$(sed -n '2p' <<<"$output" | cut -d'|' -f1)"
  check_eq "focus milestone outranks later urgent task" "HOK-201" "$first"
  check_eq "later milestone remains visible after focus task" "HOK-200" "$second"
}

test_grouped_render_deduplicates_and_keeps_one_item_per_line() {
  local output
  output=$(FUNCTIONS_FILE="$FUNCTIONS_FILE" CANDIDATES="$CANDIDATES" QUEUE_PLAN='{"availableNow":["HOK-10"],"queuedAfterDependencies":[{"taskId":"HOK-11","ancestors":["HOK-10"]}],"avoidRunningTogether":[["HOK-13"]],"needsTriage":[{"reason":"duplicate","edge":{"type":"depends_on","from":"HOK-10","to":"HOK-11","source":"explicit"}},{"reason":"unknown_endpoint","edge":{"type":"depends_on","from":"HOK-99","to":"HOK-14","source":"explicit"}}]}' bash -lc '
    set -euo pipefail
    # shellcheck source=/dev/null
    source "$FUNCTIONS_FILE"
    GROUPED_DISPLAY=""
    GROUPED_SELECT_FROM=""
    render_grouped_task_list "$QUEUE_PLAN" "$CANDIDATES"
    echo "$GROUPED_DISPLAY"
  ')

  check_eq "render shows HOK-11 once across sections" "1" "$(grep -c 'HOK-11 - Depends on foundation' <<<"$output" || true)"
  check_eq "triage item rendered on its own line" "1" "$(grep -c '^[[:space:]]*[0-9]\+\. HOK-14 - Broken dependency \[triage\]$' <<<"$output" || true)"
  check_not_contains "no collapsed triage formatting line" "$output" "[triage]  "
}

test_render_rejects_malformed_json() {
  if FUNCTIONS_FILE="$FUNCTIONS_FILE" CANDIDATES="$CANDIDATES" bash -lc '
    set -euo pipefail
    # shellcheck source=/dev/null
    source "$FUNCTIONS_FILE"
    render_grouped_task_list "{not-json}" "$CANDIDATES" >/dev/null
  '; then
    fail "malformed queue plan returns failure"
  else
    pass "malformed queue plan returns failure"
  fi
}

test_fallback_when_queue_analysis_fails() {
  local stdout stderr
  stdout="$TEST_TMP/fallback.out"
  stderr="$TEST_TMP/fallback.err"
  FUNCTIONS_FILE="$FUNCTIONS_FILE" CANDIDATES="$CANDIDATES" bash -lc '
    set -euo pipefail
    # shellcheck source=/dev/null
    source "$FUNCTIONS_FILE"
    render_prompt_under_test() {
      local available="$1" avail_unblocked avail_blocked avail_blocked_count queue_plan_json
      avail_unblocked=$(echo "$available" | awk -F'"'"'|'"'"' '"'"'$6 == 0 || $6 == ""'"'"')
      avail_blocked=$(echo "$available" | awk -F'"'"'|'"'"' '"'"'$6 > 0'"'"')
      avail_blocked_count=0
      [[ -n "$avail_blocked" ]] && avail_blocked_count=$(echo "$avail_blocked" | grep -c .)

      echo "Next tasks:"
      queue_plan_json=""
      GROUPED_DISPLAY=""
      GROUPED_SELECT_FROM=""
      if queue_plan_json=$(fetch_queue_plan 2>/dev/null); then
        render_grouped_task_list "$queue_plan_json" "$available" || true
        if [[ -n "$GROUPED_DISPLAY" ]]; then
          echo "$GROUPED_DISPLAY"
          select_from="$GROUPED_SELECT_FROM"
          USING_GROUPED_VIEW=true
        fi
      fi
      if [[ -z "$GROUPED_DISPLAY" ]]; then
        USING_GROUPED_VIEW=false
        [[ -n "$queue_plan_json" ]] || log_warn "queue analysis unavailable, falling back to flat list"
        if [[ -n "$avail_unblocked" ]]; then
          echo "$avail_unblocked" | head -9 | awk -F'"'"'|'"'"' '"'"'{printf "  %s. %s - %s (score: %.0f)\n", NR, $1, $3, $5}'"'"'
        else
          echo "  (no unblocked tasks)"
        fi
        if (( avail_blocked_count > 0 )); then
          echo ""
          echo "  ($avail_blocked_count blocked task(s) hidden - enter '\''m'\'' to show all)"
        fi
      fi
    }
    log_warn() { printf "%s\n" "$*" >&2; }
    fetch_queue_plan() { return 1; }
    USING_GROUPED_VIEW=false
    SELECT_SHOW_ALL=false
    GROUPED_SELECT_FROM=""
    GROUPED_DISPLAY=""
    render_prompt_under_test "$CANDIDATES"
  ' >"$stdout" 2>"$stderr"

  stdout=$(cat "$stdout")
  stderr=$(cat "$stderr")
  check_contains "fallback prints flat list" "$stdout" "1. HOK-10 - Foundation task (score: 98)"
  check_contains "fallback preserves more hint" "$stdout" "(3 blocked task(s) hidden - enter 'm' to show all)"
  check_not_contains "fallback omits grouped header" "$stdout" "Available Now - Parallel Wave 1"
  check_contains "fallback warns once" "$stderr" "queue analysis unavailable, falling back to flat list"
}

test_fallback_when_grouped_plan_has_no_renderable_tasks() {
  local stdout stderr
  stdout="$TEST_TMP/no-renderable.out"
  stderr="$TEST_TMP/no-renderable.err"
  FUNCTIONS_FILE="$FUNCTIONS_FILE" CANDIDATES="$CANDIDATES" bash -lc '
    set -euo pipefail
    # shellcheck source=/dev/null
    source "$FUNCTIONS_FILE"
    render_prompt_under_test() {
      local available="$1" avail_unblocked avail_blocked avail_blocked_count queue_plan_json
      avail_unblocked=$(echo "$available" | awk -F'"'"'|'"'"' '"'"'$6 == 0 || $6 == ""'"'"')
      avail_blocked=$(echo "$available" | awk -F'"'"'|'"'"' '"'"'$6 > 0'"'"')
      avail_blocked_count=0
      [[ -n "$avail_blocked" ]] && avail_blocked_count=$(echo "$avail_blocked" | grep -c .)

      echo "Next tasks:"
      queue_plan_json=""
      GROUPED_DISPLAY=""
      GROUPED_SELECT_FROM=""
      if queue_plan_json=$(fetch_queue_plan 2>/dev/null); then
        render_grouped_task_list "$queue_plan_json" "$available" || true
        if [[ -n "$GROUPED_DISPLAY" ]]; then
          echo "$GROUPED_DISPLAY"
          select_from="$GROUPED_SELECT_FROM"
          USING_GROUPED_VIEW=true
        fi
      fi
      if [[ -z "$GROUPED_DISPLAY" ]]; then
        USING_GROUPED_VIEW=false
        [[ -n "$queue_plan_json" ]] || log_warn "queue analysis unavailable, falling back to flat list"
        if [[ -n "$avail_unblocked" ]]; then
          echo "$avail_unblocked" | head -9 | awk -F'"'"'|'"'"' '"'"'{printf "  %s. %s - %s (score: %.0f)\n", NR, $1, $3, $5}'"'"'
        else
          echo "  (no unblocked tasks)"
        fi
        if (( avail_blocked_count > 0 )); then
          echo ""
          echo "  ($avail_blocked_count blocked task(s) hidden - enter '\''m'\'' to show all)"
        fi
      fi
    }
    log_warn() { printf "%s\n" "$*" >&2; }
    fetch_queue_plan() {
      printf "%s\n" '"'"'{"availableNow":["HOK-999"],"queuedAfterDependencies":[],"avoidRunningTogether":[],"needsTriage":[]}'"'"'
    }
    USING_GROUPED_VIEW=false
    SELECT_SHOW_ALL=false
    GROUPED_SELECT_FROM=""
    GROUPED_DISPLAY=""
    render_prompt_under_test "$CANDIDATES"
  ' >"$stdout" 2>"$stderr"

  stdout=$(cat "$stdout")
  stderr=$(cat "$stderr")
  check_contains "empty grouped render falls back to flat list" "$stdout" "1. HOK-10 - Foundation task (score: 98)"
  check_not_contains "empty grouped render does not warn analysis failed" "$stderr" "queue analysis unavailable"
}

run_queue_plan_failure_case() {
  local mode="$1" backlog_json="$2" verbosity="${3:-debug}"
  local case_tmp bin_dir stdout stderr
  case_tmp="$(mktemp -d "$TEST_TMP/fqp-case.XXXXXX")"
  bin_dir="$case_tmp/bin"
  mkdir -p "$bin_dir" "$case_tmp/tmp"

  case "$mode" in
    plan_queue_failed)
      cat > "$bin_dir/npx" <<'EOF'
#!/usr/bin/env bash
echo "CACHE REFRESH ERROR" >&2
exit 1
EOF
      ;;
    plan_queue_dependency_failed)
      cat > "$bin_dir/npx" <<'EOF'
#!/usr/bin/env bash
echo "DEPENDENCY PLANNING ERROR" >&2
exit 1
EOF
      ;;
    validation_failed)
      cat > "$bin_dir/npx" <<'EOF'
#!/usr/bin/env bash
printf '{"unexpected":"shape"}\n'
EOF
      ;;
    empty_queue)
      cat > "$bin_dir/npx" <<'EOF'
#!/usr/bin/env bash
printf '   \n'
EOF
      ;;
    *)
      cat > "$bin_dir/npx" <<'EOF'
#!/usr/bin/env bash
echo "unexpected npx call" >&2
exit 1
EOF
      ;;
  esac
  chmod +x "$bin_dir/npx"

  stdout="$case_tmp/stdout.txt"
  stderr="$case_tmp/stderr.txt"
  FUNCTIONS_FILE="$FUNCTIONS_FILE" RENDER_PROMPT_FILE="$RENDER_PROMPT_FILE" CANDIDATES="$CANDIDATES" BACKLOG_FOR_CASE="$backlog_json" STUB_BIN_DIR="$bin_dir" TMPDIR="$case_tmp/tmp" DASHBOARD_VERBOSITY="$verbosity" bash -c '
    set -euo pipefail
    export PATH="$STUB_BIN_DIR:$PATH"
    # shellcheck source=/dev/null
    source "$FUNCTIONS_FILE"
    # shellcheck source=/dev/null
    source "$RENDER_PROMPT_FILE"
    BACKLOG_CACHE_TTL=60
    BACKLOG_JSON_CACHE="$BACKLOG_FOR_CASE"
    QUEUE_PLAN_CACHE=""
    LAST_QUEUE_PLAN_FETCH=0
    TOOLS_DIR="/unused"
    _with_timeout() {
      shift
      "$@"
    }
    log_warn() { printf "WARN:%s\n" "$*" >&2; }
    log() {
      local level="$1"
      shift
      if [[ "$level" == "debug" && "${DASHBOARD_VERBOSITY:-info}" == "debug" ]]; then
        printf "DEBUG:%s\n" "$*" >&2
      fi
    }
    render_prompt_under_test "$CANDIDATES"
  ' >"$stdout" 2>"$stderr"

  printf '%s\n%s\n%s\n' "$stdout" "$stderr" "$case_tmp/tmp"
}

assert_no_queue_plan_temp_files() {
  local name="$1" tmp_dir="$2"
  local leftovers
  leftovers="$(find "$tmp_dir" -maxdepth 1 \( -name 'wavemill-fqp-stderr.*' -o -name 'wavemill-fqp-diagnostics.*' \) -print)"
  check_eq "$name" "" "$leftovers"
}

test_fetch_queue_plan_failure_diagnostics_cache_empty() {
  local result stdout stderr tmp_dir stderr_text
  result="$(run_queue_plan_failure_case "cache_empty" "")"
  stdout="$(sed -n '1p' <<<"$result")"
  stderr="$(sed -n '2p' <<<"$result")"
  tmp_dir="$(sed -n '3p' <<<"$result")"
  stderr_text="$(cat "$stderr")"

  check_contains "cache-empty fallback still renders flat list" "$(cat "$stdout")" "1. HOK-10 - Foundation task (score: 98)"
  check_contains "cache-empty warns once" "$stderr_text" "WARN:queue analysis unavailable"
  check_contains "cache-empty warning includes reason" "$stderr_text" "(reason: empty_queue)"
  check_contains "cache-empty warning ends with fallback" "$stderr_text" "falling back to flat list"
  check_contains "cache-empty debug names step" "$stderr_text" "step=cache_empty"
  check_contains "cache-empty debug includes reason" "$stderr_text" "reason=empty_queue"
  check_contains "cache-empty debug includes exit" "$stderr_text" "exit=1"
  check_contains "cache-empty debug marks empty stderr" "$stderr_text" "(no stderr captured)"
  check_eq "cache-empty warning count" "1" "$(grep -c 'queue analysis unavailable' "$stderr" || true)"
  check_eq "cache-empty debug count" "1" "$(grep -F -c 'DEBUG:[fetch_queue_plan]' "$stderr" || true)"
  assert_no_queue_plan_temp_files "cache-empty temp files cleaned" "$tmp_dir"
}

test_fetch_queue_plan_failure_diagnostics_jq_massage() {
  local result stderr tmp_dir stderr_text
  result="$(run_queue_plan_failure_case "jq_massage_failed" "{not-json")"
  stderr="$(sed -n '2p' <<<"$result")"
  tmp_dir="$(sed -n '3p' <<<"$result")"
  stderr_text="$(cat "$stderr")"

  check_contains "jq-massage warning includes reason" "$stderr_text" "(reason: invalid_input)"
  check_contains "jq-massage debug names step" "$stderr_text" "step=jq_massage_failed"
  check_contains "jq-massage debug includes reason" "$stderr_text" "reason=invalid_input"
  check_contains "jq-massage debug includes jq stderr" "$stderr_text" "parse error"
  check_eq "jq-massage warning count" "1" "$(grep -c 'queue analysis unavailable' "$stderr" || true)"
  check_eq "jq-massage debug count" "1" "$(grep -F -c 'DEBUG:[fetch_queue_plan]' "$stderr" || true)"
  assert_no_queue_plan_temp_files "jq-massage temp files cleaned" "$tmp_dir"
}

test_fetch_queue_plan_failure_diagnostics_plan_queue() {
  local result stderr tmp_dir stderr_text
  result="$(run_queue_plan_failure_case "plan_queue_failed" "$LINEAR_BACKLOG_JSON")"
  stderr="$(sed -n '2p' <<<"$result")"
  tmp_dir="$(sed -n '3p' <<<"$result")"
  stderr_text="$(cat "$stderr")"

  check_contains "plan-queue warning includes reason" "$stderr_text" "(reason: cache_refresh_failed)"
  check_contains "plan-queue debug names step" "$stderr_text" "step=plan_queue_failed"
  check_contains "plan-queue debug includes reason" "$stderr_text" "reason=cache_refresh_failed"
  check_contains "plan-queue debug includes exit" "$stderr_text" "exit=1"
  check_contains "plan-queue debug includes stderr" "$stderr_text" "CACHE REFRESH ERROR"
  check_eq "plan-queue warning count" "1" "$(grep -c 'queue analysis unavailable' "$stderr" || true)"
  check_eq "plan-queue debug count" "1" "$(grep -F -c 'DEBUG:[fetch_queue_plan]' "$stderr" || true)"
  assert_no_queue_plan_temp_files "plan-queue temp files cleaned" "$tmp_dir"
}

test_fetch_queue_plan_failure_diagnostics_dependency_planning() {
  local result stderr tmp_dir stderr_text
  result="$(run_queue_plan_failure_case "plan_queue_dependency_failed" "$LINEAR_BACKLOG_JSON")"
  stderr="$(sed -n '2p' <<<"$result")"
  tmp_dir="$(sed -n '3p' <<<"$result")"
  stderr_text="$(cat "$stderr")"

  check_contains "dependency-planning warning includes reason" "$stderr_text" "(reason: dependency_planning_failed)"
  check_contains "dependency-planning debug names step" "$stderr_text" "step=plan_queue_failed"
  check_contains "dependency-planning debug includes reason" "$stderr_text" "reason=dependency_planning_failed"
  check_contains "dependency-planning debug includes stderr" "$stderr_text" "DEPENDENCY PLANNING ERROR"
  check_eq "dependency-planning warning count" "1" "$(grep -c 'queue analysis unavailable' "$stderr" || true)"
  check_eq "dependency-planning debug count" "1" "$(grep -F -c 'DEBUG:[fetch_queue_plan]' "$stderr" || true)"
  assert_no_queue_plan_temp_files "dependency-planning temp files cleaned" "$tmp_dir"
}

test_fetch_queue_plan_failure_diagnostics_validation() {
  local result stderr tmp_dir stderr_text
  result="$(run_queue_plan_failure_case "validation_failed" "$LINEAR_BACKLOG_JSON")"
  stderr="$(sed -n '2p' <<<"$result")"
  tmp_dir="$(sed -n '3p' <<<"$result")"
  stderr_text="$(cat "$stderr")"

  check_contains "validation warning includes reason" "$stderr_text" "(reason: invalid_input)"
  check_contains "validation debug names step" "$stderr_text" "step=validation_failed"
  check_contains "validation debug includes reason" "$stderr_text" "reason=invalid_input"
  check_contains "validation debug marks empty stderr" "$stderr_text" "(no stderr captured)"
  check_eq "validation warning count" "1" "$(grep -c 'queue analysis unavailable' "$stderr" || true)"
  check_eq "validation debug count" "1" "$(grep -F -c 'DEBUG:[fetch_queue_plan]' "$stderr" || true)"
  assert_no_queue_plan_temp_files "validation temp files cleaned" "$tmp_dir"
}

test_fetch_queue_plan_failure_diagnostics_empty_queue() {
  local result stderr tmp_dir stderr_text
  result="$(run_queue_plan_failure_case "empty_queue" "$LINEAR_BACKLOG_JSON")"
  stderr="$(sed -n '2p' <<<"$result")"
  tmp_dir="$(sed -n '3p' <<<"$result")"
  stderr_text="$(cat "$stderr")"

  check_contains "empty-queue warning includes reason" "$stderr_text" "(reason: empty_queue)"
  check_contains "empty-queue debug names step" "$stderr_text" "step=empty_queue"
  check_contains "empty-queue debug includes exit" "$stderr_text" "exit=0"
  check_contains "empty-queue debug marks empty stderr" "$stderr_text" "(no stderr captured)"
  check_eq "empty-queue warning count" "1" "$(grep -c 'queue analysis unavailable' "$stderr" || true)"
  check_eq "empty-queue debug count" "1" "$(grep -F -c 'DEBUG:[fetch_queue_plan]' "$stderr" || true)"
  assert_no_queue_plan_temp_files "empty-queue temp files cleaned" "$tmp_dir"
}

test_fetch_queue_plan_warning_stays_quiet_without_debug() {
  local result stderr tmp_dir stderr_text
  result="$(run_queue_plan_failure_case "plan_queue_failed" "$LINEAR_BACKLOG_JSON" "info")"
  stderr="$(sed -n '2p' <<<"$result")"
  tmp_dir="$(sed -n '3p' <<<"$result")"
  stderr_text="$(cat "$stderr")"

  check_contains "non-debug fallback warns" "$stderr_text" "WARN:queue analysis unavailable"
  check_contains "non-debug warning includes reason" "$stderr_text" "(reason: cache_refresh_failed)"
  check_contains "non-debug warning ends with fallback" "$stderr_text" "falling back to flat list"
  check_not_contains "non-debug omits captured stderr" "$stderr_text" "CACHE REFRESH ERROR"
  check_not_contains "non-debug omits diagnostic step" "$stderr_text" "step=plan_queue_failed"
  check_eq "non-debug warning count" "1" "$(grep -c 'queue analysis unavailable' "$stderr" || true)"
  assert_no_queue_plan_temp_files "non-debug temp files cleaned" "$tmp_dir"
}

echo "=== Task Selection Renderer ==="
test_fetch_queue_plan_transforms_linear_backlog
test_backlog_refresh_persists_cache_in_parent_shell
test_filter_keeps_issue_with_no_children
test_filter_drops_issue_with_active_children
test_filter_keeps_parent_with_all_terminal_children
test_filter_uses_completed_at_fallback
test_filter_treats_unknown_state_as_nonterminal
test_filter_dedupes_all_terminal_info
test_invoke_first_wave_helper_packs_priority_without_violating_dependencies
test_grouped_render_with_fixture_output
test_grouped_render_orders_available_by_score
test_scoring_boosts_focus_and_near_milestones
test_grouped_render_deduplicates_and_keeps_one_item_per_line
test_render_rejects_malformed_json
test_fallback_when_queue_analysis_fails
test_fallback_when_grouped_plan_has_no_renderable_tasks
test_fetch_queue_plan_failure_diagnostics_cache_empty
test_fetch_queue_plan_failure_diagnostics_jq_massage
test_fetch_queue_plan_failure_diagnostics_plan_queue
test_fetch_queue_plan_failure_diagnostics_dependency_planning
test_fetch_queue_plan_failure_diagnostics_validation
test_fetch_queue_plan_failure_diagnostics_empty_queue
test_fetch_queue_plan_warning_stays_quiet_without_debug

echo
echo "Passed: $PASS"
echo "Failed: $FAIL"

if (( FAIL > 0 )); then
  exit 1
fi
