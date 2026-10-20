#!/usr/bin/env bash
# Schema-validated workflow-state fixtures for shell tests (HOK-3223).
#
# Shell twin of tests/lib/task-builder.ts: every row goes through the same
# builder (via tests/lib/bin/build-fixture-task.ts), so a fixture can only
# carry fields that shared/schemas/workflow-task.schema.json declares. A
# hand-written "tasks": { ... } literal is rejected by the preflight guard
# tools/check-test-task-literals.ts.
#
# Usage:
#   source "$REPO_DIR/tests/lib/state-fixtures.sh"
#
#   fixture_task [--bare] <task-id> [field=value | field:=json ...]
#       Print one compact JSON map {"<task-id>": {...}} on stdout.
#
#   fixture_workflow_state <state-file> [--bare] <task-id> [field=value ...] [-- <task-id> ...]
#       Write the tasks into <state-file>: created as {"tasks": {...}} when
#       missing, otherwise merged into the existing .tasks (same-id rows are
#       replaced). With no task ids, writes/keeps an empty {"tasks": {}}.
#
#   fixture_real_state_accessors
#       Define the production read_state_value, get_task_meta, state_mutate
#       and task_state_mutate_existing (extracted from shared/lib), replacing
#       any test stubs. They read and write $STATE_FILE, so point it at a
#       mkdtemp state file seeded with fixture_workflow_state.
#
# Field values: `field=value` is typed by the schema (string fields keep the
# raw text, so pr=9999 stays the string save_task_state writes; boolean,
# number, object and array fields parse it as JSON). `field:=json` is always
# JSON (pr:=1230 for a numeric PR). Each row starts from the default
# save_task_state row (slug/branch/worktree/pr "", status active, phase
# planning); --bare starts from an empty row.

STATE_FIXTURES_REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# fixture_task [--bare] <task-id> [field=value | field:=json ...] [-- <task-id> ...]
fixture_task() {
  node --experimental-strip-types --no-warnings \
    "$STATE_FIXTURES_REPO_DIR/tests/lib/bin/build-fixture-task.ts" "$@"
}

# fixture_workflow_state <state-file> [--bare] [<task-id> [field=value ...] [-- <task-id> ...]]
fixture_workflow_state() {
  local state_file="${1:?fixture_workflow_state requires a state file}"
  shift
  local tasks_json='{}'
  if (( $# > 0 )) && ! { (( $# == 1 )) && [[ "$1" == "--bare" ]]; }; then
    tasks_json="$(fixture_task "$@")" || return 1
  fi
  mkdir -p "$(dirname "$state_file")"
  local tmp_file="${state_file}.fixture.$$"
  if [[ -s "$state_file" ]]; then
    jq -c --argjson tasks "$tasks_json" '.tasks = ((.tasks // {}) + $tasks)' "$state_file" > "$tmp_file" || {
      rm -f "$tmp_file"
      echo "fixture_workflow_state: $state_file is not valid JSON" >&2
      return 1
    }
  else
    jq -cn --argjson tasks "$tasks_json" '{tasks: $tasks}' > "$tmp_file"
  fi
  mv "$tmp_file" "$state_file"
}

# Print the definition of function <name> from <file> (brace-depth capture,
# quotes stripped so braces inside jq strings do not end it early).
_state_fixtures_extract_function() {
  local source_file="$1" function_name="$2"
  awk -v name="$function_name" '
    function brace_delta(line, stripped, opens, closes) {
      stripped = line
      gsub(/"([^"\\]|\\.)*"/, "\"\"", stripped)
      gsub(/\047([^\047\\]|\\.)*\047/, "\047\047", stripped)
      opens = gsub(/\{/, "{", stripped)
      closes = gsub(/\}/, "}", stripped)
      return opens - closes
    }
    $0 ~ "^" name "\\(\\)[[:space:]]*\\{" { capture = 1; depth = 0 }
    capture { print; depth += brace_delta($0); if (depth == 0) exit }
  ' "$source_file"
}

# fixture_real_state_accessors
fixture_real_state_accessors() {
  local common="$STATE_FIXTURES_REPO_DIR/shared/lib/wavemill-common.sh"
  local monitor="$STATE_FIXTURES_REPO_DIR/shared/lib/wavemill-monitor.sh"
  local spec file name body
  for spec in \
    "$common:state_mutate" \
    "$common:get_task_meta" \
    "$common:task_state_mutate_existing" \
    "$monitor:read_state_value"; do
    file="${spec%:*}"
    name="${spec##*:}"
    body="$(_state_fixtures_extract_function "$file" "$name")"
    if [[ -z "$body" ]]; then
      echo "fixture_real_state_accessors: could not extract $name from $file" >&2
      return 1
    fi
    eval "$body"
  done
}
