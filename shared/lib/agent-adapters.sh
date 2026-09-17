#!/opt/homebrew/bin/bash
# Agent Adapter Library
# Abstracts agent-specific launch patterns so the orchestrator and mill
# scripts don't need to know how each agent CLI works.
#
# Adding a new agent: add a case block in each function below.
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$script_dir/routing-emitter.sh"

agent_tmux_target() {
  local session="$1" window="$2"
  [[ -n "$window" ]] || return 1
  case "$window" in
    @*|*:*) printf '%s\n' "$window" ;;
    *) printf '%s:%s\n' "$session" "$window" ;;
  esac
}

agent_repo_env_bootstrap_command() {
  local repo_dir="$1"
  local env_file="$repo_dir/.env"
  [[ -f "$env_file" ]] || return 0
  printf 'set -a; source %q; set +a\n' "$env_file"
}

agent_hydrate_repo_env_in_pane() {
  local target="$1" repo_dir="$2"
  local bootstrap_cmd
  bootstrap_cmd="$(agent_repo_env_bootstrap_command "$repo_dir")"
  [[ -n "$bootstrap_cmd" ]] || return 0
  tmux send-keys -t "$target" "$bootstrap_cmd" C-m
}

# Print shell exports that place Wavemill's execution-time tmux guard ahead of
# PATH for an agent process and every nested script it launches.
agent_tmux_guard_export_command() {
  local target="$1" session="$2" issue="$3" agent_cmd="$4"
  local adapter_dir guard_dir real_tmux control_socket
  local guard_dir_q real_tmux_q control_socket_q session_q issue_q agent_q

  adapter_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  guard_dir="${adapter_dir%/lib}/agent-bin"
  [[ -x "$guard_dir/tmux" ]] || {
    echo "Error: Wavemill tmux guard is not executable: $guard_dir/tmux" >&2
    return 1
  }
  real_tmux="$(type -P tmux 2>/dev/null || true)"
  [[ -n "$real_tmux" ]] || {
    echo "Error: real tmux executable not found" >&2
    return 1
  }
  control_socket="$(tmux display-message -p -t "$target" '#{socket_path}' 2>/dev/null || true)"
  if [[ -z "$control_socket" ]]; then
    control_socket="${TMUX:-}"
    control_socket="${control_socket%%,*}"
  fi

  printf -v guard_dir_q '%q' "$guard_dir"
  printf -v real_tmux_q '%q' "$real_tmux"
  printf -v control_socket_q '%q' "$control_socket"
  printf -v session_q '%q' "$session"
  printf -v issue_q '%q' "$issue"
  printf -v agent_q '%q' "$agent_cmd"
  printf 'export WAVEMILL_REAL_TMUX=%s WAVEMILL_CONTROL_TMUX_SOCKET=%s WAVEMILL_SESSION=%s WAVEMILL_ISSUE=%s WAVEMILL_AGENT=%s; export PATH=%s:"$PATH";' \
    "$real_tmux_q" "$control_socket_q" "$session_q" "$issue_q" "$agent_q" "$guard_dir_q"
}

agent_send_tmux_guarded_command() {
  local target="$1" command_text="$2" guard_exports="$3"
  tmux send-keys -t "$target" -l -- "$guard_exports $command_text"
  tmux send-keys -t "$target" C-m
}

agent_normalize_linear_issue_id() {
  local issue="${1:-}" candidate="${2:-}"
  candidate="${candidate#"${candidate%%[![:space:]]*}"}"
  candidate="${candidate%"${candidate##*[![:space:]]}"}"

  if [[ "$issue" =~ ^([A-Z][A-Z0-9]*-[0-9]+)_c$ ]]; then
    local base_issue="${BASH_REMATCH[1]}"
    if [[ "$candidate" != "$base_issue" ]]; then
      printf '%s\n' "$base_issue"
      return 0
    fi
  fi
  if [[ "$candidate" =~ ^[A-Z][A-Z0-9]*-[0-9]+$ ]]; then
    printf '%s\n' "$candidate"
    return 0
  fi
  if [[ "$candidate" =~ ^https?://linear\.app/[^/]+/issue/[A-Z][A-Z0-9]*-[0-9]+([/?#].*)?$ ]]; then
    local linear_url_path="${candidate#*://linear.app/}"
    linear_url_path="${linear_url_path#*/issue/}"
    printf '%s\n' "${linear_url_path%%[/?#]*}"
    return 0
  fi
  printf '%s\n' "$issue"
}

# ============================================================================
# AGENT RESOLUTION
# ============================================================================

# Resolve the agent CLI command for a given model ID and phase using the
# shared TypeScript resolver. AGENT_CMD is not allowed to override the result.
# Args: $1 = model ID, $2 = phase (planning|coding|review)
# Prints: agent command name (e.g. "claude", "codex")
AGENT_RESOLVE_LAST_DIAGNOSTIC=""
AGENT_RESOLVE_LAST_BATCH_JSON=""

agent_resolve_from_model() {
  local model="$1"
  local phase="$2"
  local repo_dir="${REPO_DIR:-$(pwd)}"
  local tools_dir="${TOOLS_DIR:-$(agent_wavemill_tools_dir)}"
  local resolver_tool="$tools_dir/resolve-model-agent.ts"
  local stderr_file="" json_output="" agent="" diagnostic=""
  AGENT_RESOLVE_LAST_DIAGNOSTIC=""

  if [[ -z "$model" ]]; then
    AGENT_RESOLVE_LAST_DIAGNOSTIC="[agent-resolution] model=(empty) phase=${phase:-unknown} provider=unknown reason=invalid-model-id certification=invalid-model-id certify=\"unavailable\""
    echo "$AGENT_RESOLVE_LAST_DIAGNOSTIC" >&2
    return 1
  fi
  if [[ ! "$model" =~ ^[A-Za-z0-9._/-]+(\[[A-Za-z0-9._-]+\])?$ ]]; then
    AGENT_RESOLVE_LAST_DIAGNOSTIC="[agent-resolution] model=$model phase=${phase:-unknown} provider=unknown reason=invalid-model-id certification=invalid-model-id certify=\"unavailable\""
    echo "$AGENT_RESOLVE_LAST_DIAGNOSTIC" >&2
    return 1
  fi
  case "$phase" in
    planning|coding|review) ;;
    *)
      AGENT_RESOLVE_LAST_DIAGNOSTIC="[agent-resolution] model=$model phase=${phase:-unknown} provider=unknown reason=invalid-model-id certification=invalid-phase certify=\"unavailable\""
      echo "$AGENT_RESOLVE_LAST_DIAGNOSTIC" >&2
      return 1
      ;;
  esac
  if ! command -v jq >/dev/null 2>&1; then
    AGENT_RESOLVE_LAST_DIAGNOSTIC="[agent-resolution] model=$model phase=$phase provider=unknown reason=invalid-model-id certification=missing-jq certify=\"unavailable\""
    echo "$AGENT_RESOLVE_LAST_DIAGNOSTIC" >&2
    return 1
  fi
  if ! agent_model_helper_available; then
    AGENT_RESOLVE_LAST_DIAGNOSTIC="[agent-resolution] model=$model phase=$phase provider=unknown reason=invalid-model-id certification=missing-tsx certify=\"unavailable\""
    echo "$AGENT_RESOLVE_LAST_DIAGNOSTIC" >&2
    return 1
  fi

  stderr_file="$(mktemp "${TMPDIR:-/tmp}/agent-resolve-stderr.XXXXXX")" || {
    AGENT_RESOLVE_LAST_DIAGNOSTIC="[agent-resolution] model=$model phase=$phase provider=unknown reason=invalid-model-id certification=mktemp-failed certify=\"unavailable\""
    echo "$AGENT_RESOLVE_LAST_DIAGNOSTIC" >&2
    return 1
  }

  json_output="$(cd "$repo_dir" 2>/dev/null && agent_run_tsx_tool "$resolver_tool" --model "$model" --phase "$phase" --repo "$repo_dir" 2>"$stderr_file")"
  local rc=$?
  if [[ -s "$stderr_file" ]]; then
    diagnostic="$(cat "$stderr_file")"
  fi
  rm -f "$stderr_file"

  if [[ "$rc" -ne 0 ]]; then
    AGENT_RESOLVE_LAST_DIAGNOSTIC="${diagnostic:-[agent-resolution] model=$model phase=$phase provider=unknown reason=unknown-model certification=resolver-failed certify=\"unavailable\"}"
    [[ -n "$diagnostic" ]] || echo "$AGENT_RESOLVE_LAST_DIAGNOSTIC" >&2
    [[ -n "$diagnostic" ]] && echo "$diagnostic" >&2
    return 1
  fi

  if [[ -z "$json_output" ]] || ! agent="$(printf '%s' "$json_output" | jq -er '.agent')" 2>/dev/null; then
    diagnostic="$(printf '%s' "$json_output" | jq -r '.diagnostic // empty' 2>/dev/null || true)"
    AGENT_RESOLVE_LAST_DIAGNOSTIC="${diagnostic:-[agent-resolution] model=$model phase=$phase provider=unknown reason=unknown-model certification=malformed-json certify=\"unavailable\"}"
    echo "$AGENT_RESOLVE_LAST_DIAGNOSTIC" >&2
    return 1
  fi

  printf '%s\n' "$agent"
}

# Resolve planner/coder/reviewer agents with a single resolver spawn.
# Args: $1 = planner model, $2 = coder model, $3 = reviewer model
# Prints nothing. Successful role resolutions are available via
# agent_resolve_batch_agent_for_role <planner|coder|reviewer>.
agent_resolve_models_for_roles() {
  local planner_model="${1:-}"
  local coder_model="${2:-}"
  local reviewer_model="${3:-}"
  local repo_dir="${REPO_DIR:-$(pwd)}"
  local tools_dir="${TOOLS_DIR:-$(agent_wavemill_tools_dir)}"
  local resolver_tool="$tools_dir/resolve-model-agent.ts"
  local stderr_file="" json_output="" diagnostic=""
  local -a resolver_args=()
  AGENT_RESOLVE_LAST_DIAGNOSTIC=""
  AGENT_RESOLVE_LAST_BATCH_JSON='{"ok":true,"results":{}}'

  if [[ -z "$planner_model" && -z "$coder_model" && -z "$reviewer_model" ]]; then
    return 0
  fi
  if ! command -v jq >/dev/null 2>&1; then
    AGENT_RESOLVE_LAST_DIAGNOSTIC="[agent-resolution] model=batch phase=mixed provider=unknown reason=invalid-model-id certification=missing-jq certify=\"unavailable\""
    echo "$AGENT_RESOLVE_LAST_DIAGNOSTIC" >&2
    return 1
  fi
  if ! agent_model_helper_available; then
    AGENT_RESOLVE_LAST_DIAGNOSTIC="[agent-resolution] model=batch phase=mixed provider=unknown reason=invalid-model-id certification=missing-tsx certify=\"unavailable\""
    echo "$AGENT_RESOLVE_LAST_DIAGNOSTIC" >&2
    return 1
  fi

  [[ -n "$planner_model" ]] && resolver_args+=(--planner "$planner_model")
  [[ -n "$coder_model" ]] && resolver_args+=(--coder "$coder_model")
  [[ -n "$reviewer_model" ]] && resolver_args+=(--reviewer "$reviewer_model")
  resolver_args+=(--repo "$repo_dir")

  stderr_file="$(mktemp "${TMPDIR:-/tmp}/agent-resolve-batch-stderr.XXXXXX")" || {
    AGENT_RESOLVE_LAST_DIAGNOSTIC="[agent-resolution] model=batch phase=mixed provider=unknown reason=invalid-model-id certification=mktemp-failed certify=\"unavailable\""
    echo "$AGENT_RESOLVE_LAST_DIAGNOSTIC" >&2
    return 1
  }

  json_output="$(cd "$repo_dir" 2>/dev/null && agent_run_tsx_tool "$resolver_tool" "${resolver_args[@]}" 2>"$stderr_file")"
  local rc=$?
  if [[ -s "$stderr_file" ]]; then
    diagnostic="$(cat "$stderr_file")"
  fi
  rm -f "$stderr_file"

  if [[ -z "$json_output" ]] || ! printf '%s' "$json_output" | jq -e '.results | type == "object"' >/dev/null 2>&1; then
    AGENT_RESOLVE_LAST_DIAGNOSTIC="${diagnostic:-[agent-resolution] model=batch phase=mixed provider=unknown reason=unknown-model certification=malformed-json certify=\"unavailable\"}"
    echo "$AGENT_RESOLVE_LAST_DIAGNOSTIC" >&2
    return 1
  fi

  AGENT_RESOLVE_LAST_BATCH_JSON="$json_output"
  if [[ "$rc" -ne 0 ]]; then
    AGENT_RESOLVE_LAST_DIAGNOSTIC="${diagnostic:-[agent-resolution] model=batch phase=mixed provider=unknown reason=unknown-model certification=resolver-failed certify=\"unavailable\"}"
    [[ -n "$diagnostic" ]] || echo "$AGENT_RESOLVE_LAST_DIAGNOSTIC" >&2
    [[ -n "$diagnostic" ]] && echo "$diagnostic" >&2
    return 1
  fi

  return 0
}

agent_resolve_batch_agent_for_role() {
  local role="$1"
  local json="${2:-$AGENT_RESOLVE_LAST_BATCH_JSON}"
  if [[ -z "$json" ]] || ! command -v jq >/dev/null 2>&1; then
    return 0
  fi
  printf '%s' "$json" | jq -er --arg role "$role" '
    .results[$role] | if .ok == true then .agent else empty end
  ' 2>/dev/null || true
}

# Resolve the underlying binary for a given agent kind.
# Provider shims run the 'claude' binary with provider env overrides.
agent_binary_for_cmd() {
  local cmd="$1"
  case "$cmd" in
    claude-deepseek) echo "claude" ;;
    claude-openrouter) echo "claude" ;;
    *) echo "$cmd" ;;
  esac
}

# ============================================================================
# MODEL VALIDATION
# ============================================================================

# Validate a model selector token accepted by the shared resolver.
# Args: $1 = selector token, $2 = repo directory (optional)
# Returns: 0 if valid, 1 if invalid (prints error to stderr)
# Note: Uses TOOLS_DIR when set, otherwise infers paths from the repo argument.
agent_validate_model() {
  local model="$1"
  local repo_dir="${2:-$(pwd)}"

  # Convert to absolute path
  repo_dir="$(cd "$repo_dir" 2>/dev/null && pwd || echo "$repo_dir")"

  # Derive lib directory from TOOLS_DIR (TOOLS_DIR = <install>/tools,
  # LIB_DIR = <install>/shared/lib), falling back to this file's own location
  # when the adapter is sourced directly. Both point into the wavemill
  # installation, never into the repo being worked on.
  local tools_dir="${TOOLS_DIR:-$(agent_wavemill_tools_dir)}"
  local lib_dir="${tools_dir%/tools}/shared/lib"
  local validator="model-validator.ts"
  local validation_stderr

  if ! agent_model_helper_available; then
    echo "error: model validation requires tsx or npx -- install Node.js tooling to use model selectors" >&2
    return 1
  fi

  # Call TypeScript validator (cd to lib_dir first for imports to work)
  # Exits 0 if valid, 1 if invalid with error message
  validation_stderr="$(mktemp "${TMPDIR:-/tmp}/model-validator-stderr.XXXXXX")" || return 1
  if (cd "$lib_dir" && agent_run_tsx_tool "$validator" --selector-token "$model" "$repo_dir" > /dev/null 2>"$validation_stderr"); then
    if grep -Eqi 'tsx: not available|tsx not found|npx: tsx not found' "$validation_stderr"; then
      cat "$validation_stderr" >&2
      rm -f "$validation_stderr"
      return 1
    fi
    rm -f "$validation_stderr"
    return 0
  else
    cat "$validation_stderr" >&2
    rm -f "$validation_stderr"
    return 1
  fi
}

agent_resolve_model() {
  local role="$1"
  local model="$2"
  local repo_dir="${3:-$(pwd)}"
  local resolved_model=""

  repo_dir="$(cd "$repo_dir" 2>/dev/null && pwd || echo "$repo_dir")"

  local tools_dir="${TOOLS_DIR:-$(agent_wavemill_tools_dir)}"
  local lib_dir="${tools_dir%/tools}/shared/lib"
  local validator="model-validator.ts"

  if ! agent_model_helper_available; then
    echo "error: model resolution requires tsx or npx -- install Node.js tooling to use model selectors" >&2
    return 1
  fi

  if resolved_model="$(cd "$lib_dir" 2>/dev/null && agent_run_tsx_tool "$validator" --resolve-selector-token "$model" --role "$role" "$repo_dir" 2>/dev/null)"; then
    printf '%s\n' "$resolved_model"
    return 0
  fi

  return 1
}

agent_model_looks_like_depth_tag() {
  local model="$1"
  case "$model" in
    light|medium|deep|standard|fast)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

