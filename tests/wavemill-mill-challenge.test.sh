#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MILL_SCRIPT="$REPO_DIR/shared/lib/wavemill-mill.sh"
MONITOR_SCRIPT_FILE="$REPO_DIR/shared/lib/wavemill-monitor.sh"
FIXTURE="$REPO_DIR/tests/fixtures/challenge-task-packet.md"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

check_contains() {
  local name="$1" haystack="$2" needle="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    pass "$name"
  else
    echo "    missing: $needle"
    fail "$name"
  fi
}

echo "=== Challenge Routing --file Guards ==="

if [[ ! -f "$MILL_SCRIPT" ]]; then
  fail "wavemill-mill.sh not found"
  echo ""
  echo "--- Results: $PASS passed, $FAIL failed ---"
  exit 1
fi

STARTUP_BLOCK="$(awk '
  /challenge_args=\(--issue "\$ISSUE"/ { capture=1 }
  capture { print }
  /log_warn "  \$ISSUE: Planner challenge deferred until expanded route is available"/ && capture { capture=0; exit }
' "$MILL_SCRIPT")"

RUNTIME_BLOCK="$(awk '
  /challenge_args=\(--issue "\$issue"/ { capture=1 }
  capture { print }
  /log_warn "  \$issue: Planner challenge deferred until expanded route is available"/ && capture { capture=0; exit }
' "$MONITOR_SCRIPT_FILE")"

if [[ -n "$STARTUP_BLOCK" ]]; then
  check_contains "startup block includes feature-dir hook" "$STARTUP_BLOCK" 'challenge_args+=(--feature-dir "${WORKTREE_ROOT}/${SLUG}/features/${SLUG}")'
  check_contains "startup block passes task packet file" "$STARTUP_BLOCK" 'challenge_args+=(--file "/tmp/${SESSION}-${ISSUE}-taskpacket.md")'
  check_contains "startup block resolves challenge task" "$STARTUP_BLOCK" 'resolve-challenge-task.ts'
else
  fail "could not extract startup challenge block"
fi

if [[ -n "$RUNTIME_BLOCK" ]]; then
  check_contains "runtime block still passes packet file" "$RUNTIME_BLOCK" 'challenge_args+=(--file "$packet_file")'
  check_contains "runtime block resolves challenge task" "$RUNTIME_BLOCK" 'resolve-challenge-task.ts'
else
  fail "could not extract runtime challenge block"
fi

if [[ -f "$FIXTURE" ]] && grep -q '^# Challenge Task Packet Fixture$' "$FIXTURE"; then
  pass "challenge task packet fixture exists"
else
  fail "challenge task packet fixture missing or malformed"
fi

echo ""
echo "=== Challenge Phase-Specific Agent Persistence Guards ==="

CHALLENGE_PERSISTENCE_BLOCK="$(awk '
  /if \[\[ "\$challenge_mode" == "challenge" \]\]; then/ { capture=1 }
  capture { print }
  /FINAL_LAUNCH_ARGS\+=\("\$challenger_key\|\$challenger_slug\|\$TITLE"\)/ && capture { exit }
' "$MILL_SCRIPT")"

if [[ -n "$CHALLENGE_PERSISTENCE_BLOCK" ]]; then
  check_contains "startup challenge extracts primary planner agent" "$CHALLENGE_PERSISTENCE_BLOCK" 'entries[0].plannerAgent'
  check_contains "startup challenge extracts challenger planner agent" "$CHALLENGE_PERSISTENCE_BLOCK" 'entries[1].plannerAgent'
  check_contains "startup primary task agent starts as planner agent" "$CHALLENGE_PERSISTENCE_BLOCK" 'TASK_AGENT_BY_ISSUE["$ISSUE"]="${primary_entry_planner_agent:-${primary_agent:-$rec_agent}}"'
  check_contains "startup challenger task agent starts as planner agent" "$CHALLENGE_PERSISTENCE_BLOCK" 'TASK_AGENT_BY_ISSUE["$challenger_key"]="${challenger_entry_planner_agent:-${challenger_agent:-$AGENT_CMD}}"'
else
  fail "could not extract startup challenge persistence block"
fi

RUNTIME_SAVE_BLOCK="$(awk '
  /# Save to state ledger/ { capture=1 }
  capture { print }
  /# Verify agent was saved correctly/ && capture { exit }
' "$MONITOR_SCRIPT_FILE")"

if [[ -n "$RUNTIME_SAVE_BLOCK" ]]; then
  check_contains "runtime primary state saves planner agent for planning phase" "$RUNTIME_SAVE_BLOCK" '"${planner_agent:-$task_agent_cmd}"'
  check_contains "runtime challenger state saves planner agent for planning phase" "$RUNTIME_SAVE_BLOCK" '"${challenger_planner_agent:-$challenger_agent}"'
  check_contains "startup challenge marks challenger launch evidence" "$RUNTIME_SAVE_BLOCK" '.tasks[$issue].challengerLaunched = true'
else
  fail "could not extract runtime state save block"
fi

echo ""
echo "=== Bootstrap Challenge Primary Role (HOK-2926) ==="

# The in-launch (bootstrap) pairing path forms the pair inside launch_task,
# before the primary has any state entry, so the challenge_role seeded from
# state is empty. The block must stamp "primary" itself, and the canonical
# save_task_state also derives the same primary role as a defense-in-depth
# backstop when challengePairId == issue. The pre-launch batch path
# (TASK_CHALLENGE_ROLE_BY_ISSUE) was never affected and is not what this
# section covers.
BOOTSTRAP_PAIR_BLOCK="$(awk '
  /challenge_enabled_for_launch="true"/ { capture=1 }
  capture { print }
  /challenge_assert_arms_diverge "\$issue"/ && capture { exit }
' "$MONITOR_SCRIPT_FILE")"

if [[ -n "$BOOTSTRAP_PAIR_BLOCK" ]]; then
  check_contains "bootstrap pair block stamps the primary role" "$BOOTSTRAP_PAIR_BLOCK" 'challenge_role="primary"'
  check_contains "bootstrap pair block keeps the pair id on the primary" "$BOOTSTRAP_PAIR_BLOCK" 'challenge_pair="$issue"'

  # The role must be assigned inside launch_task and before the ledger write.
  launch_task_line="$(grep -n '^launch_task() {' "$MONITOR_SCRIPT_FILE" | head -1 | cut -d: -f1)"
  role_line="$(grep -n 'challenge_role="primary"' "$MONITOR_SCRIPT_FILE" | head -1 | cut -d: -f1)"
  save_line="$(grep -n '# Save to state ledger' "$MONITOR_SCRIPT_FILE" | head -1 | cut -d: -f1)"
  if [[ -n "$launch_task_line" && -n "$role_line" && -n "$save_line" ]] \
    && (( launch_task_line < role_line )) && (( role_line < save_line )); then
    pass "bootstrap primary role is stamped inside launch_task before the state-ledger write"
  else
    echo "    launch_task=${launch_task_line:-?} role=${role_line:-?} save=${save_line:-?}"
    fail "bootstrap primary role is not stamped between launch_task start and the state-ledger write"
  fi
else
  fail "could not extract bootstrap challenge pair block"
fi

if [[ -n "$RUNTIME_SAVE_BLOCK" ]]; then
  check_contains "runtime primary state write passes the seeded role" "$RUNTIME_SAVE_BLOCK" '"$effective_challenge" "$challenge_pair" "${challenge_role:-}"'
  check_contains "runtime challenger state write passes the literal challenger role" "$RUNTIME_SAVE_BLOCK" '"true" "$challenge_pair" "challenger"'
fi

# Functional replay: evaluate the bootstrap block's own role/pair assignments
# (lifted from the live monitor text, not re-typed here) and drive the
# canonical writer exactly as launch_task does — seeded role from an empty
# state entry, then the primary save, then the challengerLaunched mutation.
BOOTSTRAP_ROLE_ASSIGNMENTS="$(printf '%s\n' "$BOOTSTRAP_PAIR_BLOCK" | grep -E '^[[:space:]]*challenge_(enabled_for_launch|pair|role)=' || true)"
if [[ -n "$BOOTSTRAP_ROLE_ASSIGNMENTS" ]]; then
  BOOTSTRAP_STATE_TMP="$(mktemp -d)"
  BOOTSTRAP_STATE_FILE="$BOOTSTRAP_STATE_TMP/state.json"
  printf '%s\n' '{"tasks":{}}' > "$BOOTSTRAP_STATE_FILE"
  (
    set +e
    source "$REPO_DIR/shared/lib/wavemill-common.sh"
    log_warn() { :; }
    STATE_FILE="$BOOTSTRAP_STATE_FILE"
    issue="HOK-2926"
    challenge_role="$(jq -r --arg issue "$issue" '.tasks[$issue].challengeRole // empty' "$STATE_FILE")"
    eval "$BOOTSTRAP_ROLE_ASSIGNMENTS"
    effective_challenge="$challenge_enabled_for_launch"
    save_task_state "$issue" "bootstrap-primary" "task/bootstrap-primary" "/tmp/bootstrap-primary" "" "" "codex" "$issue" "$effective_challenge" "$challenge_pair" "${challenge_role:-}" "gpt-5" "gpt-5" "gpt-5" "gpt-5" "light" "medium" "static" "implementation" 2>/dev/null
    echo "$?" > "$BOOTSTRAP_STATE_TMP/save.rc"
    state_mutate "$STATE_FILE" '.tasks[$issue].challengerLaunched = true' --arg issue "$issue" >/dev/null 2>&1 || true
  )
  if [[ "$(cat "$BOOTSTRAP_STATE_TMP/save.rc")" == "0" ]] \
    && [[ "$(jq -r '.tasks["HOK-2926"].slug // ""' "$BOOTSTRAP_STATE_FILE")" == "bootstrap-primary" ]] \
    && [[ "$(jq -r '.tasks["HOK-2926"].challengeRole // ""' "$BOOTSTRAP_STATE_FILE")" == "primary" ]] \
    && [[ "$(jq -r '.tasks["HOK-2926"].challengePairId // ""' "$BOOTSTRAP_STATE_FILE")" == "HOK-2926" ]] \
    && [[ "$(jq -r '.tasks["HOK-2926"].challenge' "$BOOTSTRAP_STATE_FILE")" == "true" ]] \
    && [[ "$(jq -r '.tasks["HOK-2926"].challengerLaunched' "$BOOTSTRAP_STATE_FILE")" == "true" ]]; then
    pass "bootstrap primary replay writes a complete entry with challengeRole=primary"
  else
    echo "    state: $(cat "$BOOTSTRAP_STATE_FILE")"
    fail "bootstrap primary replay did not produce a complete primary entry"
  fi

  # Control: the same replay without the role stamp validates HOK-2931's
  # defense-in-depth path. The canonical writer derives the primary role from
  # challengePairId == issue, so the follow-up mutation does not create the
  # HOK-2926 slug-less stub.
  printf '%s\n' '{"tasks":{}}' > "$BOOTSTRAP_STATE_FILE"
  (
    set +e
    source "$REPO_DIR/shared/lib/wavemill-common.sh"
    log_warn() { :; }
    STATE_FILE="$BOOTSTRAP_STATE_FILE"
    issue="HOK-2926"
    challenge_role="$(jq -r --arg issue "$issue" '.tasks[$issue].challengeRole // empty' "$STATE_FILE")"
    eval "$(printf '%s\n' "$BOOTSTRAP_ROLE_ASSIGNMENTS" | grep -v 'challenge_role=')"
    effective_challenge="$challenge_enabled_for_launch"
    save_task_state "$issue" "bootstrap-primary" "task/bootstrap-primary" "/tmp/bootstrap-primary" "" "" "codex" "$issue" "$effective_challenge" "$challenge_pair" "${challenge_role:-}" "gpt-5" "gpt-5" "gpt-5" "gpt-5" "light" "medium" "static" "implementation" 2>/dev/null
    echo "$?" > "$BOOTSTRAP_STATE_TMP/save.rc"
    state_mutate "$STATE_FILE" '.tasks[$issue].challengerLaunched = true' --arg issue "$issue" >/dev/null 2>&1 || true
  )
  if [[ "$(cat "$BOOTSTRAP_STATE_TMP/save.rc")" == "0" ]] \
    && [[ "$(jq -r '.tasks["HOK-2926"].slug // ""' "$BOOTSTRAP_STATE_FILE")" == "bootstrap-primary" ]] \
    && [[ "$(jq -r '.tasks["HOK-2926"].challengeRole // ""' "$BOOTSTRAP_STATE_FILE")" == "primary" ]] \
    && [[ "$(jq -r '.tasks["HOK-2926"].challengerLaunched' "$BOOTSTRAP_STATE_FILE")" == "true" ]]; then
    pass "control: without the role stamp the canonical writer derives primary"
  else
    echo "    state: $(cat "$BOOTSTRAP_STATE_FILE")"
    fail "control replay did not derive primary from the challenge pair"
  fi
  rm -rf "$BOOTSTRAP_STATE_TMP"
else
  fail "could not lift role/pair assignments from the bootstrap challenge pair block"
fi

CODING_HANDOFF_BLOCK="$(awk '
  /if ! coder_agent="\$\(agent_resolve_from_model "\$coder_launch_model" "coding"\)"; then/ { capture=1 }
  capture { print }
  /launch_coding_phase "\$ISSUE"/ && capture { exit }
' "$MONITOR_SCRIPT_FILE")"

if [[ -n "$CODING_HANDOFF_BLOCK" ]]; then
  check_contains "coding handoff updates task agent to coder" "$CODING_HANDOFF_BLOCK" '.tasks[$issue].agent = $agent'
  check_contains "coding handoff writes resolved coder agent" "$CODING_HANDOFF_BLOCK" '--arg agent "$coder_agent"'
else
  fail "could not extract coding handoff block"
fi

echo ""
echo "=== Challenge Execution Intent Finalization Guards ==="

FINALIZATION_HELPER="$(awk '
  /^finalize_challenge_execution_intent_before_coding\(\) \{/ { capture=1 }
  capture { print }
  /^}/ && capture { exit }
' "$MONITOR_SCRIPT_FILE")"

CODING_FINALIZATION_BLOCK="$(awk '
  /FINALIZED_CHALLENGE_CODER=""/ { capture=1 }
  capture { print }
  /if \[\[ -n "\$FINALIZED_CHALLENGE_CODER" \]\]/ && capture { seen=1 }
  seen && /fi/ { exit }
' "$MONITOR_SCRIPT_FILE")"

if [[ -n "$FINALIZATION_HELPER" ]]; then
  check_contains "finalizer skips challenger side" "$FINALIZATION_HELPER" '[[ "$challenge_role_meta" != "challenger" ]] || return 0'
  check_contains "finalizer requires expanded artifact" "$FINALIZATION_HELPER" '[[ -f "$feature_dir/.post-expansion-route.json" ]] || return 0'
  check_contains "finalizer preserves an already selected challenge arm" "$FINALIZATION_HELPER" 'Preserving selected challenge arm through expanded routing'
  check_contains "finalizer reads the persisted challenge intent before rerouting" "$FINALIZATION_HELPER" '(.tasks[$i].challengeExecutionIntent // .tasks[$i].challengeIntent) // empty'
  check_contains "finalizer pins the already-selected stage when it must reroute" "$FINALIZATION_HELPER" 'pinned_stage_arg=(--pinned-stage "$pinned_stage")'
  check_contains "finalizer passes the pinned stage to the resolver" "$FINALIZATION_HELPER" '"${pinned_stage_arg[@]}"'
  check_contains "finalizer reads the persisted challenger varied model" "$FINALIZATION_HELPER" '.tasks[$i].challengeVariedModel // ""'
  check_contains "finalizer passes preserved challenger model to resolver" "$FINALIZATION_HELPER" '"${preserved_challenger_arg[@]}"'
  check_contains "finalizer passes feature-dir to resolver" "$FINALIZATION_HELPER" '--feature-dir "$feature_dir"'
  check_contains "finalizer passes task packet when present" "$FINALIZATION_HELPER" 'packet_arg=(--file "$feature_dir/task-packet.md")'
  check_contains "finalizer requires expanded or preserved source" "$FINALIZATION_HELPER" 'refreshed_source" != "expanded" && "$refreshed_source" != "preserved"'
  check_contains "finalizer extracts challenge intent" "$FINALIZATION_HELPER" '.challengeExecutionIntent // empty'
  check_contains "finalizer persists no-challenge intent" "$FINALIZATION_HELPER" 'persist_challenge_execution_intent "$issue" "" "$feature_dir" "$intent_json"'
  check_contains "finalizer saves primary planner" "$FINALIZATION_HELPER" 'new_primary_planner'
  check_contains "finalizer saves challenger planner" "$FINALIZATION_HELPER" 'new_challenger_planner'
  check_contains "finalizer persists paired intent" "$FINALIZATION_HELPER" 'persist_challenge_execution_intent "$issue" "$new_challenger_key" "$feature_dir" "$intent_json"'
  check_contains "finalizer marks challenger launch evidence" "$FINALIZATION_HELPER" '.tasks[$issue].challengerLaunched = true'
  check_contains "finalizer cancels collapsed identical challenger" "$FINALIZATION_HELPER" 'challenge_cancel_challenger_arm "$issue" "$slug" "$new_challenger_key"'
  check_contains "finalizer exposes in-memory coder" "$FINALIZATION_HELPER" 'FINALIZED_CHALLENGE_CODER="$new_primary"'
  # Printing the coders made every plan/review pair look degenerate in the log
  # ("gpt-5.5 vs gpt-5.5") because those stages share a coder by design.
  check_contains "finalizer logs the varied models and stage" "$FINALIZATION_HELPER" 'stage=$new_challenge_stage): $new_primary_varied vs $new_challenger_varied'
  check_contains "finalizer checks the arms actually diverge" "$FINALIZATION_HELPER" 'challenge_assert_arms_diverge "$issue" "$new_challenge_stage"'
else
  fail "could not extract challenge execution finalizer"
fi

CANCEL_HELPER="$(awk '
  /^challenge_cancel_challenger_arm\(\) \{/ { capture=1 }
  capture { print }
  /^}/ && capture { exit }
' "$MONITOR_SCRIPT_FILE")"

if [[ -n "$CANCEL_HELPER" ]]; then
  check_contains "collapse helper removes challenger state" "$CANCEL_HELPER" 'remove_task_state "$challenger_key"'
  check_contains "collapse helper marks primary reason" "$CANCEL_HELPER" 'challengeCollapseReason = $reason'
  check_contains "collapse helper clears primary challenge role" "$CANCEL_HELPER" '.tasks[$issue].challengeRole'
  check_contains "collapse helper emits lifecycle event" "$CANCEL_HELPER" 'log_route_lifecycle "challenge_collapsed"'
else
  fail "could not extract challenge_cancel_challenger_arm helper"
fi

SAVE_STATE_HELPER="$(awk '
  /^save_task_state\(\) \{/ { count++; if (count == 1) capture=1 }
  capture { print }
  /^}/ && capture { exit }
' "$REPO_DIR/shared/lib/wavemill-common.sh")"

if [[ -n "$SAVE_STATE_HELPER" ]]; then
  check_contains "canonical state writer merges over the stored task object" "$SAVE_STATE_HELPER" '.tasks[$issue] = ($existing + {'
  check_contains "canonical state writer is atomic via state_mutate" "$SAVE_STATE_HELPER" 'state_mutate "$STATE_FILE"'

  # Exercise the production helper: startup pairing stores this projected
  # contract before either member is expanded, and later state updates must not
  # erase it before the coding handoff consumes it.
  RUNTIME_STATE_TMP="$(mktemp -d)"
  RUNTIME_STATE_FILE="$RUNTIME_STATE_TMP/state.json"
  printf '%s\n' '{"tasks":{"HOK-2724_c":{"slug":"native-review","branch":"task/native-review","worktree":"/tmp/native-review","status":"active","challenge":true,"challengePairId":"HOK-2724","challengeRole":"challenger","challengeStage":"review","challengeIntent":{"pairId":"HOK-2724","challengeStage":"review","challenger":{"expectedRoute":{"reviewer":"qwen-3-coder"}}}}}}' > "$RUNTIME_STATE_FILE"
  source "$REPO_DIR/shared/lib/wavemill-common.sh"
  log_warn() { :; }
  STATE_FILE="$RUNTIME_STATE_FILE"
  save_task_state "HOK-2724_c" "native-review" "task/native-review" "/tmp/native-review" "" "coding" "codex" "HOK-2724_c" "true" "HOK-2724" "challenger" "qwen-3-coder" "bootstrap-planner" "bootstrap-coder" "qwen-3-coder" "light" "medium" "llm" "review"
  if [[ "$(jq -r '.tasks["HOK-2724_c"].challengeIntent.challenger.expectedRoute.reviewer' "$RUNTIME_STATE_FILE")" == "qwen-3-coder" ]]; then
    pass "runtime state update retains challenge intent for native reviewer"
  else
    fail "runtime state update discarded challenge intent for native reviewer"
  fi

  # The varied model/agent are the launch-time backstop for plan- and
  # review-stage arms. A routine status update must not drop them.
  jq '.tasks["HOK-2724_c"].challengeVariedModel = "kimi-k2"
      | .tasks["HOK-2724_c"].challengeVariedAgent = "native-openrouter"' \
    "$RUNTIME_STATE_FILE" > "$RUNTIME_STATE_TMP/state.next" \
    && mv "$RUNTIME_STATE_TMP/state.next" "$RUNTIME_STATE_FILE"
  save_task_state "HOK-2724_c" "native-review" "task/native-review" "/tmp/native-review" "" "active" "codex" "HOK-2724_c" "true" "HOK-2724" "challenger" "qwen-3-coder" "bootstrap-planner" "bootstrap-coder" "qwen-3-coder" "light" "medium" "llm" "review"
  if [[ "$(jq -r '.tasks["HOK-2724_c"].challengeVariedModel' "$RUNTIME_STATE_FILE")" == "kimi-k2" ]] \
    && [[ "$(jq -r '.tasks["HOK-2724_c"].challengeVariedAgent' "$RUNTIME_STATE_FILE")" == "native-openrouter" ]]; then
    pass "runtime state update retains the varied stage model and agent"
  else
    fail "runtime state update discarded the varied stage model or agent"
  fi

  if save_task_state "HOK-9998" "blank-primary" "task/blank-primary" "/tmp/blank-primary" "" "active" "codex" "HOK-9998" "true" "HOK-9998" "" "gpt-5" "gpt-5" "gpt-5" "gpt-5" "medium" "medium" "llm" "implementation" 2>/dev/null; then
    if [[ "$(jq -r '.tasks["HOK-9998"].challengeRole // ""' "$RUNTIME_STATE_FILE")" == "primary" ]]; then
      pass "runtime state derives blank primary challenge role"
    else
      fail "runtime state should persist derived primary challenge role"
    fi
  else
    fail "runtime state should derive blank primary challenge role"
  fi

  if save_task_state "HOK-9998_c" "blank-challenger" "task/blank-primary-challenger" "/tmp/blank-challenger" "" "active" "codex" "HOK-9998" "true" "HOK-9998" "" "claude-sonnet-4" "gpt-5" "claude-sonnet-4" "gpt-5" "medium" "medium" "llm" "implementation" 2>/dev/null; then
    fail "runtime state should reject blank challenger challenge role"
  else
    pass "runtime state rejects blank challenger challenge role with error"
  fi

  # challenge_varied_stage_model must only speak up for the stage the pair varies.
  CHALLENGE_VARIED_HELPER="$(awk '
    /^challenge_varied_stage_model\(\) \{/ { capture=1 }
    capture { print }
    /^}/ && capture { exit }
  ' "$MONITOR_SCRIPT_FILE")"
  if [[ -n "$CHALLENGE_VARIED_HELPER" ]]; then
    eval "$CHALLENGE_VARIED_HELPER"
    # Stand in for the mill helper; wavemill-common.sh does not define read_state_value.
    get_task_meta() {
      jq -r --arg issue "$1" --arg field "$2" '.tasks[$issue][$field] // empty' "$RUNTIME_STATE_FILE" 2>/dev/null
    }
    if [[ "$(challenge_varied_stage_model "HOK-2724_c" "review")" == "kimi-k2" ]] \
      && [[ -z "$(challenge_varied_stage_model "HOK-2724_c" "coding")" ]] \
      && [[ -z "$(challenge_varied_stage_model "HOK-2724_c" "plan")" ]]; then
      pass "varied stage model applies only to the stage the pair varies"
    else
      fail "varied stage model leaked into a shared stage"
    fi

    # Launch sites spell the phase differently than the challenge stage does
    # ("planning" vs "plan", "coding" vs "implementation"). Pin every alias so a
    # dropped case arm cannot silently stop restoring an arm.
    jq '.tasks["HOK-2724_c"].challengeStage = "implementation"' "$RUNTIME_STATE_FILE" > "$RUNTIME_STATE_TMP/state.next" \
      && mv "$RUNTIME_STATE_TMP/state.next" "$RUNTIME_STATE_FILE"
    if [[ "$(challenge_varied_stage_model "HOK-2724_c" "coding")" == "kimi-k2" ]] \
      && [[ "$(challenge_varied_stage_model "HOK-2724_c" "implementation")" == "kimi-k2" ]] \
      && [[ -z "$(challenge_varied_stage_model "HOK-2724_c" "review")" ]] \
      && [[ -z "$(challenge_varied_stage_model "HOK-2724_c" "nonsense")" ]]; then
      pass "coding and implementation both resolve the implementation stage"
    else
      fail "implementation stage aliases did not resolve"
    fi

    jq '.tasks["HOK-2724_c"].challengeStage = "plan"' "$RUNTIME_STATE_FILE" > "$RUNTIME_STATE_TMP/state.next" \
      && mv "$RUNTIME_STATE_TMP/state.next" "$RUNTIME_STATE_FILE"
    if [[ "$(challenge_varied_stage_model "HOK-2724_c" "plan")" == "kimi-k2" ]] \
      && [[ "$(challenge_varied_stage_model "HOK-2724_c" "planning")" == "kimi-k2" ]] \
      && [[ -z "$(challenge_varied_stage_model "HOK-2724_c" "coding")" ]]; then
      pass "plan and planning both resolve the plan stage"
    else
      fail "plan stage aliases did not resolve"
    fi
  else
    fail "could not extract challenge_varied_stage_model helper"
  fi
  rm -rf "$RUNTIME_STATE_TMP"
else
  fail "could not extract canonical save_task_state helper from wavemill-common.sh"
fi

DIVERGE_HELPER="$(awk '
  /^challenge_assert_arms_diverge\(\) \{/ { capture=1 }
  capture { print }
  /^}/ && capture { exit }
' "$MONITOR_SCRIPT_FILE")"

if [[ -n "$DIVERGE_HELPER" ]]; then
  DIVERGE_TMP="$(mktemp -d)"
  (
    eval "$DIVERGE_HELPER"
    log_error() { printf 'ERROR %s\n' "$*" >> "$DIVERGE_TMP/out"; }
    log_route_lifecycle() { printf 'LIFECYCLE %s\n' "$*" >> "$DIVERGE_TMP/out"; }
    : > "$DIVERGE_TMP/out"
    challenge_assert_arms_diverge "HOK-1" "implementation" "kimi-k2" "gpt-5.5" ""
    challenge_assert_arms_diverge "HOK-2" "review" "gpt-5.5" "gpt-5.5" ""
    challenge_assert_arms_diverge "HOK-3" "plan" "gpt-5.5" "gpt-5.5" '{"intentionallyIdentical":true}'
    challenge_assert_arms_diverge "HOK-4" "plan" "" "" ""
  )
  DIVERGE_OUT="$(cat "$DIVERGE_TMP/out" 2>/dev/null || true)"
  if [[ "$DIVERGE_OUT" != *"HOK-1"* ]] \
    && [[ "$DIVERGE_OUT" == *"HOK-2"* ]] \
    && [[ "$DIVERGE_OUT" != *"HOK-3"* ]] \
    && [[ "$DIVERGE_OUT" != *"HOK-4"* ]]; then
    pass "identical challenge arms alarm only when the pair truly measures nothing"
  else
    fail "identical-arm alarm misfired: $DIVERGE_OUT"
  fi
  if [[ "$DIVERGE_OUT" == *"challenge_arms_identical"* ]]; then
    pass "identical challenge arms emit a route lifecycle event"
  else
    fail "identical challenge arms did not emit a lifecycle event"
  fi
  rm -rf "$DIVERGE_TMP"
else
  fail "could not extract challenge_assert_arms_diverge helper"
fi

PLANNER_GATE_HELPER="$(awk '
  /^challenge_plan_stage_requires_effective_route\(\) \{/ { capture=1 }
  capture { print }
  /^}/ && capture { exit }
' "$MILL_SCRIPT")"

if [[ -n "$PLANNER_GATE_HELPER" ]]; then
  check_contains "planner challenge gate detects planning stage" "$PLANNER_GATE_HELPER" '[[ "$challenge_stage" == "planning" || "$challenge_stage" == "plan" || "$challenge_stage" == "planner" ]]'
  check_contains "planner challenge gate requires effective route source" "$PLANNER_GATE_HELPER" '[[ "$decision_source" != "expanded" && "$decision_source" != "preserved" ]]'
else
  fail "could not extract planner challenge route gate"
fi

check_contains "startup planner challenge defers without effective route" "$STARTUP_BLOCK" 'challenge_plan_stage_requires_effective_route "$challenge_plan"'
check_contains "startup planner challenge records defer reason" "$STARTUP_BLOCK" 'plan_stage_expanded_route_unavailable'
check_contains "runtime planner challenge defers without effective route" "$RUNTIME_BLOCK" 'challenge_plan_stage_requires_effective_route "$challenge_plan"'
check_contains "runtime planner challenge records defer reason" "$RUNTIME_BLOCK" 'plan_stage_expanded_route_unavailable'
# A plan-stage challenge that cannot form yet must be retargeted, not deleted:
# dropping to single is how an already-selected open-weight coder arm vanished.
check_contains "runtime planner challenge retargets to implementation before dropping" "$RUNTIME_BLOCK" '--pinned-stage implementation'
check_contains "runtime planner challenge keeps the pair when retargeting works" "$RUNTIME_BLOCK" 'retargeted to implementation stage'

if [[ -n "$CODING_FINALIZATION_BLOCK" ]]; then
  check_contains "coding handoff calls finalizer" "$CODING_FINALIZATION_BLOCK" 'finalize_challenge_execution_intent_before_coding "$ISSUE" "$SLUG" "$BRANCH" "$WT_DIR" "$FEATURE_DIR" "$coder_model"'
  check_contains "coding handoff updates challenge coder from final intent" "$CODING_FINALIZATION_BLOCK" 'challenge_coder="$FINALIZED_CHALLENGE_CODER"'
else
  fail "could not extract coding finalization block"
fi

echo ""
echo "=== Challenge Expanded-Route Refresh State Persistence (functional) ==="

TEST_TMP="$(mktemp -d)"
trap 'rm -rf "$TEST_TMP"' EXIT

STATE_FILE="$TEST_TMP/state.json"

# Pre-refresh state: both sides show gpt-5.4 (the bug scenario)
cat > "$STATE_FILE" <<'JSON'
{
  "tasks": {
    "HOK-9999": {
      "slug": "hok-9999",
      "branch": "task/hok-9999",
      "worktree": "/tmp/worktrees/hok-9999",
      "pr": "",
      "status": "active",
      "agent": "codex",
      "phase": "planning",
      "challenge": true,
      "challengePairId": "HOK-9999",
      "challengeRole": "primary",
      "challengeModel": "gpt-5.4",
      "coderModel": "gpt-5.4",
      "plannerModel": "gpt-5.4",
      "reviewerModel": "gpt-5.4",
      "planDepth": "light",
      "codeDepth": "medium",
      "reviewMode": "static",
      "linearIssueId": "HOK-9999"
    },
    "HOK-9999_c": {
      "slug": "hok-9999-c",
      "branch": "task/hok-9999-c",
      "worktree": "/tmp/worktrees/hok-9999-c",
      "pr": "",
      "status": "active",
      "agent": "codex",
      "phase": "planning",
      "challenge": true,
      "challengePairId": "HOK-9999",
      "challengeRole": "challenger",
      "challengeModel": "gpt-5.4",
      "coderModel": "gpt-5.4",
      "plannerModel": "gpt-5.4",
      "reviewerModel": "gpt-5.4",
      "planDepth": "light",
      "codeDepth": "medium",
      "reviewMode": "static",
      "linearIssueId": "HOK-9999"
    }
  }
}
JSON

REFRESHED_PLAN='{"decisionSource":"expanded","entries":[
  {"model":"gpt-5.4","planner":"gpt-5.5","reviewer":"gpt-5.5","planDepth":"deep","codeDepth":"deep","reviewMode":"static","key":"HOK-9999"},
  {"model":"claude-sonnet-4-6","planner":"claude-sonnet-4-6","reviewer":"claude-sonnet-4-6","planDepth":"deep","codeDepth":"deep","reviewMode":"static+llm","key":"HOK-9999_c"}
]}'