agent_default_model_for_cmd() {
  local agent_cmd="$1"
  case "$agent_cmd" in
    codex) echo "gpt-5.6-terra" ;;
    claude) echo "claude-sonnet-5" ;;
    claude-deepseek) echo "deepseek-v4-flash" ;;
    claude-openrouter) echo "" ;;
    *) echo "" ;;
  esac
}

agent_openrouter_direct_disabled_message() {
  echo "Error: direct OpenRouter agents are temporarily disabled; they currently route through Claude Code." >&2
}

agent_hooks_dir() {
  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  echo "${script_dir%/lib}/hooks"
}

# Wavemill's own tools/ directory, resolved from this file's location.
#
# This is deliberately NOT derived from the target repo or from TOOLS_DIR.
# Mill runs against consumer repos that have no tools/ of their own, and
# wavemill-mill.sh historically defaulted TOOLS_DIR to "$REPO_DIR/tools",
# so both sources point at a directory that does not exist once wavemill
# drives any repo other than itself.
agent_wavemill_tools_dir() {
  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  echo "${script_dir%/shared/lib}/tools"
}

# Absolute path to the native launcher for a phase.
#
# Native launchers import ../shared/lib/native-agent/*, so a copy placed
# inside a consumer repo cannot resolve its own imports. The installation
# copy is the only one that can ever run — resolve it, never $repo_dir.
agent_native_launcher_path() {
  local phase="$1"
  local tools_dir
  tools_dir="$(agent_wavemill_tools_dir)"
  case "$phase" in
    planning) echo "$tools_dir/launch-native-planning.ts" ;;
    coding)   echo "$tools_dir/launch-native-coding.ts" ;;
    review)   echo "$tools_dir/launch-native-review.ts" ;;
    *)
      echo "agent_native_launcher_path: unknown phase '$phase'" >&2
      return 1
      ;;
  esac
}

agent_runtime_resource_selection_enabled() {
  local repo_dir="$1"
  local surface="$2"

  # Runtime resource selection is disabled by default in config.ts. Keep the
  # shell path aligned so baseline prompt rendering does not depend on npx/tsx.
  # Reads through wavemill_load_config so .wavemill-config.local.json overrides
  # take effect.
  if ! declare -F wavemill_load_config >/dev/null 2>&1; then
    return 1
  fi

  if command -v jq >/dev/null 2>&1; then
    wavemill_load_config "$repo_dir" | jq -e --arg surface "$surface" '
      (.resources.runtimeSelection.enabled == true)
      and (.resources.runtimeSelection.surfaces[$surface].enabled != false)
    ' >/dev/null 2>&1
    return $?
  fi

  # If jq is unavailable, preserve the previous behavior and let the resolver
  # make the policy decision.
  return 0
}

agent_run_tsx_tool() {
  local tool="$1"
  shift

  if node --import tsx -e "" >/dev/null 2>&1; then
    node --import tsx "$tool" "$@"
  elif command -v tsx >/dev/null 2>&1; then
    tsx "$tool" "$@"
  else
    npx tsx "$tool" "$@"
  fi
}

agent_model_helper_available() {
  node --import tsx -e "" >/dev/null 2>&1 && return 0
  if command -v tsx >/dev/null 2>&1; then
    tsx --version >/dev/null 2>&1
    return $?
  fi
  if command -v npx >/dev/null 2>&1; then
    npx tsx --version >/dev/null 2>&1
    return $?
  fi
  return 1
}

agent_native_planning_eligible() {
  local repo_dir="${1:-${REPO_DIR:-$(pwd)}}"
  local phase="${2:-${WAVEMILL_PHASE:-planning}}"
  local model=""

  [[ "$phase" == "planning" ]] || return 1
  agent_model_helper_available || return 1

  model="$(cd "$repo_dir" 2>/dev/null && agent_run_tsx_tool "tools/check-native-eligibility.ts" "$repo_dir" "$phase" 2>/dev/null)" || return 1
  [[ -n "$model" ]] || return 1

  AGENT_NATIVE_PLANNING_MODEL="$model"
  return 0
}

agent_is_native_cmd() {
  case "${1:-}" in
    native-openai|native-openrouter)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

agent_phase_from_role() {
  case "${1:-}" in
    planner|planning)
      printf '%s\n' "planning"
      ;;
    reviewer|review|reviewing)
      printf '%s\n' "review"
      ;;
    coder|coding)
      printf '%s\n' "coding"
      ;;
    *)
      return 1
      ;;
  esac
}

agent_role_from_phase() {
  case "${1:-}" in
    planning)
      printf '%s\n' "planner"
      ;;
    coding)
      printf '%s\n' "coder"
      ;;
    review)
      printf '%s\n' "reviewer"
      ;;
    *)
      return 1
      ;;
  esac
}

agent_normalize_phase_token() {
  case "${1:-}" in
    planning|planner|plan)
      printf '%s\n' "planning"
      ;;
    coding|coder|implementation)
      printf '%s\n' "coding"
      ;;
    review|reviewer|reviewing)
      printf '%s\n' "review"
      ;;
    *planning-prompt*|*planning_prompt*)
      printf '%s\n' "planning"
      ;;
    *coding-prompt*|*coding_prompt*)
      printf '%s\n' "coding"
      ;;
    *review-prompt*|*review_prompt*)
      printf '%s\n' "review"
      ;;
    *)
      return 1
      ;;
  esac
}

agent_normalize_launch_phase() {
  local token phase
  for token in "$@"; do
    [[ -n "${token:-}" ]] || continue
    if phase="$(agent_normalize_phase_token "$token" 2>/dev/null)"; then
      printf '%s\n' "$phase"
      return 0
    fi
  done
  return 1
}

AGENT_NATIVE_LAUNCH_LAST_JSON=""
AGENT_NATIVE_LAUNCH_LAST_REASON=""

agent_native_launch_probe() {
  local cmd="$1"
  local phase="$2"
  local model="$3"
  local repo_dir="${4:-${REPO_DIR:-$(pwd)}}"
  local tool="${TOOLS_DIR:-$(agent_wavemill_tools_dir)}/check-native-agent-launch.ts"
  local output=""

  AGENT_NATIVE_LAUNCH_LAST_JSON=""
  AGENT_NATIVE_LAUNCH_LAST_REASON=""

  if ! agent_is_native_cmd "$cmd"; then
    AGENT_NATIVE_LAUNCH_LAST_REASON="error: non-native agent '$cmd' passed to native launch probe"
    echo "$AGENT_NATIVE_LAUNCH_LAST_REASON" >&2
    return 1
  fi

  if [[ ! -f "$tool" ]]; then
    AGENT_NATIVE_LAUNCH_LAST_REASON="error: native launch probe is unavailable ($tool)"
    echo "$AGENT_NATIVE_LAUNCH_LAST_REASON" >&2
    return 1
  fi

  if ! output="$(cd "$repo_dir" 2>/dev/null && agent_run_tsx_tool "$tool" --repo-dir "$repo_dir" --phase "$phase" --agent "$cmd" --model "$model" 2>/dev/null)"; then
    AGENT_NATIVE_LAUNCH_LAST_REASON="error: native launch probe failed for $cmd/$phase/$model"
    if [[ -n "$output" ]]; then
      AGENT_NATIVE_LAUNCH_LAST_JSON="$output"
      if command -v jq >/dev/null 2>&1 && printf '%s' "$output" | jq -e '.ok == false' >/dev/null 2>&1; then
        AGENT_NATIVE_LAUNCH_LAST_REASON="$(printf '%s' "$output" | jq -r '.reason // "native launch probe rejected the route"' 2>/dev/null)"
      else
        AGENT_NATIVE_LAUNCH_LAST_REASON="$output"
      fi
    fi
    echo "$AGENT_NATIVE_LAUNCH_LAST_REASON" >&2
    return 1
  fi

  if ! command -v jq >/dev/null 2>&1; then
    AGENT_NATIVE_LAUNCH_LAST_REASON="error: jq is required to validate native launch probes"
    echo "$AGENT_NATIVE_LAUNCH_LAST_REASON" >&2
    return 1
  fi

  AGENT_NATIVE_LAUNCH_LAST_JSON="$output"
  if [[ "$(printf '%s' "$output" | jq -r '.ok // "false"' 2>/dev/null)" != "true" ]]; then
    AGENT_NATIVE_LAUNCH_LAST_REASON="$(printf '%s' "$output" | jq -r '.reason // "native launch probe rejected the route"' 2>/dev/null)"
    echo "$AGENT_NATIVE_LAUNCH_LAST_REASON" >&2
    return 1
  fi

  return 0
}

agent_native_launch_preflight() {
  local route_id="$1"
  local cmd="$2"
  local phase="$3"
  local model="${4:-}"
  local repo_dir="${5:-${REPO_DIR:-$(pwd)}}"
  local provider="unknown"

  agent_is_native_cmd "$cmd" || return 0
  case "$cmd" in
    native-openai) provider="openai" ;;
    native-openrouter) provider="openrouter" ;;
  esac
  [[ -n "$route_id" ]] || route_id="$cmd/${phase:-unknown}/${model:-unknown}"

  if [[ -z "$phase" ]]; then
    echo "Error: native launch preflight failed: route=$route_id stage=(empty) agent=$cmd provider=$provider model=${model:-'(empty)'} reason=unsupported-native-stage" >&2
    return 1
  fi
  if [[ -z "$model" ]]; then
    echo "Error: native launch preflight failed: route=$route_id stage=$phase agent=$cmd provider=$provider model=(empty) reason=missing-model" >&2
    return 1
  fi

  if agent_validate_phase_launch "$cmd" "$phase" "$model" "$repo_dir"; then
    return 0
  fi

  local reason="${AGENT_NATIVE_LAUNCH_LAST_REASON:-native launch probe rejected the route}"
  local json="${AGENT_NATIVE_LAUNCH_LAST_JSON:-}"
  local code="" surface="" remediation="" alias="" provider_id=""
  if [[ -n "$json" ]] && command -v jq >/dev/null 2>&1 && printf '%s' "$json" | jq -e '.ok == false' >/dev/null 2>&1; then
    code="$(printf '%s' "$json" | jq -r '.code // empty' 2>/dev/null || true)"
    surface="$(printf '%s' "$json" | jq -r '.surface // empty' 2>/dev/null || true)"
    remediation="$(printf '%s' "$json" | jq -r '.remediation // empty' 2>/dev/null || true)"
    alias="$(printf '%s' "$json" | jq -r '.wavemillAlias // empty' 2>/dev/null || true)"
    provider_id="$(printf '%s' "$json" | jq -r '.openrouterId // empty' 2>/dev/null || true)"
  fi

  local message="Error: native launch preflight failed: route=$route_id stage=$phase agent=$cmd provider=$provider model=$model"
  [[ -n "$alias" ]] && message+=" alias=$alias"
  [[ -n "$provider_id" ]] && message+=" providerId=$provider_id"
  [[ -n "$code" ]] && message+=" code=$code"
  [[ -n "$surface" ]] && message+=" surface=$surface"
  message+=" reason=$reason"
  [[ -n "$remediation" ]] && message+=" remediation=\"$remediation\""
  echo "$message" >&2
  return 1
}

agent_validate_phase_launch() {
  local cmd="$1"
  local phase="$2"
  local model="${3:-}"
  local repo_dir="${4:-${REPO_DIR:-$(pwd)}}"

  if agent_is_native_cmd "$cmd"; then
    agent_native_launch_probe "$cmd" "$phase" "$model" "$repo_dir"
    return $?
  fi

  agent_validate "$cmd"
}


agent_model_is_deepseek() {
  local model="${1:-}"
  [[ "$model" == deepseek-* ]]
}

agent_model_is_openrouter() {
  local model="${1:-}"
  case "$model" in
    qwen-*|kimi-*|llama-*|mistral-*|devstral-*|grok-*|gemini-2.5-*|gemini-2.0-*|mimo-*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

agent_json_get() {
  local json_input="$1"
  local field="$2"

  JSON_INPUT="$json_input" node -e '
    const data = JSON.parse(process.env.JSON_INPUT || "{}");
    const path = process.argv[1].split(".");
    let current = data;
    for (const part of path) {
      current = current?.[part];
    }
    if (Array.isArray(current)) {
      process.stdout.write(current.join(","));
    } else if (current === undefined || current === null) {
      process.stdout.write("");
    } else {
      process.stdout.write(String(current));
    }
  ' "$field"
}

agent_deepseek_config() {
  local repo_dir="${1:-${REPO_DIR:-$(pwd)}}"
  local tools_dir="${TOOLS_DIR:-$(agent_wavemill_tools_dir)}"
  local lib_dir="${tools_dir%/tools}/shared/lib"

  (
    cd "$lib_dir" &&
    agent_run_tsx_tool "deepseek-provider.ts" config-json "$repo_dir"
  )
}

agent_openrouter_config() {
  local repo_dir="${1:-${REPO_DIR:-$(pwd)}}"
  local tools_dir="${TOOLS_DIR:-$(agent_wavemill_tools_dir)}"
  local lib_dir="${tools_dir%/tools}/shared/lib"

  (
    cd "$lib_dir" &&
    agent_run_tsx_tool "openrouter-provider.ts" config-json "$repo_dir"
  )
}

agent_deepseek_state_dir() {
  local repo_dir="$1"
  local session="$2"
  local issue="$3"
  local run_key=""

  if [[ -n "${WAVEMILL_RUN_DIR:-}" ]]; then
    printf '%s\n' "${WAVEMILL_RUN_DIR%/}/providers/deepseek"
    return 0
  fi

  run_key="${issue:-$session}"
  if [[ -z "$run_key" ]]; then
    run_key="standalone"
  fi

  run_key="${run_key//\//-}"
  printf '%s\n' "$repo_dir/.wavemill/runs/$run_key/providers/deepseek"
}

agent_validate_deepseek_launch() {
  local model="$1"
  local repo_dir="${2:-${REPO_DIR:-$(pwd)}}"
  local provider_json api_key_env enabled has_api_key

  agent_model_is_deepseek "$model" || return 0

  provider_json="$(agent_deepseek_config "$repo_dir")" || {
    echo "Error: failed to load DeepSeek provider config" >&2
    return 1
  }
  enabled="$(agent_json_get "$provider_json" enabled)"
  api_key_env="$(agent_json_get "$provider_json" apiKeyEnv)"
  has_api_key="$(agent_json_get "$provider_json" hasApiKey)"

  if [[ "$enabled" != "true" ]]; then
    echo "Error: DeepSeek model '$model' requires providers.deepseek.enabled=true" >&2
    return 1
  fi

  if [[ "$has_api_key" != "true" ]]; then
    echo "Error: DeepSeek model '$model' requires ${api_key_env:-DEEPSEEK_API_KEY} to be set" >&2
    return 1
  fi

  return 0
}

agent_resolve_dashboard_pid() {
  local session="${1:-}"

  if [[ -n "${WAVEMILL_DASHBOARD_PID:-}" ]]; then
    printf '%s\n' "$WAVEMILL_DASHBOARD_PID"
    return 0
  fi

  [[ -n "$session" ]] || return 0
  { tmux show-environment -t "$session" WAVEMILL_DASHBOARD_PID 2>/dev/null || true; } \
    | sed -n 's/^WAVEMILL_DASHBOARD_PID=//p' \
    | head -1
}

agent_write_initial_status() {
  local session="$1"
  local issue="$2"
  [[ -n "$session" && -n "$issue" ]] || return 0
  printf '%s\n' "working" > "/tmp/${session}-${issue}-status.txt"
}

agent_supersede_terminal_hook() {
  local session="$1" issue="$2" feature_dir="${3:-}"
  local hooks_dir
  [[ -n "$session" && -n "$issue" ]] || return 0
  hooks_dir="$(agent_hooks_dir)"
  [[ -f "$hooks_dir/wavemill-hook-protocol.sh" ]] || return 0
  # shellcheck source=/dev/null
  source "$hooks_dir/wavemill-hook-protocol.sh" 2>/dev/null || return 0
  declare -F wavemill_hook_supersede >/dev/null 2>&1 || return 0
  WAVEMILL_SESSION="$session" WAVEMILL_ISSUE="$issue" WAVEMILL_FEATURE_DIR="$feature_dir" \
    wavemill_hook_supersede "$session" "$issue" "replacement_process_started" || true
}

# ============================================================================
# AGENT VALIDATION
# ============================================================================

# Check that the agent CLI binary is available on PATH.
# Args: $1 = agent command name (e.g. "claude", "codex", "claude-deepseek")
# Returns: 0 if found, 1 if not
agent_validate() {
  local cmd="$1"
  local binary
  case "$cmd" in
    claude-openrouter)
      agent_openrouter_direct_disabled_message
      return 1
      ;;
    native-openai|native-openrouter)
      return 0
      ;;
  esac
  binary="$(agent_binary_for_cmd "$cmd")"
  command -v "$binary" >/dev/null 2>&1
}

# Internal: validate DEEPSEEK_API_KEY (or configured apiKeyEnv) for claude-deepseek.
# Args: $1 = repo_dir
# Returns: 0 if key present, 1 if missing
_agent_check_deepseek_api_key() {
  local repo_dir="${1:-$(pwd)}"
  local provider_json api_key_env key_value

  provider_json="$(agent_deepseek_config "$repo_dir" 2>/dev/null)" || {
    # Fallback: read DEEPSEEK_API_KEY directly
    if [[ -z "${DEEPSEEK_API_KEY:-}" ]]; then
      echo "Error: DEEPSEEK_API_KEY is not set. Set it before launching a claude-deepseek agent." >&2
      return 1
    fi
    return 0
  }

  api_key_env="$(agent_json_get "$provider_json" apiKeyEnv)"
  api_key_env="${api_key_env:-DEEPSEEK_API_KEY}"

  # Use nameref-safe indirect expansion
  key_value="${!api_key_env:-}"
  if [[ -z "$key_value" ]]; then
    echo "Error: ${api_key_env} is not set. Set it before launching a claude-deepseek agent." >&2
    return 1
  fi
  return 0
}

# Internal: validate OPENROUTER_API_KEY (or configured apiKeyEnv) for claude-openrouter.
# Args: $1 = repo_dir
# Returns: 0 if key present, 1 if missing
_agent_check_openrouter_api_key() {
  local repo_dir="${1:-$(pwd)}"
  local provider_json api_key_env has_api_key

  provider_json="$(agent_openrouter_config "$repo_dir" 2>/dev/null)" || {
    if [[ -z "${OPENROUTER_API_KEY:-}" ]]; then
      echo "Error: OPENROUTER_API_KEY is not set. Set it before launching a claude-openrouter agent." >&2
      return 1
    fi
    return 0
  }

  api_key_env="$(agent_json_get "$provider_json" apiKeyEnv)"
  api_key_env="${api_key_env:-OPENROUTER_API_KEY}"
  has_api_key="$(agent_json_get "$provider_json" hasApiKey)"

  if [[ "$has_api_key" != "true" ]]; then
    echo "Error: ${api_key_env} is not set. Set it before launching a claude-openrouter agent." >&2
    return 1
  fi
  return 0
}

# Check if agent is authenticated and ready to use.
# Args: $1 = agent command name (e.g. "claude", "codex", "claude-deepseek")
# Returns: 0 if authenticated, 1 if not authenticated
# Output: Error message to stderr if not authenticated
# Note: Results are cached per-process to avoid redundant checks.
# Bash 3.2 lacks associative arrays, so keep a flat-string fallback.
if declare -A _AGENT_AUTH_CACHE 2>/dev/null; then
  _AGENT_AUTH_CACHE_ASSOC=1
  _AGENT_AUTH_CACHE_FLAT=""
else
  _AGENT_AUTH_CACHE_ASSOC=0
  _AGENT_AUTH_CACHE_FLAT=""
fi

agent_auth_cache_get() {
  local key="$1"
  local cached_key cached_value

  if [[ "${_AGENT_AUTH_CACHE_ASSOC:-0}" == "1" ]]; then
    if [[ -n "${_AGENT_AUTH_CACHE[$key]+set}" ]]; then
      printf '%s\n' "${_AGENT_AUTH_CACHE[$key]}"
      return 0
    fi
    return 1
  fi

  while IFS=$'\t' read -r cached_key cached_value; do
    [[ "$cached_key" == "$key" ]] || continue
    printf '%s\n' "$cached_value"
    return 0
  done <<<"${_AGENT_AUTH_CACHE_FLAT:-}"

  return 1
}

agent_auth_cache_set() {
  local key="$1" value="$2"
  local cached_key cached_value found=0 updated=""

  if [[ "${_AGENT_AUTH_CACHE_ASSOC:-0}" == "1" ]]; then
    _AGENT_AUTH_CACHE["$key"]="$value"
    return 0
  fi

  while IFS=$'\t' read -r cached_key cached_value; do
    [[ -n "$cached_key" ]] || continue
    if [[ "$cached_key" == "$key" ]]; then
      updated+="${key}"$'\t'"${value}"$'\n'
      found=1
    else
      updated+="${cached_key}"$'\t'"${cached_value}"$'\n'
    fi
  done <<<"${_AGENT_AUTH_CACHE_FLAT:-}"

  if [[ "$found" -eq 0 ]]; then
    updated+="${key}"$'\t'"${value}"$'\n'
  fi

  _AGENT_AUTH_CACHE_FLAT="$updated"
}

agent_check_auth() {
  local cmd="$1"
  local model="${2:-}"
  local repo_dir="${3:-${REPO_DIR:-$(pwd)}}"
  local cache_key="$cmd"

  if agent_model_is_deepseek "$model"; then
    cache_key="$cmd:$model:$repo_dir"
  fi
  if agent_model_is_openrouter "$model"; then
    cache_key="$cmd:$model:$repo_dir"
  fi

  # Return cached result if available (valid for this process lifetime)
  local cached_rc
  if cached_rc="$(agent_auth_cache_get "$cache_key")"; then
    return "$cached_rc"
  fi

  case "$cmd" in
    native-openai|native-openrouter)
      agent_auth_cache_set "$cache_key" 0
      return 0
      ;;
    claude-deepseek)
      # claude-deepseek uses the claude binary + DeepSeek env; validate DEEPSEEK_API_KEY
      if ! _agent_check_deepseek_api_key "$repo_dir"; then
        agent_auth_cache_set "$cache_key" 1
        return 1
      fi
      ;;
    claude-openrouter)
      agent_openrouter_direct_disabled_message
      agent_auth_cache_set "$cache_key" 1
      return 1
      ;;
    claude)
      if agent_model_is_deepseek "$model"; then
        if ! agent_validate_deepseek_launch "$model" "$repo_dir"; then
          agent_auth_cache_set "$cache_key" 1
          return 1
        fi
        agent_auth_cache_set "$cache_key" 0
        return 0
      fi
      # Use 'claude auth status' which exits 0 when logged in
      if ! claude auth status >/dev/null 2>&1; then
        echo "Error: Claude authentication required. Run: claude auth login" >&2
        agent_auth_cache_set "$cache_key" 1
        return 1
      fi
      ;;
    codex)
      # Check for auth file existence and non-empty (fast path)
      local auth_file="$HOME/.codex/auth.json"
      if [[ ! -s "$auth_file" ]]; then
        echo "Error: Codex authentication required. Run: codex login" >&2
        agent_auth_cache_set "$cache_key" 1
        return 1
      fi
      ;;
    *)
      # Unknown agent - assume authenticated (don't block unknown agents)
      agent_auth_cache_set "$cache_key" 0
      return 0
      ;;
  esac

  agent_auth_cache_set "$cache_key" 0
  return 0
}

# ============================================================================
# PROMPT BUILDERS
# ============================================================================
# Single source of truth for agent prompts. Used by both
# wavemill-orchestrator.sh (initial batch) and launch_task() (monitor loop).

agent_exit_followup_text() {
  local agent_cmd="${1:-claude}"

  # Agent-agnostic: the orchestrator detects session end via pane state (HOK-1177)
  echo "Stop working. The orchestrator will handle cleanup."
}

agent_abort_feedback_text() {
  local agent_cmd="${1:-claude}" marker_path="$2"

  # Agent-agnostic: create the abort marker; orchestrator detects it (HOK-1177)
  echo "create $marker_path and stop working. The orchestrator will handle cleanup."
}

agent_exit_guard_text() {
  local agent_cmd="${1:-claude}" condition_text="$2"

  # Agent-agnostic: focus on artifact completion, not exit semantics (HOK-1177)
  echo "stop working until $condition_text"
}

agent_completion_text() {
  local agent_cmd="${1:-claude}" suffix="${2:-}"

  # Agent-agnostic: orchestrator handles termination detection (HOK-1177)
  if [[ -n "$suffix" ]]; then
    echo "stop working. The orchestrator will detect completion and proceed. $suffix"
  else
    echo "stop working. The orchestrator will detect completion and proceed."
  fi
}

agent_rubric_snippet() {
  local tools_dir="$1"
  local snippet_file="$tools_dir/prompts/agent-rubric-snippet.md"
  if [[ -f "$snippet_file" ]]; then
    cat "$snippet_file"
    return 0
  fi
  return 1
}

agent_runtime_resource_repo_dir() {
  local tools_dir="$1"
  local root="${tools_dir%/tools}"

  if [[ -d "$root" ]]; then
    (cd "$root" && pwd)
  else
    printf '%s\n' "$root"
  fi
}