bash -lc '
  set -euo pipefail
  source "$3/shared/lib/wavemill-common.sh"

  STATE_FILE="$1"
  REFRESHED_PLAN="$2"

  log() { :; }
  log_warn() { printf "WARN: %s\n" "$1" >&2; }

  save_task_state() {
    local issue="$1" slug="$2" branch="$3" worktree="$4" pr="${5:-}" status="${6:-active}" agent="${7:-}"
    local linear_issue="${8:-$issue}" challenge="${9:-}" challenge_pair="${10:-}" challenge_role="${11:-}" challenge_model="${12:-}"
    local planner_model="${13:-}" coder_model="${14:-}" reviewer_model="${15:-}" plan_depth="${16:-}" code_depth="${17:-}" review_mode="${18:-}"
    local challenge_stage="${19:-}"

    state_mutate "$STATE_FILE" \
      "(.tasks[\$issue].agent // \"\") as \$old_agent |
       (.tasks[\$issue].phase // \"executing\") as \$old_phase |
       (.tasks[\$issue].evalCompleted // false) as \$old_eval |
       (.tasks[\$issue].evalFailed // false) as \$old_eval_failed |
       (.tasks[\$issue].challengeCompared // false) as \$old_challenge_compared |
       (.tasks[\$issue].challenge // false) as \$old_challenge |
       (.tasks[\$issue].challengePairId // \"\") as \$old_challenge_pair |
       (.tasks[\$issue].challengeRole // \"\") as \$old_challenge_role |
       (.tasks[\$issue].challengeModel // \"\") as \$old_challenge_model |
       (.tasks[\$issue].challengeStage // \"\") as \$old_challenge_stage |
       (.tasks[\$issue].evalRunning // null) as \$old_eval_running |
       (.tasks[\$issue].comparisonRunning // null) as \$old_comparison_running |
       (.tasks[\$issue].linearIssueId // \$issue) as \$old_linear_issue |
       (.tasks[\$issue].coderModel // \"\") as \$old_coderModel |
       (.tasks[\$issue].plannerModel // \"\") as \$old_plannerModel |
       (.tasks[\$issue].reviewerModel // \"\") as \$old_reviewerModel |
       (.tasks[\$issue].planDepth // \"\") as \$old_planDepth |
       (.tasks[\$issue].codeDepth // \"\") as \$old_codeDepth |
       (.tasks[\$issue].reviewMode // \"\") as \$old_reviewMode |
       .tasks[\$issue] = {
         slug: \$slug, branch: \$branch, worktree: \$worktree, pr: \$pr, status: \$status,
         linearIssueId: (if \$linearIssue != \"\" then \$linearIssue else \$old_linear_issue end),
         agent: (if \$agent != \"\" then \$agent else \$old_agent end),
         challenge: (if \$challenge != \"\" then (\$challenge == \"true\") else \$old_challenge end),
         challengePairId: (if \$challengePair != \"\" then \$challengePair else \$old_challenge_pair end),
         challengeRole: (if \$challengeRole != \"\" then \$challengeRole else \$old_challenge_role end),
         challengeModel: (if \$challengeModel != \"\" then \$challengeModel else \$old_challenge_model end),
         challengeStage: (if \$challengeStage != \"\" then \$challengeStage else \$old_challenge_stage end),
         coderModel: (if \$coderModel != \"\" then \$coderModel else \$old_coderModel end),
         plannerModel: (if \$plannerModel != \"\" then \$plannerModel else \$old_plannerModel end),
         reviewerModel: (if \$reviewerModel != \"\" then \$reviewerModel else \$old_reviewerModel end),
         planDepth: (if \$planDepth != \"\" then \$planDepth else \$old_planDepth end),
         codeDepth: (if \$codeDepth != \"\" then \$codeDepth else \$old_codeDepth end),
         reviewMode: (if \$reviewMode != \"\" then \$reviewMode else \$old_reviewMode end),
         phase: \$old_phase, evalCompleted: \$old_eval, evalFailed: \$old_eval_failed,
         challengeCompared: \$old_challenge_compared, evalRunning: \$old_eval_running,
         comparisonRunning: \$old_comparison_running, updated: (now | todate)
       }" \
      --arg issue "$issue" --arg slug "$slug" --arg branch "$branch" \
      --arg worktree "$worktree" --arg pr "$pr" --arg status "$status" \
      --arg agent "$agent" --arg linearIssue "$linear_issue" --arg challenge "$challenge" \
      --arg challengePair "$challenge_pair" --arg challengeRole "$challenge_role" \
      --arg challengeModel "$challenge_model" \
      --arg challengeStage "$challenge_stage" \
      --arg plannerModel "$planner_model" --arg coderModel "$coder_model" --arg reviewerModel "$reviewer_model" \
      --arg planDepth "$plan_depth" --arg codeDepth "$code_depth" --arg reviewMode "$review_mode"
  }

  # Simulate the fixed expanded refresh extraction + persistence
  new_primary=$(echo "$REFRESHED_PLAN" | jq -r ".entries[0].model // empty" 2>/dev/null)
  new_primary_planner=$(echo "$REFRESHED_PLAN" | jq -r ".entries[0].planner // empty" 2>/dev/null)
  new_primary_reviewer=$(echo "$REFRESHED_PLAN" | jq -r ".entries[0].reviewer // empty" 2>/dev/null)
  new_primary_plan_depth=$(echo "$REFRESHED_PLAN" | jq -r ".entries[0].planDepth // empty" 2>/dev/null)
  new_primary_code_depth=$(echo "$REFRESHED_PLAN" | jq -r ".entries[0].codeDepth // empty" 2>/dev/null)
  new_primary_review_mode=$(echo "$REFRESHED_PLAN" | jq -r ".entries[0].reviewMode // empty" 2>/dev/null)
  new_challenge_stage=$(echo "$REFRESHED_PLAN" | jq -r ".challengeStage // \"implementation\"" 2>/dev/null || echo "implementation")
  new_challenger_key=$(echo "$REFRESHED_PLAN" | jq -r ".entries[1].key // empty" 2>/dev/null)
  new_challenger_model=$(echo "$REFRESHED_PLAN" | jq -r ".entries[1].model // empty" 2>/dev/null)
  new_challenger_planner=$(echo "$REFRESHED_PLAN" | jq -r ".entries[1].planner // empty" 2>/dev/null)
  new_challenger_reviewer=$(echo "$REFRESHED_PLAN" | jq -r ".entries[1].reviewer // empty" 2>/dev/null)
  new_challenger_plan_depth=$(echo "$REFRESHED_PLAN" | jq -r ".entries[1].planDepth // empty" 2>/dev/null)
  new_challenger_code_depth=$(echo "$REFRESHED_PLAN" | jq -r ".entries[1].codeDepth // empty" 2>/dev/null)
  new_challenger_review_mode=$(echo "$REFRESHED_PLAN" | jq -r ".entries[1].reviewMode // empty" 2>/dev/null)

  if [[ -n "$new_primary" ]]; then
    save_task_state "HOK-9999" "hok-9999" "task/hok-9999" "/tmp/worktrees/hok-9999" "" "active" "codex" "HOK-9999" \
      "true" "HOK-9999" "primary" "$new_primary" "$new_primary_planner" "$new_primary" "$new_primary_reviewer" "$new_primary_plan_depth" "$new_primary_code_depth" "$new_primary_review_mode" "$new_challenge_stage"
  fi

  challenger_slug=$(jq -r ".tasks[\"$new_challenger_key\"].slug // empty" "$STATE_FILE")
  challenger_branch=$(jq -r ".tasks[\"$new_challenger_key\"].branch // empty" "$STATE_FILE")
  challenger_worktree=$(jq -r ".tasks[\"$new_challenger_key\"].worktree // empty" "$STATE_FILE")
  if [[ -n "$new_challenger_key" ]] && [[ -n "$new_challenger_model" ]] && [[ -n "$challenger_slug" ]] && [[ -n "$challenger_branch" ]] && [[ -n "$challenger_worktree" ]]; then
    save_task_state "$new_challenger_key" "$challenger_slug" "$challenger_branch" "$challenger_worktree" "" "active" "codex" "HOK-9999" \
      "true" "HOK-9999" "challenger" "$new_challenger_model" "$new_challenger_planner" "$new_challenger_model" "$new_challenger_reviewer" "$new_challenger_plan_depth" "$new_challenger_code_depth" "$new_challenger_review_mode" "$new_challenge_stage"
  fi
' bash "$STATE_FILE" "$REFRESHED_PLAN" "$REPO_DIR"

check_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    pass "$label"
  else
    echo "    expected: $expected"
    echo "    actual:   $actual"
    fail "$label"
  fi
}

primary_challenge_model=$(jq -r '.tasks["HOK-9999"].challengeModel // empty' "$STATE_FILE")
primary_coder_model=$(jq -r '.tasks["HOK-9999"].coderModel // empty' "$STATE_FILE")
primary_planner_model=$(jq -r '.tasks["HOK-9999"].plannerModel // empty' "$STATE_FILE")
primary_reviewer_model=$(jq -r '.tasks["HOK-9999"].reviewerModel // empty' "$STATE_FILE")
primary_plan_depth=$(jq -r '.tasks["HOK-9999"].planDepth // empty' "$STATE_FILE")
primary_code_depth=$(jq -r '.tasks["HOK-9999"].codeDepth // empty' "$STATE_FILE")
primary_review_mode=$(jq -r '.tasks["HOK-9999"].reviewMode // empty' "$STATE_FILE")
primary_challenge_stage=$(jq -r '.tasks["HOK-9999"].challengeStage // empty' "$STATE_FILE")

challenger_challenge_model=$(jq -r '.tasks["HOK-9999_c"].challengeModel // empty' "$STATE_FILE")
challenger_coder_model=$(jq -r '.tasks["HOK-9999_c"].coderModel // empty' "$STATE_FILE")
challenger_planner_model=$(jq -r '.tasks["HOK-9999_c"].plannerModel // empty' "$STATE_FILE")
challenger_reviewer_model=$(jq -r '.tasks["HOK-9999_c"].reviewerModel // empty' "$STATE_FILE")
challenger_plan_depth=$(jq -r '.tasks["HOK-9999_c"].planDepth // empty' "$STATE_FILE")
challenger_code_depth=$(jq -r '.tasks["HOK-9999_c"].codeDepth // empty' "$STATE_FILE")
challenger_review_mode=$(jq -r '.tasks["HOK-9999_c"].reviewMode // empty' "$STATE_FILE")
challenger_challenge_stage=$(jq -r '.tasks["HOK-9999_c"].challengeStage // empty' "$STATE_FILE")

check_eq "primary challengeModel set to refreshed primary model" "gpt-5.4" "$primary_challenge_model"
check_eq "primary coderModel aligned with refreshed primary model" "gpt-5.4" "$primary_coder_model"
check_eq "primary plannerModel set from refreshed entry" "gpt-5.5" "$primary_planner_model"
check_eq "primary reviewerModel set from refreshed entry" "gpt-5.5" "$primary_reviewer_model"
check_eq "primary planDepth set from refreshed entry" "deep" "$primary_plan_depth"
check_eq "primary codeDepth set from refreshed entry" "deep" "$primary_code_depth"
check_eq "primary reviewMode set from refreshed entry" "static" "$primary_review_mode"
check_eq "primary challengeStage repaired during refresh" "implementation" "$primary_challenge_stage"

check_eq "challenger challengeModel set to refreshed challenger model" "claude-sonnet-4-6" "$challenger_challenge_model"
check_eq "challenger coderModel aligned with refreshed challenger model" "claude-sonnet-4-6" "$challenger_coder_model"
check_eq "challenger plannerModel set from refreshed entry" "claude-sonnet-4-6" "$challenger_planner_model"
check_eq "challenger reviewerModel set from refreshed entry" "claude-sonnet-4-6" "$challenger_reviewer_model"
check_eq "challenger planDepth set from refreshed entry" "deep" "$challenger_plan_depth"
check_eq "challenger codeDepth set from refreshed entry" "deep" "$challenger_code_depth"
check_eq "challenger reviewMode set from refreshed entry" "static+llm" "$challenger_review_mode"
check_eq "challenger challengeStage repaired during refresh" "implementation" "$challenger_challenge_stage"

# Guard: challenger model must differ from primary (cannot be gpt-5.4 vs gpt-5.4)
if [[ "$primary_challenge_model" != "$challenger_challenge_model" ]]; then
  pass "expanded refresh does not collapse to same-model comparison"
else
  echo "    primary: $primary_challenge_model  challenger: $challenger_challenge_model (should differ)"
  fail "expanded refresh collapsed to same-model comparison"
fi

# Defensive: missing entries[1].model must not clobber challenger state
STATE_FILE_GUARD="$TEST_TMP/state-guard.json"
cp "$STATE_FILE" "$STATE_FILE_GUARD"

MISSING_MODEL_PLAN='{"decisionSource":"expanded","entries":[
  {"model":"gpt-5.4","planner":"gpt-5.5","reviewer":"gpt-5.5","planDepth":"deep","codeDepth":"deep","reviewMode":"static","key":"HOK-9999"},
  {"planner":"claude-sonnet-4-6","key":"HOK-9999_c"}
]}'

bash -lc '
  set -euo pipefail
  source "$3/shared/lib/wavemill-common.sh"
  STATE_FILE="$1"
  PLAN="$2"
  log() { :; }
  log_warn() { :; }
  save_task_state() { :; }

  new_challenger_key=$(echo "$PLAN" | jq -r ".entries[1].key // empty" 2>/dev/null)
  new_challenger_model=$(echo "$PLAN" | jq -r ".entries[1].model // empty" 2>/dev/null)
  if [[ -n "$new_challenger_key" ]] && [[ -n "$new_challenger_model" ]]; then
    echo "SHOULD_NOT_SAVE"
  else
    echo "GUARD_OK"
  fi
' bash "$STATE_FILE_GUARD" "$MISSING_MODEL_PLAN" "$REPO_DIR" | grep -q "GUARD_OK" \
  && pass "missing entries[1].model does not trigger challenger save" \
  || fail "missing entries[1].model incorrectly triggered challenger save"

echo ""
echo "=== HOK-2811: Review-stage deferral (Arbiter P2.4a) ==="

# The startup Phase 5 block must gate FINAL_LAUNCH_ARGS challenger append on
# defer_challenger, and record the pending arm when deferring.
MILL_REVIEW_BLOCK="$(awk '
  /HOK-2811: Review-stage challenges defer the challenger to a fork trigger/ { capture=1 }
  capture { print }
  /challenge_arms_record_pending "\$ISSUE"/ && capture { print; exit }
' "$MILL_SCRIPT")"

check_contains "startup gates FINAL_LAUNCH_ARGS challenger on defer" "$MILL_REVIEW_BLOCK" 'if [[ "$defer_challenger" != "true" ]]; then
      FINAL_LAUNCH_ARGS+=("$challenger_key|$challenger_slug|$TITLE")'
check_contains "startup records pending arm when deferring" "$MILL_REVIEW_BLOCK" 'challenge_arms_record_pending "$ISSUE"'
check_contains "startup uses challenge_arm_json_build" "$MILL_REVIEW_BLOCK" 'challenge_arm_json_build'

# The monitor's launch_task defers on review-stage as well.
MONITOR_LAUNCH_BLOCK="$(awk '
  /HOK-2811: Review-stage challenges defer the challenger to a fork trigger/ { capture=1 }
  capture { print }
  /should_launch_challenger="false"/ && capture { exit }
' "$MONITOR_SCRIPT_FILE")"

check_contains "monitor sets defer_challenger for review stage" "$MONITOR_LAUNCH_BLOCK" 'if [[ "$challenge_stage" == "review" ]]; then'

MONITOR_STATE_BLOCK="$(awk '
  /HOK-2811: Review-stage — record the challenger as a pending arm/ { capture=1 }
  capture { print }
  /persist_challenge_execution_intent "\$issue" "\$challenger_key" \\/ && capture { exit }
' "$MONITOR_SCRIPT_FILE")"

check_contains "monitor records pending arm on defer" "$MONITOR_STATE_BLOCK" 'challenge_arms_record_pending "$issue"'

# The materialiser and fork-trigger functions exist.
if grep -q '^challenge_materialize_challenger_arm() {' "$MONITOR_SCRIPT_FILE"; then
  pass "challenge_materialize_challenger_arm() defined"
else
  fail "challenge_materialize_challenger_arm() defined"
fi

if grep -q '^challenge_maybe_materialize_deferred_arms() {' "$MONITOR_SCRIPT_FILE"; then
  pass "challenge_maybe_materialize_deferred_arms() defined"
else
  fail "challenge_maybe_materialize_deferred_arms() defined"
fi

# Fork descriptor writer must exist and be documented as seal-exempt.
if grep -q '^challenge_intent_stamp_fork_descriptor() {' "$MONITOR_SCRIPT_FILE"; then
  pass "challenge_intent_stamp_fork_descriptor() defined"
else
  fail "challenge_intent_stamp_fork_descriptor() defined"
fi

# Trigger site: the coding→review transition must call the fork trigger.
if grep -q 'challenge_maybe_materialize_deferred_arms "\$ISSUE" "\$SLUG"' "$MONITOR_SCRIPT_FILE"; then
  pass "fork trigger called from monitor_issue_state"
else
  fail "fork trigger called from monitor_issue_state"
fi

echo ""
echo "--- Results: $PASS passed, $FAIL failed ---"

if (( FAIL > 0 )); then
  exit 1
fi