# Build the interactive (planning-mode) prompt.
#
# Args (positional):
#   $1 = title
#   $2 = issue
#   $3 = wt_dir
#   $4 = branch
#   $5 = base_branch
#   $6 = issue_context
#   $7 = status_file
#   $8 = tools_dir
#   $9 = slug
# Prints: the complete prompt to stdout
build_interactive_prompt() {
  local title="$1" issue="$2" wt_dir="$3" branch="$4" base_branch="$5"
  local issue_context="$6" status_file="$7" tools_dir="$8" slug="$9"
  local feature_dir="$wt_dir/features/$slug"
  local selected_task_path="$feature_dir/selected-task.json"
  local plan_path="$feature_dir/plan.md"

  cat <<_WVML_PROMPT_
You are working on: $title ($issue)

Repo worktree: $wt_dir
Branch: $branch
Base branch: $base_branch

$issue_context
---

## Status Reporting
Throughout your work, periodically update your status by running:
  echo '<short description of what you are doing right now>' > $status_file
Keep it under 50 chars. Update it at each major step (e.g. "reading codebase", "implementing auth handler", "running tests", "creating PR"). This feeds the Wavemill dashboard so the user can see your progress.

## Your Workflow

You have THREE phases. Do them in order.

### Phase 1: Planning (interactive)
Task context is pre-seeded at: $selected_task_path

1. Read the task context
2. Research the codebase to understand relevant code and patterns
3. Create a detailed implementation plan with phases
4. Save the plan to: $plan_path
5. Present the plan summary to the user and wait for approval

Do NOT proceed to Phase 2 until the user has approved the plan.
Do NOT create any approval marker files — the orchestrator handles plan approval.
If anything is unclear about the requirements, ask the user for clarification before finalizing the plan.

### Phase 2: Implementation
After plan approval:
1. Execute the plan phase by phase
2. Run tests/lint between phases — pause if anything fails

### Phase 3: Self-Review & PR
After implementation is complete and tests/lint pass, you MUST run the self-review tool.
This is a REQUIRED step — do not skip it or substitute your own review.

1. Run the self-review tool (up to 3 iterations):
   IMPORTANT: Run from your current directory (the worktree). Do NOT change directories.
   IMPORTANT: This tool calls the Claude API and takes 2-5 minutes. Configure your tool's built-in timeout (for Claude Code's Bash tool: \`timeout: 600000\` — 600000 ms = 10 minutes) so the call is not killed at the default cap. Do NOT prefix the command with the external \`timeout\` binary — it is not installed by default on macOS and will fail with \`command not found: timeout\`.
   npx tsx $tools_dir/review-changes.ts $base_branch --json
   - Exit code 0 = review passed → proceed to step 3
   - Exit code 1 = issues found → fix blockers and re-run (step 2)
   - Exit code 2 = error → log comprehensive diagnostics, record the final verdict as error, and proceed to step 3 without readiness certification
   The output is structured JSON with verdict, codeReviewFindings, and uiFindings.

   When exit code 2 occurs, you MUST log the following diagnostics to help debug the failure:
   \`\`\`
   ⚠️  Review tool failed with exit code 2

   Diagnostics:
   - Command: npx tsx $tools_dir/review-changes.ts $base_branch --json
   - Working directory: \$(pwd)
   - Tool path: $tools_dir/review-changes.ts
   - Tool exists: \$(ls -lh $tools_dir/review-changes.ts 2>&1 || echo "NOT FOUND")
   - Git root: \$(git rev-parse --show-toplevel 2>&1)
   - Current branch: \$(git rev-parse --abbrev-ref HEAD 2>&1)
   - Base branch exists: \$(git rev-parse --verify $base_branch 2>&1 || echo "NOT FOUND")
   - STDERR output: [paste the actual stderr from the failed command]

   Proceeding to PR creation without wm:ready per instructions.
   \`\`\`
   This diagnostic information is CRITICAL for debugging recurring tool failures.

2. For each iteration where issues are found:
   - Read the review JSON output carefully
   - Fix all blockers (severity: blocker) and straightforward warnings
   - Make targeted fixes only — do not refactor unrelated code
   - Run the review scope guard immediately before committing:
     npx tsx $tools_dir/check-review-scope.ts --repo-dir .
   - If the guard exits 1, preserve the index, report the violation, and stop review-fix committing/PR progression. No review commit may be created until the guard passes.
   - If the guard exits 2, scope could not be verified (tool/git failure — infrastructure, not a violation): capture the guard's stderr, note "review scope unverified (infrastructure)" in the commit message body and PR body, and proceed with the commit. Do not treat exit 2 as a scope violation.
   - If the guard exits 3, scope passed but no PR exists yet for this branch (the normal pre-PR state, not a violation): proceed exactly as for exit 0.
   - Commit fixes: git commit -m "fix: Address self-review findings (iteration N)"
   - Re-run the review tool (step 1)

3. Create a PR using GitHub CLI with a descriptive title and body:
   gh pr create --title "$issue: <concise summary>" --body "<PR body>"
   The PR body MUST include:
   - A "## Summary" section with 2-4 bullet points describing what changed and why
   - A "## Changes" section listing the key files/modules modified
   - A "## Test plan" section describing how the changes were validated
   - A "## Self-review" section noting the review verdict and iterations run
   Do NOT use --fill. Write the PR body as a HEREDOC if needed for formatting.
4. Link the PR to $issue

Success criteria:
- [ ] Implementation matches plan and issue requirements
- [ ] Lint/tests pass
- [ ] Self-review tool executed (npx tsx $tools_dir/review-changes.ts)
- [ ] No regressions
- [ ] PR created with descriptive summary linked to $issue

### Phase 4: Review & Respond
After creating the PR:
1. Present a brief summary of what was implemented and any decisions you made
2. Remain available — the user may have questions, want changes, or need you to address CI failures
3. If asked to make changes, push them to the same branch to update the PR
4. Do NOT exit until the user confirms they are done

Start with Phase 1 now. Read the task context and begin researching.
_WVML_PROMPT_
}

# Build the routing phase prompt.
# This phase determines which models to use for planning/coding/review.
#
# Args (positional):
#   $1 = title
#   $2 = issue
#   $3 = wt_dir
#   $4 = branch
#   $5 = base_branch
#   $6 = issue_context
#   $7 = status_file
#   $8 = tools_dir
#   $9 = slug
# Prints: the complete prompt to stdout
build_routing_prompt() {
  local title="$1" issue="$2" wt_dir="$3" branch="$4" base_branch="$5"
  local issue_context="$6" status_file="$7" tools_dir="$8" slug="$9"
  local feature_dir="$wt_dir/features/$slug"
  local selected_task_path="$feature_dir/selected-task.json"
  local routing_path="$feature_dir/.routing-complete"

  cat <<_WVML_PROMPT_
You are working on: $title ($issue)

Repo worktree: $wt_dir
Branch: $branch
Base branch: $base_branch

$issue_context
---

## Status Reporting
Throughout your work, periodically update your status by running:
  echo '<short description of what you are doing right now>' > $status_file
Keep it under 50 chars. Update it at each major step.

## Your Task: Workflow Routing

You are in the **ROUTING PHASE** of a multi-phase workflow. Your job is to:

1. Analyze the task requirements
2. Determine the optimal model for each workflow phase:
   - **Planner**: Model for creating the implementation plan
   - **Coder**: Model for implementing the feature/fix
   - **Reviewer**: Model for self-review and PR creation
3. Recommend the workflow depth/mode for each phase

### Steps

1. Read the task context above and understand the requirements
2. Run the routing tool to get recommendations:
   npx tsx $tools_dir/route-task.ts --json --file "$selected_task_path" --repo-dir "$wt_dir"

3. Save the routing results to $routing_path as JSON:
   {
     "planner": "gpt-5.6-terra",
     "coder": "gpt-5.6-terra",
     "reviewer": "gpt-5.6-terra",
     "planDepth": "light",
     "codeDepth": "medium",
     "reviewMode": "static"
   }

4. Report completion with a brief summary of the routing decisions

### Success Criteria
- [ ] Routing tool executed successfully
- [ ] Results saved to $routing_path
- [ ] JSON is valid and contains all required fields

### Important Notes
- Use the routing tool's recommendations directly - don't override them
- If the routing tool fails, use sensible defaults:
  - planner: gpt-5.6-terra
  - coder: gpt-5.6-terra
  - reviewer: gpt-5.6-terra
  - planDepth: light
  - codeDepth: medium
  - reviewMode: static

After completing the routing, your work is done. The next phase (planning) will be launched automatically.
_WVML_PROMPT_
}

# Build the planning phase prompt.
# This phase expands the task packet and creates an implementation plan.
#
# Args (positional):
#   $1 = title
#   $2 = issue
#   $3 = wt_dir
#   $4 = branch
#   $5 = base_branch
#   $6 = issue_context
#   $7 = status_file
#   $8 = tools_dir
#   $9 = slug
#   $10 = plan_depth
#   $11 = agent_cmd
#   $12 = operating_mode
# Prints: the complete prompt to stdout
build_planning_prompt() {
  local title="$1" issue="$2" wt_dir="$3" branch="$4" base_branch="$5"
  local issue_context="$6" status_file="$7" tools_dir="$8" slug="$9"
  local plan_depth="${10:-light}" agent_cmd="${11:-claude}" operating_mode="${12:-normal}"
  local feature_dir="$wt_dir/features/$slug"
  local routing_repo_dir="${REPO_DIR:-$wt_dir}"
  local task_context_path="$feature_dir/selected-task.json"
  local plan_path="$feature_dir/plan.md"
  local rubric_snippet=""
  local abort_feedback_instruction exit_guard_text approved_completion_text
  abort_feedback_instruction="$(agent_abort_feedback_text "$agent_cmd" "$feature_dir/.workflow-aborted")"
  exit_guard_text="$(agent_exit_guard_text "$agent_cmd" "the user has explicitly approved your plan")"
  approved_completion_text="$(agent_completion_text "$agent_cmd" "The next phase will be launched automatically.")"

  # Build depth-specific guidance
  local depth_guidance
  if [[ "$plan_depth" == "deep" ]]; then
    depth_guidance="- Create a comprehensive, detailed plan with substeps
- Research multiple approaches and justify your choice
- Document all architectural decisions
- Include detailed test scenarios"
  elif [[ "$plan_depth" == "medium" ]]; then
    depth_guidance="- Create a moderately detailed plan with clear substeps
- Research the primary approach and note relevant alternatives
- Document the key architectural decisions
- Include test coverage for the main paths and likely edge cases"
  else
    depth_guidance="- Create a concise plan focused on the critical path
- Document key decisions and approach
- Include basic test coverage"
  fi

  local plan_mode_guidance=""
  case "$operating_mode" in
    constrained)
      plan_mode_guidance="## ⚠️  CONSTRAINED MODE

Scope the plan conservatively:
- Prefer phased plans where Phase 1 is a standalone shippable unit.
- Flag any step that touches more than 10 files as a stretch goal."
      ;;
    survival)
      plan_mode_guidance="## ⚠️  SURVIVAL MODE

Scope the plan to the minimum viable change:
- Plan for at most 5 files changed.
- Prefer a single narrow implementation phase plus validation.
- Explicitly mark non-critical follow-up work as deferred."
      ;;
  esac

  # Load template and fill placeholders
  local template_file="$tools_dir/prompts/planning-phase.md"
  local template_content
  local resolver_tool="$tools_dir/resolve-runtime-resource.ts"
  local resource_repo_dir
  resource_repo_dir="$(agent_runtime_resource_repo_dir "$tools_dir")"
  if [[ -f "$resolver_tool" ]] && agent_runtime_resource_selection_enabled "$resource_repo_dir" "planner"; then
    local resolved_json
    if resolved_json="$(agent_run_tsx_tool "$resolver_tool" --surface planner --repo-dir "$resource_repo_dir" --json 2>/dev/null)" \
      && template_content="$(printf '%s' "$resolved_json" | jq -er '.content')" ; then
      :
    else
      echo "[warn] Failed to resolve planner runtime resource, falling back to $template_file" >&2
      template_content=""
    fi
  fi
  if [[ -z "${template_content:-}" && -f "$template_file" ]]; then
    template_content=$(cat "$template_file")
  fi
  if [[ -n "${template_content:-}" ]]; then
    template_content="${template_content//\{\{PLAN_DEPTH\}\}/$plan_depth}"
    template_content="${template_content//\{\{SLUG\}\}/$slug}"
    template_content="${template_content//\{\{TOOLS_DIR\}\}/$tools_dir}"
    template_content="${template_content//\{\{ISSUE\}\}/$issue}"
    template_content="${template_content//\{\{WT_DIR\}\}/$wt_dir}"
    template_content="${template_content//\{\{ROUTER_REPO_DIR\}\}/$routing_repo_dir}"
    template_content="${template_content//\{\{FEATURE_DIR\}\}/$feature_dir}"
    template_content="${template_content//\{\{TASK_CONTEXT_PATH\}\}/$task_context_path}"
    template_content="${template_content//\{\{PLAN_PATH\}\}/$plan_path}"
    template_content="${template_content//\{\{DEPTH_GUIDANCE\}\}/$depth_guidance}"
    template_content="${template_content//\{\{PLAN_MODE_GUIDANCE\}\}/$plan_mode_guidance}"
  elif [[ ! -f "$template_file" ]]; then
    template_content="[ERROR: Planning template not found at $template_file]"
  fi
  if ! rubric_snippet="$(agent_rubric_snippet "$tools_dir")"; then
    rubric_snippet=""
  fi

  cat <<_WVML_PROMPT_
You are working on: $title ($issue)

Repo worktree: $wt_dir
Branch: $branch
Base branch: $base_branch

$issue_context
---

## Status Reporting
Throughout your work, periodically update your status by running:
  echo '<short description of what you are doing right now>' > $status_file
Keep it under 50 chars. Update it at each major step.

$rubric_snippet

$template_content

### IMPORTANT: Handling User Feedback During This Phase

You may receive text feedback from the user while you are working on this phase.
User feedback is GUIDANCE to improve your approach — it is NOT a signal to complete the phase.

When you receive user feedback:
- DO: Read and incorporate the feedback into your ongoing work
- DO: Adjust your approach based on the guidance
- DO: Continue working until the phase requirements are genuinely complete
- DO: If the user asks to stop, abort, close the issue, or discontinue work, $abort_feedback_instruction
- DO NOT: Interpret feedback as "wrap up now" or "move to next phase"
- DO NOT: Create the phase completion marker if the user wants to stop
- DO: After the user explicitly approves, create the approval marker: touch "$feature_dir/.plan-approved"
- DO NOT: $exit_guard_text
- DO NOT: Edit any files outside of $feature_dir/
- DO NOT: Create git commits with source code changes
- DO NOT: Start implementing the plan before or after approval

After the user approves your plan, create "$feature_dir/.plan-approved" and then $approved_completion_text
_WVML_PROMPT_
}

# Build the coding phase prompt.
# This phase executes the implementation plan.
#
# Args (positional):
#   $1 = title
#   $2 = issue
#   $3 = wt_dir
#   $4 = branch
#   $5 = base_branch
#   $6 = issue_context
#   $7 = status_file
#   $8 = tools_dir
#   $9 = slug
#   $10 = code_depth
#   $11 = agent_cmd
#   $12 = operating_mode
# Prints: the complete prompt to stdout
build_coding_prompt() {
  local title="$1" issue="$2" wt_dir="$3" branch="$4" base_branch="$5"
  local issue_context="$6" status_file="$7" tools_dir="$8" slug="$9"
  local code_depth="${10:-medium}" agent_cmd="${11:-claude}" operating_mode="${12:-normal}"
  local feature_dir="$wt_dir/features/$slug"
  local plan_path="$feature_dir/plan.md"
  local rubric_snippet=""
  local abort_feedback_instruction exit_guard_text coding_completion_text
  abort_feedback_instruction="$(agent_abort_feedback_text "$agent_cmd" "$feature_dir/.workflow-aborted")"
  exit_guard_text="$(agent_exit_guard_text "$agent_cmd" "ALL phase requirements are met")"
  coding_completion_text="$(agent_completion_text "$agent_cmd" "The next phase will be launched automatically.")"

  # Build depth-specific guidance
  local depth_guidance
  if [[ "$code_depth" == "deep" ]]; then
    depth_guidance="- Implement comprehensive error handling
- Add extensive test coverage
- Consider edge cases and performance
- Add detailed inline documentation"
  elif [[ "$code_depth" == "light" ]]; then
    depth_guidance="- Focus on the happy path
- Basic error handling only
- Minimal test coverage"
  else
    depth_guidance="- Implement core functionality with good error handling
- Add reasonable test coverage
- Handle common edge cases"
  fi

  local mode_guidance=""
  case "$operating_mode" in
    constrained)
      mode_guidance="## ⚠️  CONSTRAINED MODE (quota degrading)

Apply tighter scope to conserve model capacity:
- Limit changes to files directly required by the plan (aim for 10 files or fewer).
- Commit after each plan phase before moving to the next phase.
- Run tests/lint after each plan phase, not just at the end.
- If a phase grows beyond the stated scope, stop at the safest checkpoint and document the remaining work in your commit message."
      ;;
    survival)
      mode_guidance="## ⚠️  SURVIVAL MODE (quota exhausted)

Apply minimal scope. A focused small PR is better than a large incomplete one:
- Limit changes to at most 5 files. If more are needed, implement only the critical path and document deferrals.
- Commit after every 1-2 file changes; do not batch large edit sets.
- Run tests/lint after every commit to catch regressions early.
- Scope is reduced here, so the confidence you record in the completion marker matters more than usual:
  prefer '\"confidence\":\"low\"' whenever correctness is uncertain even after validation, so review scrutinizes it."
      ;;
  esac

  # Load template and fill placeholders
  local template_file="$tools_dir/prompts/coding-phase.md"
  local template_content
  if [[ -f "$template_file" ]]; then
    template_content=$(cat "$template_file")
    template_content="${template_content//\{\{CODE_DEPTH\}\}/$code_depth}"
    template_content="${template_content//\{\{SLUG\}\}/$slug}"
    template_content="${template_content//\{\{FEATURE_DIR\}\}/$feature_dir}"
    template_content="${template_content//\{\{PLAN_PATH\}\}/$plan_path}"
    template_content="${template_content//\{\{DEPTH_GUIDANCE\}\}/$depth_guidance}"
    template_content="${template_content//\{\{MODE_GUIDANCE\}\}/$mode_guidance}"
  else
    template_content="[ERROR: Coding template not found at $template_file]"
  fi
  if ! rubric_snippet="$(agent_rubric_snippet "$tools_dir")"; then
    rubric_snippet=""
  fi

  cat <<_WVML_PROMPT_
You are working on: $title ($issue)

Repo worktree: $wt_dir
Branch: $branch
Base branch: $base_branch

$issue_context
---

## Status Reporting
Throughout your work, periodically update your status by running:
  echo '<short description of what you are doing right now>' > $status_file
Keep it under 50 chars. Update it at each major step.

$rubric_snippet

$template_content

### IMPORTANT: Handling User Feedback During This Phase

You may receive text feedback from the user while you are working on this phase.
User feedback is GUIDANCE to improve your approach — it is NOT a signal to complete the phase.

When you receive user feedback:
- DO: Read and incorporate the feedback into your ongoing work
- DO: Adjust your approach based on the guidance
- DO: Continue working until the phase requirements are genuinely complete
- DO: If the user asks to stop, abort, close the issue, or discontinue work, $abort_feedback_instruction
- DO NOT: Interpret feedback as "wrap up now" or "move to next phase"
- DO NOT: Create the phase completion marker if the user wants to stop
- DO NOT: Create .coding-complete just because you received feedback
- DO NOT: $exit_guard_text
- DO NOT: Create a PR or run gh pr create
- DO NOT: Run the self-review tool

### Pre-Completion Checklist

Before creating .coding-complete, verify ALL of these are true:
- All phases from plan.md are implemented
- All tests pass (run the test/lint commands)
- No compilation errors
- Changes are committed to git
If ANY item is false, continue working. Do NOT create the marker.

### When Verification Is Blocked

Write "$feature_dir/.coding-blocked-completion.json" only when ALL of these are true:
- Scoped implementation is complete.
- Relevant changes are committed.
- Targeted/scoped verification passed.
- Remaining verification blockers are clearly unrelated, pre-existing, or environmental.
- You are not comfortable creating .coding-complete.

Use this compact JSON shape:

    {
      "stage": "coding",
      "implementationComplete": true,
      "committed": true,
      "commit": "abc1234",
      "passingChecks": ["targeted test command"],
      "blockingChecks": ["repo-level command that failed"],
      "blockingReason": "baseline_tests_failing",
      "evidence": "Short summary of why the failure is unrelated.",
      "recommendedAction": "advance_to_review"
    }

Allowed agent-facing blockingReason values: repo_verification_blocked, environment_blocked, baseline_tests_failing.
The recommendedAction for review handoff is advance_to_review.

.coding-complete remains the preferred signal when full verification passes. The blocked-completion artifact is not a substitute for incomplete implementation, uncommitted work, or skipped scoped verification.

After implementation is complete and tests pass, create "$feature_dir/.coding-complete", then $coding_completion_text
_WVML_PROMPT_
}

# Build a narrow prompt for automatic merge-conflict resolution in an existing PR worktree.
#
# Args:
#   $1 = pr_number
#   $2 = branch
#   $3 = wt_dir
#   $4 = status_file
#   $5 = base_branch
build_conflict_resolution_prompt() {
  local pr_number="$1" branch="$2" wt_dir="$3" status_file="$4" base_branch="${5:-main}"

  cat <<_WVML_PROMPT_
You are resolving merge conflicts for open PR #$pr_number.

Repo worktree: $wt_dir
Branch: $branch
Base branch: $base_branch

Scope:
- Resolve merge conflicts only.
- Do not do new feature work or refactors unless strictly required to complete the merge.
- Preserve the existing branch intent.

Status Reporting:
Throughout your work, periodically update your status by running:
  echo '<short description of what you are doing right now>' > $status_file
Keep it under 50 chars. Update it at each major step.

Required process:
1. Inspect the current branch state and conflict state.
2. Fetch the latest base branch:
   git fetch origin $base_branch
3. Merge the base branch into the current branch:
   git merge origin/$base_branch
4. Resolve conflicts with the smallest safe changes possible.
5. Run relevant validation for touched code. At minimum, run lint and typecheck if available.
6. Commit the conflict resolution with this exact message:
   fix: Resolve merge conflicts with $base_branch
7. Push the branch to update PR #$pr_number.

Failure handling:
- If you cannot resolve the conflicts safely, stop without broad code changes.
- Leave a clear explanation of the blocker in your final response.
- Do not create markers or a PR. Workflow automation will handle follow-up.
_WVML_PROMPT_
}

# Build a narrow prompt for automatic remediation of a fixable ready-check failure.
#
# Args:
#   $1 = pr_number
#   $2 = branch
#   $3 = wt_dir
#   $4 = status_file
#   $5 = base_branch
#   $6 = attempt_number
#   $7 = max_attempts
#   $8 = failed_checks_summary
#   $9 = ready_result_path
build_ready_remediation_prompt() {
  local pr_number="$1" branch="$2" wt_dir="$3" status_file="$4" base_branch="${5:-main}"
  local attempt_number="$6" max_attempts="$7" failed_checks_summary="$8" ready_result_path="$9"

  cat <<_WVML_PROMPT_
You are remediating a ready-check failure for open PR #$pr_number.

Repo worktree: $wt_dir
Branch: $branch
Base branch: $base_branch
Attempt: $attempt_number/$max_attempts
Failing checks: $failed_checks_summary
Ready result JSON: $ready_result_path

Scope:
- Fix only the ready-check failure.
- Keep changes narrow and directly tied to the failing CI signal.
- Do not do broad refactors or unrelated cleanup.

Status Reporting:
Throughout your work, periodically update your status by running:
  echo '<short description of what you are doing right now>' > $status_file
Keep it under 50 chars. Update it at each major step.

Required process:
1. Inspect the PR checks:
   gh pr checks $pr_number
2. Inspect the failing workflow logs:
   gh run list -L 1 --branch $branch
   gh run view --log-failed
3. Reproduce the failure locally by running the exact failing test or lint command from the repo.
4. Fix the problem with the smallest safe code change.
5. Run relevant validation for the touched code.
6. Commit with this exact message:
   fix: Resolve ready-check failure (attempt $attempt_number/$max_attempts)
7. Push the branch to update PR #$pr_number.

Do not:
- Create a new PR or run gh pr create
- Create workflow markers
- Run the self-review tool
- Edit the task packet

Failure handling:
- If you cannot safely fix the issue, stop without broad code changes.
- Leave a short explanation of the blocker in your final response.
- Do not create markers or a PR. Workflow automation will handle follow-up.
_WVML_PROMPT_
}

# Build the review phase prompt.
# This phase runs self-review and creates the PR.
#
# Args (positional):
#   $1 = title
#   $2 = issue
#   $3 = wt_dir
#   $4 = branch
#   $5 = base_branch
#   $6 = issue_context
#   $7 = status_file
#   $8 = tools_dir
#   $9 = slug
#   $10 = reviewer_model (optional: recommended reviewer model)
#   $11 = review_mode (optional: recommended review mode)
#   $12 = agent_cmd
#   $13 = operating_mode
# Prints: the complete prompt to stdout
build_review_prompt() {
  local title="$1" issue="$2" wt_dir="$3" branch="$4" base_branch="$5"
  local issue_context="$6" status_file="$7" tools_dir="$8" slug="$9"
  local reviewer_model="${10:-}" review_mode="${11:-static}" agent_cmd="${12:-claude}" operating_mode="${13:-normal}"
  local feature_dir="$wt_dir/features/$slug"
  local abort_feedback_instruction exit_guard_text review_completion_text
  abort_feedback_instruction="$(agent_abort_feedback_text "$agent_cmd" "$feature_dir/.workflow-aborted")"
  exit_guard_text="$(agent_exit_guard_text "$agent_cmd" "the PR is created and all review steps are done")"
  review_completion_text="$(agent_completion_text "$agent_cmd")"

  # Build reviewer note
  local reviewer_note=""
  if [[ -n "$reviewer_model" ]]; then
    reviewer_note="NOTE: Workflow router recommends using $reviewer_model for review (mode: ${review_mode})"
  fi

  # Build mode-specific guidance
  local mode_guidance
  case "$review_mode" in
    static)
      mode_guidance="- Run static analysis only (fast)
- Fix critical issues found"
      ;;
    llm)
      mode_guidance="- Run LLM-based review (comprehensive)
- Fix all blockers and critical warnings"
      ;;
    static+llm)
      mode_guidance="- Run both static and LLM review (thorough)
- Fix all blockers and most warnings"
      ;;
    none)
      mode_guidance="- Skip review tool, proceed directly to PR"
      ;;
  esac

  local draft_pr_instruction=""
  if [[ "$operating_mode" == "survival" ]]; then
    draft_pr_instruction="## ⚠️  SURVIVAL MODE - Draft PR fallback

Read the coding confidence signal from the completion marker:
\`\`\`bash
coding_confidence=\$(jq -r '.confidence // empty' \"$feature_dir/.coding-complete\" 2>/dev/null)
\`\`\`

If \`\$coding_confidence\` is \`low\`, or if the initial self-review run exits 1:
- Create the PR as a draft by adding \`--draft\` to \`gh pr create\`.
- Do not iterate through more than one review-fix cycle before opening the draft.
- Note the low-confidence or failed-review reason in the PR description."
  fi

  local operating_mode_guidance=""
  case "$operating_mode" in
    constrained)
      operating_mode_guidance="## Scoped review (constrained quota)

The reviewer is operating in degraded scoped-review mode.
- Pass \`--operating-mode constrained\` to \`review-changes.ts\`.
- The review covers only syntax, contract violations, obvious regressions, and test-coverage gaps.
- After the final review run, read \`needs_stronger_reviewer\` and \`stronger_reviewer_reason\` from the JSON output.
- If the flag is true, prefix the PR title with \`[needs-stronger-reviewer]\`, add a \`## ⚠️ Needs Stronger Reviewer\` section near the top of the PR body, and attempt \`gh pr edit \"\$PR_URL\" --add-label needs-stronger-reviewer\`.
- If the label edit fails because the label is missing, do not fail the phase; mention that in the PR body."
      ;;
    survival)
      operating_mode_guidance="## Scoped review (survival quota)

The reviewer is operating in degraded scoped-review mode.
- Pass \`--operating-mode survival\` to \`review-changes.ts\`.
- The review covers only syntax, contract violations, obvious regressions, and test-coverage gaps.
- After the final review run, read \`needs_stronger_reviewer\` and \`stronger_reviewer_reason\` from the JSON output.
- If the flag is true, prefix the PR title with \`[needs-stronger-reviewer]\`, add a \`## ⚠️ Needs Stronger Reviewer\` section near the top of the PR body, and attempt \`gh pr edit \"\$PR_URL\" --add-label needs-stronger-reviewer\`.
- If the label edit fails because the label is missing, do not fail the phase; mention that in the PR body."
      ;;
  esac

  # Load template and fill placeholders
  local template_file="$tools_dir/prompts/review-phase.md"
  local template_content
  local resolver_tool="$tools_dir/resolve-runtime-resource.ts"
  local resource_repo_dir
  resource_repo_dir="$(agent_runtime_resource_repo_dir "$tools_dir")"
  if [[ -f "$resolver_tool" ]] && agent_runtime_resource_selection_enabled "$resource_repo_dir" "reviewer"; then
    local resolved_json
    if resolved_json="$(agent_run_tsx_tool "$resolver_tool" --surface reviewer --repo-dir "$resource_repo_dir" --json 2>/dev/null)" \
      && template_content="$(printf '%s' "$resolved_json" | jq -er '.content')" ; then
      :
    else
      echo "[warn] Failed to resolve reviewer runtime resource, falling back to $template_file" >&2
      template_content=""
    fi
  fi
  if [[ -z "${template_content:-}" && -f "$template_file" ]]; then
    template_content=$(cat "$template_file")
  fi
  if [[ -n "${template_content:-}" ]]; then
    template_content="${template_content//\{\{REVIEW_MODE\}\}/$review_mode}"
    template_content="${template_content//\{\{TOOLS_DIR\}\}/$tools_dir}"
    template_content="${template_content//\{\{BASE_BRANCH\}\}/$base_branch}"
    template_content="${template_content//\{\{ISSUE\}\}/$issue}"
    template_content="${template_content//\{\{SLUG\}\}/$slug}"
    template_content="${template_content//\{\{FEATURE_DIR\}\}/$feature_dir}"
    template_content="${template_content//\{\{REVIEWER_NOTE\}\}/$reviewer_note}"
    template_content="${template_content//\{\{MODE_GUIDANCE\}\}/$mode_guidance}"
    template_content="${template_content//\{\{OPERATING_MODE_GUIDANCE\}\}/$operating_mode_guidance}"
    template_content="${template_content//\{\{OPERATING_MODE\}\}/$operating_mode}"
    template_content="${template_content//\{\{DRAFT_PR_INSTRUCTION\}\}/$draft_pr_instruction}"
  elif [[ ! -f "$template_file" ]]; then
    template_content="[ERROR: Review template not found at $template_file]"
  fi

  cat <<_WVML_PROMPT_
You are working on: $title ($issue)

Repo worktree: $wt_dir
Branch: $branch
Base branch: $base_branch

$issue_context
---

## Status Reporting
Throughout your work, periodically update your status by running:
  echo '<short description of what you are doing right now>' > $status_file
Keep it under 50 chars. Update it at each major step.

$template_content

### IMPORTANT: Handling User Feedback During This Phase

You may receive text feedback from the user while you are working on this phase.
User feedback is GUIDANCE to improve your approach — it is NOT a signal to complete the phase.

When you receive user feedback:
- DO: Read and incorporate the feedback into your ongoing work
- DO: Adjust your approach based on the guidance
- DO: Continue working until the review and PR creation are genuinely complete
- DO: If the user asks to stop, abort, close the issue, or discontinue work, $abort_feedback_instruction
- DO NOT: Interpret feedback as "wrap up now"
- DO NOT: Create additional completion output if the user wants to stop
- DO NOT: Skip remaining review steps or rush the PR just because you received feedback
- DO NOT: $exit_guard_text

After creating the PR, report the PR URL to the user, then $review_completion_text
_WVML_PROMPT_
}


# ============================================================================
# AGENT LAUNCH — AUTONOMOUS (SKIP) MODE
# ============================================================================

# Launch an agent in autonomous mode inside a tmux window.
# The agent receives a pre-written instructions file and runs without
# interactive user input.
#
# Args:
#   $1 = tmux session name
#   $2 = tmux window name
#   $3 = path to instructions file
#   $4 = agent command name
#   $5 = model ID (optional — when set, passes --model flag to the agent CLI)
#   $6 = issue ID (optional — enables lifecycle status tracking)
agent_launch_autonomous() {
  local session="$1"
  local window="$2"
  local instr_file="$3"
  local agent_cmd="$4"
  local model="${5:-}"
  local issue="${6:-}"
  local hooks_dir dashboard_pid
  hooks_dir="$(agent_hooks_dir)"
  dashboard_pid="$(agent_resolve_dashboard_pid "$session")"
  local repo_dir="${REPO_DIR:-$(pwd)}"
  local role feature_dir launch_phase phase_env
  launch_phase="$(agent_normalize_launch_phase "$window" "$instr_file" 2>/dev/null || true)"
  role="$(agent_role_from_phase "$launch_phase" 2>/dev/null || true)"
  feature_dir="${WAVEMILL_FEATURE_DIR:-}"
  if [[ -z "$feature_dir" && -n "${WAVEMILL_FEATURE_SLUG:-}" ]]; then
    feature_dir="$repo_dir/features/$WAVEMILL_FEATURE_SLUG"
  fi
  phase_env="${launch_phase:-$window}"

  if [[ -n "$model" ]] && ! agent_validate_model "$model" "${REPO_DIR:-$(pwd)}" >/dev/null 2>&1; then
    echo "Error: invalid model selector '$model' for $agent_cmd" >&2
    return 1
  fi

  if [[ -n "$model" ]]; then
    model="$(agent_resolve_model "${role:-coder}" "$model" "$repo_dir")"
    local resolved_agent
    if ! resolved_agent="$(agent_resolve_from_model "$model" "${launch_phase:-coding}")"; then
      return 1
    fi
    if [[ "$resolved_agent" != "$agent_cmd" ]]; then
      echo "Error: launch agent mismatch for model $model: route resolved $resolved_agent, requested $agent_cmd" >&2
      return 1
    fi
  fi

  local model_flag=""
  if [[ -n "$model" ]]; then
    model_flag=" --model $model"
  fi

  local native_phase="$launch_phase"
  local native_model=""
  local linear_issue
  linear_issue="$(agent_normalize_linear_issue_id "$issue" "${WAVEMILL_LINEAR_ISSUE:-}")"
  local worktree_dir="${feature_dir%/features/*}"
  local feature_slug="${WAVEMILL_FEATURE_SLUG:-${WAVEMILL_SLUG:-}}"
  if agent_is_native_cmd "$agent_cmd"; then
    if ! agent_native_launch_preflight "$issue" "$agent_cmd" "$native_phase" "$model" "$repo_dir"; then
      return 1
    fi
    native_model="$(printf '%s' "$AGENT_NATIVE_LAUNCH_LAST_JSON" | jq -r '.model // empty' 2>/dev/null)"
  fi

  local target
  target="$(agent_tmux_target "$session" "$window")" || return 1
  local tmux_guard_exports
  tmux_guard_exports="$(agent_tmux_guard_export_command "$target" "$session" "$issue" "$agent_cmd")" || return 1

  agent_write_initial_status "$session" "$issue"
  agent_supersede_terminal_hook "$session" "$issue" "$feature_dir"
  if [[ -n "$role" && -n "$model" ]]; then
    routing_emit_phase "$role" "$model" "$repo_dir" "$feature_dir" || true
  fi

  # Wrap agent command so exit status is visible and the shell survives
  case "$agent_cmd" in
    native-openai|native-openrouter)
      local launcher="/tmp/${session}-${issue}-autonomous-launcher.sh"
      # Resolved once here; the unknown-phase branch below still owns its own
      # error, so this stays empty rather than failing for unsupported phases.
      local native_launcher
      native_launcher="$(agent_native_launcher_path "$native_phase" 2>/dev/null || true)"
      case "$native_phase" in
        planning)
          cat > "$launcher" <<LAUNCHEOF
#!/bin/bash
set -euo pipefail
export WAVEMILL_SESSION='$session'
export WAVEMILL_ISSUE='$issue'
export WAVEMILL_LINEAR_ISSUE='$linear_issue'
export WAVEMILL_DASHBOARD_PID='$dashboard_pid'
export WAVEMILL_PHASE='planning'
export WAVEMILL_RESOLVED_MODEL='${native_model:-$model}'
export WAVEMILL_REPO_DIR='$repo_dir'
export WAVEMILL_WT_DIR='$worktree_dir'
export WAVEMILL_FEATURE_SLUG='$feature_slug'
export WAVEMILL_SLUG='$feature_slug'
export WAVEMILL_PLAN_DEPTH='${WAVEMILL_PLAN_DEPTH:-}'
export WAVEMILL_OPERATING_MODE='${WAVEMILL_OPERATING_MODE:-}'
export WAVEMILL_BRANCH='${WAVEMILL_BRANCH:-}'
export WAVEMILL_BASE_BRANCH='${WAVEMILL_BASE_BRANCH:-}'
export WAVEMILL_TITLE='${WAVEMILL_TITLE:-}'
if [[ -n '$issue' ]]; then
  printf '%s\n' "working" > "/tmp/${session}-${issue}-status.txt"
fi
set +e
npx tsx '$native_launcher' --session '$session' --issue '$issue' --linear-issue '$linear_issue' --slug '$feature_slug' --wt-dir '$worktree_dir' --repo-dir '$repo_dir'
native_rc=\$?
set -e
if [[ -n "\${STATUS_LOG_FILE:-}" ]]; then
  printf '%s\n' "[wavemill] native planning exit code native=\${native_rc} issue='$issue'" >> "\$STATUS_LOG_FILE" 2>/dev/null || true
fi
echo "[wavemill] Agent exited (native=\${native_rc})"
exit "\$native_rc"
LAUNCHEOF
          ;;
        review)
          cat > "$launcher" <<LAUNCHEOF
#!/bin/bash
set -euo pipefail
export WAVEMILL_SESSION='$session'
export WAVEMILL_ISSUE='$issue'
export WAVEMILL_LINEAR_ISSUE='$linear_issue'
export WAVEMILL_DASHBOARD_PID='$dashboard_pid'
export WAVEMILL_PHASE='review'
export WAVEMILL_RESOLVED_MODEL='${native_model:-$model}'
export WAVEMILL_REPO_DIR='$repo_dir'
export WAVEMILL_WT_DIR='$worktree_dir'
export WAVEMILL_FEATURE_SLUG='$feature_slug'
export WAVEMILL_SLUG='$feature_slug'
export WAVEMILL_BRANCH='${WAVEMILL_BRANCH:-}'
export WAVEMILL_BASE_BRANCH='${WAVEMILL_BASE_BRANCH:-}'
export WAVEMILL_TITLE='${WAVEMILL_TITLE:-}'
if [[ -n '$issue' ]]; then
  printf '%s\n' "working" > "/tmp/${session}-${issue}-status.txt"
fi
set +e
npx tsx '$native_launcher' --session '$session' --issue '$issue' --slug '$feature_slug' --wt-dir '$worktree_dir' --repo-dir '$repo_dir'
native_rc=\$?
set -e
if [[ -n "\${STATUS_LOG_FILE:-}" ]]; then
  printf '%s\n' "[wavemill] native review exit code native=\${native_rc} issue='$issue'" >> "\$STATUS_LOG_FILE" 2>/dev/null || true
fi
echo "[wavemill] Agent exited (native=\${native_rc})"
exit "\$native_rc"
LAUNCHEOF
          ;;
        coding)
          cat > "$launcher" <<LAUNCHEOF
#!/bin/bash
set -euo pipefail
export WAVEMILL_SESSION='$session'
export WAVEMILL_ISSUE='$issue'
export WAVEMILL_LINEAR_ISSUE='$linear_issue'
export WAVEMILL_DASHBOARD_PID='$dashboard_pid'
export WAVEMILL_PHASE='coding'
export WAVEMILL_RESOLVED_MODEL='${native_model:-$model}'
export WAVEMILL_REPO_DIR='$repo_dir'
export WAVEMILL_WT_DIR='$worktree_dir'
export WAVEMILL_FEATURE_SLUG='$feature_slug'
export WAVEMILL_SLUG='$feature_slug'
export WAVEMILL_CODE_DEPTH='${WAVEMILL_CODE_DEPTH:-}'
export WAVEMILL_OPERATING_MODE='${WAVEMILL_OPERATING_MODE:-}'
export WAVEMILL_BRANCH='${WAVEMILL_BRANCH:-}'
export WAVEMILL_BASE_BRANCH='${WAVEMILL_BASE_BRANCH:-}'
export WAVEMILL_TITLE='${WAVEMILL_TITLE:-}'
if [[ -n '$issue' ]]; then
  printf '%s\n' "working" > "/tmp/${session}-${issue}-status.txt"
fi
set +e
npx tsx '$native_launcher' --session '$session' --issue '$issue' --slug '$feature_slug' --wt-dir '$worktree_dir' --repo-dir '$repo_dir'
native_rc=\$?
set -e
if [[ -n "\${STATUS_LOG_FILE:-}" ]]; then
  printf '%s\n' "[wavemill] native coding exit code native=\${native_rc} issue='$issue'" >> "\$STATUS_LOG_FILE" 2>/dev/null || true
fi
echo "[wavemill] Agent exited (native=\${native_rc})"
exit "\$native_rc"
LAUNCHEOF
          ;;
        *)
          echo "Error: native agent '$agent_cmd' does not support autonomous phase '$native_phase'" >&2
          return 1
          ;;
      esac
      chmod +x "$launcher"
      local launcher_cmd
      printf -v launcher_cmd '%q' "$launcher"
      agent_send_tmux_guarded_command "$target" "$launcher_cmd" "$tmux_guard_exports"
      ;;
    claude-deepseek)
      local tools_dir="${TOOLS_DIR:-$(agent_wavemill_tools_dir)}"
      local lib_dir="${tools_dir%/tools}/shared/lib"
      local launcher="/tmp/${session}-${issue}-autonomous-launcher.sh"
      local env_block resolved_model

      # Validate credentials and resolve env before touching tmux — fail-fast.
      env_block="$(
        cd "$lib_dir" &&
        agent_run_tsx_tool "$tools_dir/launch-claude-deepseek.ts" \
          --repo "$repo_dir" \
          --session "$session" \
          --issue "$issue" \
          ${model:+--model "$model"}
      )" || {
        echo "Error: claude-deepseek pre-launch validation failed" >&2
        return 1
      }

      # Extract resolved model from env block (ANTHROPIC_MODEL line)
      resolved_model="$(printf '%s\n' "$env_block" | grep '^ANTHROPIC_MODEL=' | head -1 | sed "s/^ANTHROPIC_MODEL='//;s/'$//")"
      local effective_model_flag=""
      if [[ -n "$resolved_model" ]]; then
        effective_model_flag=" --model $resolved_model"
      fi

      cat > "$launcher" <<LAUNCHEOF
#!/bin/bash
set -euo pipefail
export WAVEMILL_SESSION='$session'
export WAVEMILL_ISSUE='$issue'
export WAVEMILL_LINEAR_ISSUE='$linear_issue'
export WAVEMILL_DASHBOARD_PID='$dashboard_pid'
export WAVEMILL_PHASE='$phase_env'
export WAVEMILL_RESOLVED_MODEL='${resolved_model:-$model}'
# Resolve credentials at runtime (not embedded in script)
tools_dir='$tools_dir'
lib_dir='$lib_dir'
env_block="\$(cd "\$lib_dir" && npx tsx "\$tools_dir/launch-claude-deepseek.ts" --repo '$repo_dir' --session '$session' --issue '$issue'${model:+ --model '$model'} 2>&1)"
launch_rc=\$?
if [[ "\$launch_rc" -eq 2 ]]; then
  echo "Error: Missing DeepSeek API key. Set DEEPSEEK_API_KEY before launching." >&2
  exit 2
elif [[ "\$launch_rc" -ne 0 ]]; then
  echo "Error: claude-deepseek launcher failed (rc=\$launch_rc): \$env_block" >&2
  exit 1
fi
eval "\$env_block"
cat '$instr_file' | claude${effective_model_flag} --dangerously-skip-permissions
echo "[wavemill] Agent exited (\$?)"
LAUNCHEOF
      chmod +x "$launcher"
      local launcher_cmd
      printf -v launcher_cmd '%q' "$launcher"
      agent_send_tmux_guarded_command "$target" "$launcher_cmd" "$tmux_guard_exports"
      ;;
    claude-openrouter)
      agent_openrouter_direct_disabled_message
      return 1
      ;;
    claude)
      if agent_model_is_deepseek "$model"; then
        if ! agent_validate_deepseek_launch "$model" "$repo_dir"; then
          return 1
        fi
        local provider_json base_url api_key_env effort_level provider_root provider_home xdg_config_home xdg_data_home launcher
        provider_json="$(agent_deepseek_config "$repo_dir")" || return 1
        base_url="$(agent_json_get "$provider_json" baseUrl)"
        api_key_env="$(agent_json_get "$provider_json" apiKeyEnv)"
        effort_level="$(agent_json_get "$provider_json" effortLevel)"
        provider_root="$(agent_deepseek_state_dir "$repo_dir" "$session" "$issue")"
        provider_home="$provider_root/home"
        xdg_config_home="$provider_root/xdg/config"
        xdg_data_home="$provider_root/xdg/data"
        launcher="/tmp/${session}-${issue}-autonomous-launcher.sh"
        cat > "$launcher" <<LAUNCHEOF
#!/bin/bash
set -euo pipefail
export WAVEMILL_SESSION='$session'
export WAVEMILL_ISSUE='$issue'
export WAVEMILL_DASHBOARD_PID='$dashboard_pid'
export WAVEMILL_PHASE='$phase_env'
export WAVEMILL_RESOLVED_MODEL='$model'
provider_root='$provider_root'
provider_home='$provider_home'
xdg_config_home='$xdg_config_home'
xdg_data_home='$xdg_data_home'
api_key_env='$api_key_env'
api_key_value="\${!api_key_env:-}"
if [[ -z "\$api_key_value" ]]; then
  echo "Error: DeepSeek model '$model' requires \$api_key_env to be set" >&2
  exit 1
fi
mkdir -p "\$provider_home" "\$xdg_config_home" "\$xdg_data_home"
chmod 700 "\$provider_root" "\$provider_home" "\$xdg_config_home" "\$xdg_data_home" 2>/dev/null || true
export HOME="\$provider_home"
export XDG_CONFIG_HOME="\$xdg_config_home"
export XDG_DATA_HOME="\$xdg_data_home"
export WAVEMILL_DEEPSEEK_PROVIDER_ROOT="\$provider_root"
export ANTHROPIC_BASE_URL='$base_url'
export ANTHROPIC_AUTH_TOKEN="\$api_key_value"
export ANTHROPIC_API_KEY="\$api_key_value"
export ANTHROPIC_MODEL='$model'
export ANTHROPIC_DEFAULT_OPUS_MODEL='$model'
export ANTHROPIC_DEFAULT_SONNET_MODEL='$model'
export ANTHROPIC_DEFAULT_HAIKU_MODEL='$model'
export CLAUDE_CODE_SUBAGENT_MODEL='$model'
export CLAUDE_CODE_EFFORT_LEVEL='${effort_level:-medium}'
cat '$instr_file' | claude${model_flag} --dangerously-skip-permissions
echo "[wavemill] Agent exited (\$?)"
LAUNCHEOF
        chmod +x "$launcher"
        local launcher_cmd
        printf -v launcher_cmd '%q' "$launcher"
        agent_send_tmux_guarded_command "$target" "$launcher_cmd" "$tmux_guard_exports"
      else
        agent_send_tmux_guarded_command "$target" "export WAVEMILL_SESSION='$session' WAVEMILL_ISSUE='$issue' WAVEMILL_DASHBOARD_PID='$dashboard_pid' WAVEMILL_PHASE='$phase_env' WAVEMILL_RESOLVED_MODEL='$model'; cat '$instr_file' | claude${model_flag} --dangerously-skip-permissions; echo '[wavemill] Agent exited (\$?)'" "$tmux_guard_exports"
      fi
      ;;
    codex)
      local launcher="/tmp/${session}-${issue}-autonomous-launcher.sh"
      local launcher_cmd=""
      cat > "$launcher" <<LAUNCHEOF
#!/bin/bash
export WAVEMILL_SESSION='$session'
export WAVEMILL_ISSUE='$issue'
export WAVEMILL_DASHBOARD_PID='$dashboard_pid'
export WAVEMILL_PHASE='$phase_env'
export WAVEMILL_RESOLVED_MODEL='$model'
if [[ -n '$issue' ]]; then
  printf '%s\n' "working" > "/tmp/${session}-${issue}-status.txt"
fi
codex exec${model_flag} --dangerously-bypass-approvals-and-sandbox - < '$instr_file'
codex_rc=\$?
if [[ -n "\${STATUS_LOG_FILE:-}" ]]; then
  printf '%s\n' "[wavemill] codex exit code codex=\${codex_rc} issue='$issue'" >> "\$STATUS_LOG_FILE" 2>/dev/null || true
fi
if [[ -n '$issue' && -f '$hooks_dir/wavemill-hook-protocol.sh' ]]; then
  source '$hooks_dir/wavemill-hook-protocol.sh'
  if [[ "\$codex_rc" -eq 0 ]]; then
    wavemill_hook_write 'idle' 'process_exit' "codex exited with code 0" 'codex'
  else
    wavemill_hook_write 'error' 'process_exit' "codex exited with code \$codex_rc" 'codex'
  fi
fi
echo "[wavemill] Agent exited (codex=\${codex_rc})"
LAUNCHEOF
      chmod +x "$launcher"
      printf -v launcher_cmd '%q' "$launcher"
      agent_send_tmux_guarded_command "$target" "$launcher_cmd" "$tmux_guard_exports"
      ;;
    *)
      # Generic fallback: start the agent, then paste instructions via tmux buffer.
      local exit_file=""
      if [[ -n "$issue" ]]; then
        exit_file="/tmp/wavemill-${session}-${issue}.exit"
        rm -f "$exit_file" 2>/dev/null || true
      fi
      if [[ -n "$exit_file" ]]; then
        agent_send_tmux_guarded_command "$target" "export WAVEMILL_RESOLVED_MODEL='$model'; $agent_cmd${model_flag}; rc=\$?; printf '%s\n' \"\$rc\" > '$exit_file'" "$tmux_guard_exports"
      else
        agent_send_tmux_guarded_command "$target" "export WAVEMILL_RESOLVED_MODEL='$model'; $agent_cmd${model_flag}" "$tmux_guard_exports"
      fi
      sleep 0.3
      local pane_pid=""
      pane_pid=$(tmux display-message -t "$target" -p '#{pane_pid}' 2>/dev/null || echo "")
      if [[ -n "$pane_pid" && -n "$issue" ]]; then
        env WAVEMILL_SESSION="$session" WAVEMILL_ISSUE="$issue" WAVEMILL_DASHBOARD_PID="$dashboard_pid" "$hooks_dir/process-status-monitor.sh" "$pane_pid" "$exit_file" >/dev/null 2>&1 &
      fi
      local instr
      instr="$(cat "$instr_file")"
      tmux set-buffer "$instr"
      tmux paste-buffer -t "$target"
      tmux send-keys -t "$target" C-m
      ;;
  esac
}

_agent_find_issue_window() {
  local session="$1"
  local issue="$2"
  local stored_target

  if [[ -n "${STATE_FILE:-}" && -f "${STATE_FILE:-}" ]] && command -v jq >/dev/null 2>&1; then
    stored_target="$(jq -r --arg issue "$issue" '.tasks[$issue].windowId // empty' "$STATE_FILE" 2>/dev/null || true)"
    if [[ -n "$stored_target" ]] && tmux display-message -p -t "$stored_target" '#{window_id}' >/dev/null 2>&1; then
      printf '%s\n' "$stored_target"
      return 0
    fi
  fi

  tmux list-windows -t "$session" -F '#{window_name}' 2>/dev/null \
    | awk -v prefix="${issue}-" 'index($0, prefix) == 1 { print; exit }'
}

# Resume an agent after a transient API failure without discarding its context.
# If the pane is sitting at an idle shell, dispatch an agent-specific resume
# command. If the agent UI is still active, send a continuation prompt directly
# to the pane so the existing session can pick it up.
#
# Args:
#   $1 = tmux session
#   $2 = issue id
#   $3 = agent command (claude/codex/other)
# Returns: 0 on success, 1 on failure
agent_resume_after_error() {
  local session="$1"
  local issue="$2"
  local agent_cmd="${3:-claude}"
  local window target
  local resume_prompt="The previous attempt encountered a transient API error. Please continue working on the task from where you left off."

  window=$(_agent_find_issue_window "$session" "$issue")
  if [[ -z "$window" ]]; then
    _agent_log_warn "Cannot resume $issue: no tmux window found in session $session"
    return 1
  fi

  target="$(agent_tmux_target "$session" "$window")" || return 1
  if ! tmux list-panes -t "$target" >/dev/null 2>&1; then
    _agent_log_warn "Cannot resume $issue: tmux target $target is unavailable"
    return 1
  fi

  # Helper: send a resume prompt to a live agent TUI with delivery confirmation
  # when the confirmed-send helper is loaded; fall back to plain send-keys when
  # the helper isn't available (adapter-only test contexts). Returns rc from
  # the helper on the confirmed path, 0 on the unverified fallback path.
  _agent_resume_send_confirmed() {
    local _target="$1" _prompt="$2" _issue="$3" _session="$4"
    if declare -F wavemill_pane_send_message >/dev/null 2>&1; then
      if wavemill_pane_send_message "$_target" "$_prompt" "$_issue" "$_session"; then
        return 0
      fi
      _agent_log_warn "Resume prompt for $_issue not confirmed (${WAVEMILL_PANE_MESSAGE_LAST_STATUS:-unknown}: ${WAVEMILL_PANE_MESSAGE_LAST_DETAIL:-})"
      return 1
    fi
    tmux send-keys -t "$_target" "$_prompt" C-m
    _agent_log_debug "Resume prompt sent to $_target without delivery confirmation (helper not loaded)"
    return 0
  }

  if agent_pane_is_ready "$session" "$window"; then
    case "$agent_cmd" in
      claude)
        if claude --help 2>/dev/null | grep -q -- '--resume'; then
          # Shell command to an idle shell, not an agent TUI message. See
          # plan audit #3 in HOK-2765 — pre-existing behavior, left as-is.
          tmux send-keys -t "$target" "claude --resume" C-m
        else
          _agent_resume_send_confirmed "$target" "$resume_prompt" "$issue" "$session" || return 1
        fi
        ;;
      codex)
        _agent_resume_send_confirmed "$target" "$resume_prompt" "$issue" "$session" || return 1
        ;;
      *)
        _agent_resume_send_confirmed "$target" "$resume_prompt" "$issue" "$session" || return 1
        ;;
    esac
  else
    _agent_resume_send_confirmed "$target" "$resume_prompt" "$issue" "$session" || return 1
  fi

  return 0
}

# ============================================================================
# AGENT LAUNCH — INTERACTIVE (PLANNING) MODE
# ============================================================================

# Launch an agent interactively in a tmux window for user-guided planning.
# Creates a small launcher script that execs the agent with the prompt.
#
# Args:
#   $1 = tmux session name
#   $2 = tmux window name
#   $3 = path to prompt file
#   $4 = agent command name
#   $5 = model ID (optional — when set, passes --model flag to the agent CLI)
#   $6 = agent flags (optional)
#   $7 = abort check command (optional)
#   $8 = issue ID (optional — enables lifecycle status tracking)
agent_launch_interactive() {
  local session="$1"
  local window="$2"
  local prompt_file="$3"
  local agent_cmd="$4"
  local model="${5:-}"
  local agent_flags="${6:-}"
  local abort_check_cmd="${7:-}"
  local issue="${8:-}"
  local dashboard_pid
  dashboard_pid="$(agent_resolve_dashboard_pid "$session")"
  local repo_dir="${REPO_DIR:-$(pwd)}"
  local role feature_dir launch_phase phase_env
  launch_phase="$(agent_normalize_launch_phase "$window" "$prompt_file" 2>/dev/null || true)"
  role="$(agent_role_from_phase "$launch_phase" 2>/dev/null || true)"
  feature_dir="${WAVEMILL_FEATURE_DIR:-}"
  if [[ -z "$feature_dir" && -n "${WAVEMILL_FEATURE_SLUG:-}" ]]; then
    feature_dir="$repo_dir/features/$WAVEMILL_FEATURE_SLUG"
  fi
  phase_env="${launch_phase:-$window}"

  if [[ -n "$model" ]] && ! agent_validate_model "$model" "${REPO_DIR:-$(pwd)}" >/dev/null 2>&1; then
    local challenge_launch_stage=""
    case "${launch_phase:-}" in
      plan|planning) challenge_launch_stage="plan" ;;
      coding|implementation) challenge_launch_stage="implementation" ;;
      review) challenge_launch_stage="review" ;;
    esac
    if [[ -n "${WAVEMILL_CHALLENGE_VARIED_MODEL:-}" \
      && "$model" == "$WAVEMILL_CHALLENGE_VARIED_MODEL" \
      && -n "$challenge_launch_stage" \
      && "$challenge_launch_stage" == "${WAVEMILL_CHALLENGE_VARIED_STAGE:-}" ]]; then
      echo "Error: challenge varied ${challenge_launch_stage} model '$model' failed validation; refusing fallback substitution" >&2
      return 1
    fi
    local fallback_model=""
    fallback_model="$(agent_default_model_for_cmd "$agent_cmd")"
    if agent_model_looks_like_depth_tag "$model"; then
      _agent_log_warn "Rejecting depth tag '$model' as model ID for $agent_cmd"
    else
      _agent_log_warn "Rejecting invalid model '$model' for $agent_cmd"
    fi

    if [[ -n "$fallback_model" ]]; then
      if agent_validate_model "$fallback_model" "${REPO_DIR:-$(pwd)}" >/dev/null 2>&1; then
        _agent_log_warn "Falling back to $fallback_model"
        model="$fallback_model"
      else
        _agent_log_warn "Configured fallback '$fallback_model' is invalid; launching without explicit --model override"
        model=""
      fi
    else
      _agent_log_warn "Launching without explicit --model override"
      model=""
    fi
  fi

  if [[ -n "$model" ]]; then
    local requested_model="$model"
    local resolved_model=""
    if ! resolved_model="$(agent_resolve_model "${role:-coder}" "$requested_model" "$repo_dir" 2>/dev/null)"; then
      _agent_log_warn "Failed to resolve model selector '$requested_model' for $agent_cmd"
      return 1
    fi
    model="$resolved_model"
    local resolved_agent
    if ! resolved_agent="$(agent_resolve_from_model "$model" "${launch_phase:-coding}")"; then
      return 1
    fi
    if [[ "$resolved_agent" != "$agent_cmd" ]]; then
      echo "Error: launch agent mismatch for model $model: route resolved $resolved_agent, requested $agent_cmd" >&2
      return 1
    fi
  fi

  if [[ -n "$model" ]] && agent_model_is_deepseek "$model"; then
    if ! agent_validate_deepseek_launch "$model" "$repo_dir"; then
      return 1
    fi
  fi

  local model_flag=""
  if [[ -n "$model" ]]; then
    model_flag=" --model $model"
  fi

  if [[ -n "$agent_flags" ]]; then
    agent_flags=" $agent_flags"
  fi

  if [[ "$agent_cmd" == "codex" ]] && [[ "$agent_flags" != *" --dangerously-bypass-approvals-and-sandbox"* ]]; then
    agent_flags="${agent_flags} --dangerously-bypass-approvals-and-sandbox"
  fi

  local launcher="/tmp/${session}-$(basename "$prompt_file" .txt)-launcher.sh"
  local launcher_cmd=""
  local native_phase="$launch_phase"
  local native_model=""
  local linear_issue
  linear_issue="$(agent_normalize_linear_issue_id "$issue" "${WAVEMILL_LINEAR_ISSUE:-}")"
  local worktree_dir="${feature_dir%/features/*}"
  local feature_slug="${WAVEMILL_FEATURE_SLUG:-${WAVEMILL_SLUG:-}}"

  if agent_is_native_cmd "$agent_cmd"; then
    if ! agent_native_launch_preflight "$issue" "$agent_cmd" "$native_phase" "$model" "$repo_dir"; then
      return 1
    fi
    native_model="$(printf '%s' "$AGENT_NATIVE_LAUNCH_LAST_JSON" | jq -r '.model // empty' 2>/dev/null)"
  fi

  local target
  target="$(agent_tmux_target "$session" "$window")" || return 1
  local tmux_guard_exports
  tmux_guard_exports="$(agent_tmux_guard_export_command "$target" "$session" "$issue" "$agent_cmd")" || return 1

  agent_prepare_pane_for_launch "$session" "$window" 15 3 "$abort_check_cmd"
  local prepare_rc=$?
  if [[ "$prepare_rc" -eq 2 ]]; then
    return "$prepare_rc"
  fi
  agent_hydrate_repo_env_in_pane "$target" "$repo_dir"

  agent_write_initial_status "$session" "$issue"
  agent_supersede_terminal_hook "$session" "$issue" "$feature_dir"
  if [[ -n "$role" && -n "$model" ]]; then
    routing_emit_phase "$role" "$model" "$repo_dir" "$feature_dir" || true
  fi

  # Don't use exec — keep the shell alive so the window persists after agent exit
  case "$agent_cmd" in
    native-openai|native-openrouter)
      # Resolved once here; the unknown-phase branch below still owns its own
      # error, so this stays empty rather than failing for unsupported phases.
      local native_launcher
      native_launcher="$(agent_native_launcher_path "$native_phase" 2>/dev/null || true)"
      case "$native_phase" in
        planning)
          cat > "$launcher" <<LAUNCHEOF
#!/bin/bash
set -euo pipefail
export WAVEMILL_SESSION='$session'
export WAVEMILL_ISSUE='$issue'
export WAVEMILL_LINEAR_ISSUE='$linear_issue'
export WAVEMILL_DASHBOARD_PID='$dashboard_pid'
export WAVEMILL_PHASE='planning'
export WAVEMILL_RESOLVED_MODEL='${native_model:-$model}'
export WAVEMILL_REPO_DIR='$repo_dir'
export WAVEMILL_WT_DIR='$worktree_dir'
export WAVEMILL_FEATURE_SLUG='$feature_slug'
export WAVEMILL_SLUG='$feature_slug'
export WAVEMILL_PLAN_DEPTH='${WAVEMILL_PLAN_DEPTH:-}'
export WAVEMILL_OPERATING_MODE='${WAVEMILL_OPERATING_MODE:-}'
export WAVEMILL_BRANCH='${WAVEMILL_BRANCH:-}'
export WAVEMILL_BASE_BRANCH='${WAVEMILL_BASE_BRANCH:-}'
export WAVEMILL_TITLE='${WAVEMILL_TITLE:-}'
if [[ -n '$issue' ]]; then
  printf '%s\n' "working" > "/tmp/${session}-${issue}-status.txt"
fi
set +e
npx tsx '$native_launcher' --session '$session' --issue '$issue' --linear-issue '$linear_issue' --slug '$feature_slug' --wt-dir '$worktree_dir' --repo-dir '$repo_dir'
native_rc=\$?
set -e
if [[ -n "\${STATUS_LOG_FILE:-}" ]]; then
  printf '%s\n' "[wavemill] native planning exit code native=\${native_rc} issue='$issue'" >> "\$STATUS_LOG_FILE" 2>/dev/null || true
fi
echo "[wavemill] Agent exited (native=\${native_rc})"
exit "\$native_rc"
LAUNCHEOF
          ;;
        review)
          cat > "$launcher" <<LAUNCHEOF
#!/bin/bash
set -euo pipefail
export WAVEMILL_SESSION='$session'
export WAVEMILL_ISSUE='$issue'
export WAVEMILL_LINEAR_ISSUE='$linear_issue'
export WAVEMILL_DASHBOARD_PID='$dashboard_pid'
export WAVEMILL_PHASE='review'
export WAVEMILL_RESOLVED_MODEL='${native_model:-$model}'
export WAVEMILL_REPO_DIR='$repo_dir'
export WAVEMILL_WT_DIR='$worktree_dir'
export WAVEMILL_FEATURE_SLUG='$feature_slug'
export WAVEMILL_SLUG='$feature_slug'
export WAVEMILL_BRANCH='${WAVEMILL_BRANCH:-}'
export WAVEMILL_BASE_BRANCH='${WAVEMILL_BASE_BRANCH:-}'
export WAVEMILL_TITLE='${WAVEMILL_TITLE:-}'
if [[ -n '$issue' ]]; then
  printf '%s\n' "working" > "/tmp/${session}-${issue}-status.txt"
fi
set +e
npx tsx '$native_launcher' --session '$session' --issue '$issue' --slug '$feature_slug' --wt-dir '$worktree_dir' --repo-dir '$repo_dir'
native_rc=\$?
set -e
if [[ -n "\${STATUS_LOG_FILE:-}" ]]; then
  printf '%s\n' "[wavemill] native review exit code native=\${native_rc} issue='$issue'" >> "\$STATUS_LOG_FILE" 2>/dev/null || true
fi
echo "[wavemill] Agent exited (native=\${native_rc})"
exit "\$native_rc"
LAUNCHEOF
          ;;
        coding)
          cat > "$launcher" <<LAUNCHEOF
#!/bin/bash
set -euo pipefail
export WAVEMILL_SESSION='$session'
export WAVEMILL_ISSUE='$issue'
export WAVEMILL_LINEAR_ISSUE='$linear_issue'
export WAVEMILL_DASHBOARD_PID='$dashboard_pid'
export WAVEMILL_PHASE='coding'
export WAVEMILL_RESOLVED_MODEL='${native_model:-$model}'
export WAVEMILL_REPO_DIR='$repo_dir'
export WAVEMILL_WT_DIR='$worktree_dir'
export WAVEMILL_FEATURE_SLUG='$feature_slug'
export WAVEMILL_SLUG='$feature_slug'
export WAVEMILL_CODE_DEPTH='${WAVEMILL_CODE_DEPTH:-}'
export WAVEMILL_OPERATING_MODE='${WAVEMILL_OPERATING_MODE:-}'
export WAVEMILL_BRANCH='${WAVEMILL_BRANCH:-}'
export WAVEMILL_BASE_BRANCH='${WAVEMILL_BASE_BRANCH:-}'
export WAVEMILL_TITLE='${WAVEMILL_TITLE:-}'
if [[ -n '$issue' ]]; then
  printf '%s\n' "working" > "/tmp/${session}-${issue}-status.txt"
fi
set +e
npx tsx '$native_launcher' --session '$session' --issue '$issue' --slug '$feature_slug' --wt-dir '$worktree_dir' --repo-dir '$repo_dir'
native_rc=\$?
set -e
if [[ -n "\${STATUS_LOG_FILE:-}" ]]; then
  printf '%s\n' "[wavemill] native coding exit code native=\${native_rc} issue='$issue'" >> "\$STATUS_LOG_FILE" 2>/dev/null || true
fi
echo "[wavemill] Agent exited (native=\${native_rc})"
exit "\$native_rc"
LAUNCHEOF
          ;;
        *)
          echo "Error: native agent '$agent_cmd' does not support interactive phase '$native_phase'" >&2
          return 1
          ;;
      esac
      ;;
    claude-deepseek)
      local tools_dir="${TOOLS_DIR:-$(agent_wavemill_tools_dir)}"
      local lib_dir="${tools_dir%/tools}/shared/lib"
      local env_block resolved_model

      # Validate credentials before touching the pane — fail-fast.
      env_block="$(
        cd "$lib_dir" &&
        agent_run_tsx_tool "$tools_dir/launch-claude-deepseek.ts" \
          --repo "$repo_dir" \
          --session "$session" \
          --issue "$issue" \
          ${model:+--model "$model"}
      )" || {
        local launch_rc=$?
        if [[ "$launch_rc" -eq 2 ]]; then
          echo "Error: Missing DeepSeek API key. Set DEEPSEEK_API_KEY before launching." >&2
        else
          echo "Error: claude-deepseek pre-launch validation failed" >&2
        fi
        return 1
      }

      resolved_model="$(printf '%s\n' "$env_block" | grep '^ANTHROPIC_MODEL=' | head -1 | sed "s/^ANTHROPIC_MODEL='//;s/'$//")"
      local effective_model_flag=""
      if [[ -n "$resolved_model" ]]; then
        effective_model_flag=" --model $resolved_model"
      fi

      cat > "$launcher" <<LAUNCHEOF
#!/bin/bash
set -euo pipefail
export WAVEMILL_SESSION='$session'
export WAVEMILL_ISSUE='$issue'
export WAVEMILL_DASHBOARD_PID='$dashboard_pid'
export WAVEMILL_PHASE='$phase_env'
export WAVEMILL_RESOLVED_MODEL='${resolved_model:-$model}'
if [[ -n '$issue' ]]; then
  printf '%s\n' "working" > "/tmp/${session}-${issue}-status.txt"
fi
tools_dir='$tools_dir'
lib_dir='$lib_dir'
env_block="\$(cd "\$lib_dir" && npx tsx "\$tools_dir/launch-claude-deepseek.ts" --repo '$repo_dir' --session '$session' --issue '$issue'${model:+ --model '$model'} 2>&1)"
launch_rc=\$?
if [[ "\$launch_rc" -eq 2 ]]; then
  echo "Error: Missing DeepSeek API key. Set DEEPSEEK_API_KEY before launching." >&2
  exit 2
elif [[ "\$launch_rc" -ne 0 ]]; then
  echo "Error: claude-deepseek launcher failed (rc=\$launch_rc): \$env_block" >&2
  exit 1
fi
eval "\$env_block"
claude${effective_model_flag}${agent_flags} --dangerously-skip-permissions "\$(cat '$prompt_file')"
      echo "[wavemill] Agent exited (\$?)"
LAUNCHEOF
      ;;
    claude-openrouter)
      agent_openrouter_direct_disabled_message
      return 1
      ;;
    claude)
      if agent_model_is_deepseek "$model"; then
        local provider_json base_url api_key_env effort_level provider_root provider_home xdg_config_home xdg_data_home
        provider_json="$(agent_deepseek_config "$repo_dir")" || return 1
        base_url="$(agent_json_get "$provider_json" baseUrl)"
        api_key_env="$(agent_json_get "$provider_json" apiKeyEnv)"
        effort_level="$(agent_json_get "$provider_json" effortLevel)"
        provider_root="$(agent_deepseek_state_dir "$repo_dir" "$session" "$issue")"
        provider_home="$provider_root/home"
        xdg_config_home="$provider_root/xdg/config"
        xdg_data_home="$provider_root/xdg/data"
        cat > "$launcher" <<LAUNCHEOF
#!/bin/bash
set -euo pipefail
export WAVEMILL_SESSION='$session'
export WAVEMILL_ISSUE='$issue'
export WAVEMILL_DASHBOARD_PID='$dashboard_pid'
export WAVEMILL_PHASE='$phase_env'
export WAVEMILL_RESOLVED_MODEL='$model'
provider_root='$provider_root'
provider_home='$provider_home'
xdg_config_home='$xdg_config_home'
xdg_data_home='$xdg_data_home'
api_key_env='$api_key_env'
api_key_value="\${!api_key_env:-}"
if [[ -z "\$api_key_value" ]]; then
  echo "Error: DeepSeek model '$model' requires \$api_key_env to be set" >&2
  exit 1
fi
mkdir -p "\$provider_home" "\$xdg_config_home" "\$xdg_data_home"
chmod 700 "\$provider_root" "\$provider_home" "\$xdg_config_home" "\$xdg_data_home" 2>/dev/null || true
export HOME="\$provider_home"
export XDG_CONFIG_HOME="\$xdg_config_home"
export XDG_DATA_HOME="\$xdg_data_home"
export WAVEMILL_DEEPSEEK_PROVIDER_ROOT="\$provider_root"
export ANTHROPIC_BASE_URL='$base_url'
export ANTHROPIC_AUTH_TOKEN="\$api_key_value"
export ANTHROPIC_API_KEY="\$api_key_value"
export ANTHROPIC_MODEL='$model'
export ANTHROPIC_DEFAULT_OPUS_MODEL='$model'
export ANTHROPIC_DEFAULT_SONNET_MODEL='$model'
export ANTHROPIC_DEFAULT_HAIKU_MODEL='$model'
export CLAUDE_CODE_SUBAGENT_MODEL='$model'
export CLAUDE_CODE_EFFORT_LEVEL='${effort_level:-medium}'
claude${model_flag}${agent_flags} --dangerously-skip-permissions "\$(cat '$prompt_file')"
echo "[wavemill] Agent exited (\$?)"
LAUNCHEOF
      else
        cat > "$launcher" <<LAUNCHEOF
#!/bin/bash
export WAVEMILL_SESSION='$session'
export WAVEMILL_ISSUE='$issue'
export WAVEMILL_DASHBOARD_PID='$dashboard_pid'
export WAVEMILL_PHASE='$phase_env'
export WAVEMILL_RESOLVED_MODEL='$model'
if [[ -n '$issue' ]]; then
  printf '%s\n' "working" > "/tmp/${session}-${issue}-status.txt"
fi
claude${model_flag}${agent_flags} --dangerously-skip-permissions "\$(cat '$prompt_file')"
echo "[wavemill] Agent exited (\$?)"
LAUNCHEOF
      fi
      ;;
    codex)
      cat > "$launcher" <<LAUNCHEOF
#!/bin/bash
export WAVEMILL_SESSION='$session'
export WAVEMILL_ISSUE='$issue'
export WAVEMILL_DASHBOARD_PID='$dashboard_pid'
export WAVEMILL_PHASE='$phase_env'
export WAVEMILL_RESOLVED_MODEL='$model'
if [[ -n '$issue' ]]; then
  printf '%s\n' "working" > "/tmp/${session}-${issue}-status.txt"
fi
codex${model_flag}${agent_flags} --no-alt-screen "\$(cat '$prompt_file')"
echo "[wavemill] Agent exited (\$?)"
LAUNCHEOF
      ;;
    *)
      cat > "$launcher" <<LAUNCHEOF
#!/bin/bash
export WAVEMILL_SESSION='$session'
export WAVEMILL_ISSUE='$issue'
export WAVEMILL_DASHBOARD_PID='$dashboard_pid'
export WAVEMILL_PHASE='$phase_env'
export WAVEMILL_RESOLVED_MODEL='$model'
if [[ -n '$issue' ]]; then
  printf '%s\n' "working" > "/tmp/${session}-${issue}-status.txt"
fi
$agent_cmd${model_flag}${agent_flags} "\$(cat '$prompt_file')"
echo "[wavemill] Agent exited (\$?)"
LAUNCHEOF
      ;;
  esac

  chmod +x "$launcher"
  printf -v launcher_cmd '%q' "$launcher"

  if [[ "$prepare_rc" -ne 0 ]]; then
    _agent_log_warn "  Pane not ready for send-keys; using respawn-pane fallback"
    local wt_dir
    wt_dir=$(_pane_current_path "$target")
    tmux respawn-pane -k -t "$target" -c "$wt_dir" 2>/dev/null || true
    sleep 0.5
  fi

  local max_retries="${AGENT_LAUNCH_MAX_RETRIES:-3}"
  local settle_delay="${AGENT_LAUNCH_SETTLE_DELAY:-0.2}"
  local enter_delay="${AGENT_LAUNCH_ENTER_DELAY:-0.2}"
  local retry_delay="${AGENT_LAUNCH_RETRY_DELAY:-0.5}"
  local verify_wait="${AGENT_LAUNCH_VERIFY_WAIT:-5}"
  local verify_poll="${AGENT_LAUNCH_VERIFY_POLL:-0.3}"
  local retry=0

  while (( retry < max_retries )); do
    if (( retry > 0 )); then
      _agent_log_warn "  Retry $retry/$((max_retries - 1)): re-dispatching launcher to $target"
      sleep "$retry_delay"
    fi

    if ! agent_pane_is_ready "$session" "$window"; then
      _agent_log_warn "  Pre-send check: pane $target still busy, respawning before retry"
      local wt_dir
      wt_dir=$(_pane_current_path "$target")
      tmux respawn-pane -k -t "$target" -c "$wt_dir" 2>/dev/null || true
      sleep 0.5
    fi

    # A shell can report as the current pane command slightly before readline
    # is actually ready to consume pasted input after a respawn or prior exit.
    sleep "$settle_delay"
    local baseline_command baseline_children
    baseline_command=$(_pane_current_command "$target")
    baseline_children=$(_pane_child_count "$target")
    agent_send_tmux_guarded_command "$target" "$launcher_cmd" "$tmux_guard_exports"
    sleep "$enter_delay"

    if agent_verify_launch "$session" "$window" "$verify_wait" "$verify_poll" "$baseline_command" "$baseline_children"; then
      return 0
    fi

    tmux send-keys -t "$target" C-c 2>/dev/null || true
    sleep "$enter_delay"
    (( retry += 1 ))
  done

  _agent_log_warn "  FAILED: launcher did not start in $target after $max_retries attempts"
  return 1
}

# ============================================================================
# AGENT TERMINATION & PANE READINESS
# ============================================================================

_agent_log_debug() {
  [[ "${DEBUG_AGENT:-}" == "1" ]] || return 0
  echo "$(date '+%H:%M:%S') DEBUG: $*" >&2
}

_agent_log_warn() {
  local msg
  msg="$(date '+%H:%M:%S') WARN: $*"
  if [[ -n "${STATUS_LOG_FILE:-}" ]]; then
    printf '%s\n' "$msg" >> "$STATUS_LOG_FILE" 2>/dev/null || printf '%s\n' "$msg" >&2
  else
    printf '%s\n' "$msg" >&2
  fi
}

_pane_current_command() {
  local target="$1"
  tmux display-message -t "$target" -p '#{pane_current_command}' 2>/dev/null || true
}

_pane_current_path() {
  local target="$1"
  tmux display-message -t "$target" -p '#{pane_current_path}' 2>/dev/null || pwd
}

_pane_child_count() {
  local target="$1"
  local pane_pid
  pane_pid=$(tmux display-message -t "$target" -p '#{pane_pid}' 2>/dev/null || echo "")
  if [[ -z "$pane_pid" ]]; then
    echo ""
    return 0
  fi

  # pgrep exits 1 when there are no children; under pipefail that should still
  # count as zero children rather than aborting the caller.
  {
    pgrep -P "$pane_pid" 2>/dev/null || true
  } | wc -l | tr -d ' '
}

_pane_descendant_pids() {
  local root_pid="$1"
  local queue="$root_pid"
  local seen=" $root_pid "
  local descendants=""

  while [[ -n "$queue" ]]; do
    local next_queue=""
    local pid
    for pid in $queue; do
      local child
      while IFS= read -r child; do
        [[ -z "$child" ]] && continue
        if [[ "$seen" != *" $child "* ]]; then
          descendants+="$child"$'\n'
          next_queue+=" $child"
          seen+=" $child "
        fi
      done < <(pgrep -P "$pid" 2>/dev/null || true)
    done
    queue="${next_queue# }"
  done

  printf '%s' "$descendants"
}

_pane_command_is_shell() {
  local cmd="$1"
  case "$cmd" in
    bash|zsh|sh|fish|dash|ksh) return 0 ;;
    *) return 1 ;;
  esac
}

# Check if a tmux pane is dead or has an idle shell (no foreground children).
# If the pane is dead, it is respawned so a fresh shell is available.
#
# Args:
#   $1 = tmux target (session:window)
# Returns: 0 if pane is idle/ready, 1 if busy
_pane_is_dead_or_idle() {
  local target="$1"

  # Check if pane is dead (shell exited entirely)
  if tmux list-panes -t "$target" -F '#{pane_dead}' 2>/dev/null | grep -q '^1$'; then
    _agent_log_debug "Pane $target is dead, respawning"
    tmux respawn-pane -t "$target" 2>/dev/null || true
    sleep 0.5
    return 0
  fi

  local current_command
  current_command=$(_pane_current_command "$target")
  local children
  children=$(_pane_child_count "$target")
  if _pane_command_is_shell "$current_command"; then
    [[ "$children" == "0" ]] && return 0
    return 1
  fi

  [[ "$children" == "0" ]] && return 0

  return 1
}

# Terminate any running agent in a tmux pane and wait for the shell prompt.
# Uses a graduated escalation strategy:
#   1. Ctrl-C (interrupt generation) → /exit + Ctrl-D (polite exit)
#   2. Poll for process to exit
#   3. Ctrl-C×2 → Ctrl-\ (SIGQUIT) → pkill children
#
# This MUST be called before sending new commands to a pane that may have
# a running agent — otherwise send-keys goes into the agent, not the shell.
#
# Args:
#   $1 = tmux session name
#   $2 = tmux window name
#   $3 = max wait seconds (optional, default 15)
# Returns: 0 if shell is ready, 1 if timed out
agent_terminate_in_pane() {
  local session="$1"
  local window="$2"
  local max_wait="${3:-15}"
  local target
  target="$(agent_tmux_target "$session" "$window")" || return 1

  # Quick check — maybe nothing is running
  if _pane_is_dead_or_idle "$target"; then
    return 0
  fi

  # --- Phase 1: Polite exit ---
  # Ctrl-C interrupts any in-progress generation in Claude Code
  tmux send-keys -t "$target" Escape 2>/dev/null || true
  sleep 0.1
  tmux send-keys -t "$target" C-c 2>/dev/null || true
  sleep 1

  if _pane_is_dead_or_idle "$target"; then return 0; fi

  # /exit is the canonical way to exit Claude Code
  tmux send-keys -t "$target" "/exit" C-m 2>/dev/null || true
  sleep 2

  if _pane_is_dead_or_idle "$target"; then return 0; fi

  # Ctrl-D (EOF) exits Codex and most other CLIs
  # ONLY send if a foreground process is still running — Ctrl-D on an idle
  # shell exits the shell itself, which (without remain-on-exit) destroys
  # the tmux window and makes the pane unrecoverable.
  tmux send-keys -t "$target" C-d 2>/dev/null || true
  sleep 0.3

  # --- Phase 2: Poll for exit ---
  local elapsed=0
  while (( elapsed < max_wait )); do
    if _pane_is_dead_or_idle "$target"; then
      return 0
    fi
    sleep 1
    (( elapsed += 1 ))
  done

  # --- Phase 3: Escalate ---
  # Double Ctrl-C (rapid) — some CLIs exit on repeated interrupt
  tmux send-keys -t "$target" C-c C-c 2>/dev/null || true
  sleep 1

  if _pane_is_dead_or_idle "$target"; then
    return 0
  fi

  # Ctrl-\ sends SIGQUIT to the foreground process group
  tmux send-keys -t "$target" C-\\ 2>/dev/null || true
  sleep 1

  if _pane_is_dead_or_idle "$target"; then
    return 0
  fi

  # Last resort: directly kill child processes of the pane shell
  local pane_pid
  pane_pid=$(tmux display-message -t "$target" -p '#{pane_pid}' 2>/dev/null || echo "")
  if [[ -n "$pane_pid" ]]; then
    pkill -TERM -P "$pane_pid" 2>/dev/null || true
    local descendant_pids
    descendant_pids=$(_pane_descendant_pids "$pane_pid")
    if [[ -n "$descendant_pids" ]]; then
      echo "$descendant_pids" | xargs kill -TERM 2>/dev/null || true
    fi
    sleep 1
    if ! _pane_is_dead_or_idle "$target"; then
      pkill -KILL -P "$pane_pid" 2>/dev/null || true
      if [[ -n "$descendant_pids" ]]; then
        echo "$descendant_pids" | xargs kill -KILL 2>/dev/null || true
      fi
      sleep 0.5
    fi
  fi

  _pane_is_dead_or_idle "$target"
}

# Check if a tmux pane is ready to receive shell commands.
# Returns 0 if the pane's shell has no foreground child processes.
#
# Args:
#   $1 = tmux session name
#   $2 = tmux window name
# Returns: 0 if ready, 1 if busy
agent_pane_is_ready() {
  local session="$1"
  local window="$2"
  local target
  target="$(agent_tmux_target "$session" "$window")" || return 1

  if tmux list-panes -t "$target" -F '#{pane_dead}' 2>/dev/null | grep -q '^1$'; then
    _agent_log_debug "Pane $target is dead during readiness check, respawning"
    tmux respawn-pane -t "$target" 2>/dev/null || true
    sleep 0.5
  fi

  local current_command
  current_command=$(_pane_current_command "$target")
  local pane_pid
  pane_pid=$(tmux display-message -t "$target" -p '#{pane_pid}' 2>/dev/null || echo "")
  if [[ -z "$pane_pid" ]]; then
    # Some lifecycle tests use a minimal tmux mock that accepts send-keys but
    # cannot report pane metadata. In that environment, treat readiness as
    # unverifiable rather than hard-failing the launch.
    return 0
  fi

  if _pane_command_is_shell "$current_command"; then
    local children
    children=$(_pane_child_count "$target")
    [[ "$children" == "0" ]]
    return $?
  fi

  local children
  children=$(_pane_child_count "$target")
  [[ "$children" == "0" ]]
}

# Verify that a launched command actually started in the pane.
# Returns 0 once the pane leaves an idle shell state, 1 on timeout.
#
# Args:
#   $1 = tmux session name
#   $2 = tmux window name
#   $3 = max wait seconds (optional, default 5)
#   $4 = poll interval seconds (optional, default 0.3)
agent_verify_launch() {
  local session="$1"
  local window="$2"
  local max_wait="${3:-5}"
  local poll_interval="${4:-0.3}"
  local baseline_command="${5:-}"
  local baseline_children="${6:-}"
  local target
  target="$(agent_tmux_target "$session" "$window")" || return 1
  local saw_probe_data=0

  local attempts
  attempts=$(awk "BEGIN { v = $max_wait / $poll_interval; if (v < 1) v = 1; printf \"%d\", (v == int(v) ? v : int(v) + 1) }")

  local attempt=1
  local introspection_available=0
  while (( attempt <= attempts )); do
    local current_command children state_changed=0
    current_command=$(_pane_current_command "$target")
    children=$(_pane_child_count "$target")

    if (( attempt == 1 )) \
      && [[ -z "$baseline_command" ]] \
      && [[ -z "${baseline_children:-}" ]] \
      && [[ -z "$current_command" ]] \
      && [[ -z "$children" ]]; then
      _agent_log_warn "Launch could not be verified: tmux pane metadata unavailable for $target; assuming dispatch succeeded"
      return 0
    fi

    if [[ -n "$current_command" || -n "$children" ]]; then
      saw_probe_data=1
      introspection_available=1
    fi
    if [[ -n "$baseline_command" ]] || [[ -n "$baseline_children" ]]; then
      if [[ "$current_command" != "$baseline_command" ]] || [[ "$children" != "${baseline_children:-}" ]]; then
        state_changed=1
      fi
    else
      state_changed=1
    fi

    if (( state_changed )) && [[ -n "$current_command" ]] && ! _pane_command_is_shell "$current_command"; then
      _agent_log_debug "Launch verified: pane $target running '$current_command' (attempt $attempt/$attempts)"
      return 0
    fi

    if (( state_changed )) && [[ -n "$children" ]] && (( children > 0 )); then
      _agent_log_debug "Launch verified: pane $target has $children child process(es) (attempt $attempt/$attempts)"
      return 0
    fi

    if (( attempt < attempts )); then
      sleep "$poll_interval"
    fi
    (( attempt += 1 ))
  done

  if (( ! saw_probe_data )); then
    _agent_log_warn "Launch could not be verified after retries: tmux pane metadata unavailable for $target; assuming dispatch succeeded"
    return 0
  fi

  _agent_log_warn "Launch not verified: pane $target remained at an idle shell for ${max_wait}s"
  return 1
}

agent_wait_for_pane_ready() {
  local session="$1"
  local window="$2"
  local max_wait="${3:-3}"
  local poll_interval="${4:-0.2}"
  local abort_check_cmd="${5:-}"
  local target
  target="$(agent_tmux_target "$session" "$window")" || return 1

  local attempts
  attempts=$(awk "BEGIN { v = $max_wait / $poll_interval; if (v < 1) v = 1; printf \"%d\", (v == int(v) ? v : int(v) + 1) }")

  local attempt=1
  while (( attempt <= attempts )); do
    if [[ -n "$abort_check_cmd" ]] && eval "$abort_check_cmd"; then
      _agent_log_warn "  Pane $target readiness wait interrupted by workflow abort"
      return 2
    fi

    if agent_pane_is_ready "$session" "$window"; then
      if (( attempt > 1 )); then
        _agent_log_debug "Pane $target became ready after $attempt attempts"
      fi
      return 0
    fi

    local current_command children
    current_command=$(_pane_current_command "$target")
    children=$(_pane_child_count "$target")
    _agent_log_debug "Pane $target not ready (attempt $attempt/$attempts, current_command=${current_command:-unknown}, children=${children:-unknown})"
    sleep "$poll_interval"
    (( attempt += 1 ))
  done

  return 1
}

agent_prepare_pane_for_launch() {
  local session="$1"
  local window="$2"
  local terminate_wait="${3:-15}"
  local ready_wait="${4:-3}"
  local abort_check_cmd="${5:-}"
  local target
  target="$(agent_tmux_target "$session" "$window")" || return 1

  if ! agent_terminate_in_pane "$session" "$window" "$terminate_wait"; then
    _agent_log_warn "  Timed out waiting for previous agent to exit in $target"
  fi

  agent_wait_for_pane_ready "$session" "$window" "$ready_wait" 0.2 "$abort_check_cmd"
  local ready_rc=$?
  if [[ "$ready_rc" -eq 0 ]]; then
    return 0
  elif [[ "$ready_rc" -eq 2 ]]; then
    return 2
  fi

  _agent_log_warn "  Pane $target not ready, force-killing children..."
  local pane_pid
  pane_pid=$(tmux display-message -t "$target" -p '#{pane_pid}' 2>/dev/null || echo "")
  if [[ -n "$pane_pid" ]]; then
    pkill -TERM -P "$pane_pid" 2>/dev/null || true
    sleep 0.5
    agent_wait_for_pane_ready "$session" "$window" 1 0.2 "$abort_check_cmd"
    ready_rc=$?
    if [[ "$ready_rc" -eq 2 ]]; then
      return 2
    elif [[ "$ready_rc" -ne 0 ]]; then
      pkill -KILL -P "$pane_pid" 2>/dev/null || true
      sleep 0.5
    fi
  fi

  agent_wait_for_pane_ready "$session" "$window" 1.5 0.2 "$abort_check_cmd"
  ready_rc=$?
  if [[ "$ready_rc" -eq 0 ]]; then
    return 0
  elif [[ "$ready_rc" -eq 2 ]]; then
    return 2
  fi

  _agent_log_warn "  Pane $target STILL not ready after force-kill, respawning pane..."
  tmux respawn-pane -k -t "$target" 2>/dev/null || true
  sleep 0.5

  agent_wait_for_pane_ready "$session" "$window" 2 0.2 "$abort_check_cmd"
  ready_rc=$?
  if [[ "$ready_rc" -eq 2 ]]; then
    return 2
  elif [[ "$ready_rc" -ne 0 ]]; then
    _agent_log_warn "  Pane $target still not ready after respawn"
    return 1
  fi
}

# ============================================================================
# AGENT DISPLAY NAME
# ============================================================================

# Return a human-friendly display name for an agent command.
# Args: $1 = agent command name
agent_name() {
  local cmd="$1"
  case "$cmd" in
    claude) echo "Claude" ;;
    codex)  echo "Codex" ;;
    *)      echo "$cmd" ;;
  esac
}
