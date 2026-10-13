#!/usr/bin/env bash
# Shared helpers for tmux per-issue window title/status metadata.

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/task-identity.sh"

WAVEMILL_WINDOW_TITLE_PR_TTL=30

wavemill_window_branch_suffix() {
  local branch="${1:-}" suffix
  [[ -n "$branch" ]] || return 0
  suffix="${branch##*/}"
  [[ -n "$suffix" ]] && printf '%s\n' "$suffix" || printf '%s\n' "$branch"
}

wavemill_window_pr_badge() {
  local state="${1:-}" checks="${2:-}"
  case "$state" in
    MERGED) printf '✓\n' ;;
    CLOSED) printf '✗\n' ;;
    DRAFT) printf '…\n' ;;
    OPEN)
      case "$checks" in
        pass) printf '✓\n' ;;
        fail) printf '✗\n' ;;
        pending) printf '…\n' ;;
        *) printf '●\n' ;;
      esac
      ;;
    *) return 0 ;;
  esac
}

wavemill_window_phase_label() {
  local phase="${1:-}"
  case "$phase" in
    planning) printf 'plan\n' ;;
    executing|coding) printf 'code\n' ;;
    review|ready) printf 'review\n' ;;
    *) return 0 ;;
  esac
}

wavemill_window_trim_single_line() {
  local value="${1:-}" max_len="${2:-120}" trimmed
  trimmed="${value//$'\n'/ }"
  trimmed="${trimmed//$'\r'/ }"
  while [[ "$trimmed" == *"  "* ]]; do
    trimmed="${trimmed//  / }"
  done
  trimmed="${trimmed#${trimmed%%[![:space:]]*}}"
  trimmed="${trimmed%${trimmed##*[![:space:]]}}"
  if (( ${#trimmed} > max_len )); then
    printf '%s...\n' "${trimmed:0:$((max_len - 3))}"
  else
    printf '%s\n' "$trimmed"
  fi
}

wavemill_window_issue_display() {
  local issue="${1:-}" num
  if [[ "$issue" =~ ^${TASK_IDENTITY_TASK_ID_RE}$ ]]; then
    num="${issue##*-}"
    # allow-task-identity: display-only — strips the challenger suffix from an already-validated task ID to show the bare issue number; not identity derivation.
    num="${num%_c}"
    printf '%s\n' "$num"
  else
    printf '%s\n' "$issue"
  fi
}

wavemill_build_window_title() {
  local issue="${1:-}" branch="${2:-}" pr_number="${3:-}" pr_state="${4:-}" phase="${5:-}" notification="${6:-}"
  local issue_display suffix badge phase_label pr_segment note
  local -a parts=()

  issue_display="$(wavemill_window_issue_display "$issue")"
  suffix="$(wavemill_window_branch_suffix "$branch")"
  badge="$(wavemill_window_pr_badge "$pr_state")"
  phase_label="$(wavemill_window_phase_label "$phase")"
  note="$(wavemill_window_trim_single_line "$notification" 40)"

  [[ -n "$issue_display" ]] && parts+=("$issue_display")
  [[ -n "$suffix" ]] && parts+=("$suffix")
  if [[ -n "$pr_number" ]]; then
    pr_segment="PR#$pr_number"
    [[ -n "$badge" ]] && pr_segment+=" $badge"
    parts+=("$pr_segment")
  fi
  [[ -n "$phase_label" ]] && parts+=("$phase_label")
  [[ -n "$note" ]] && parts+=("$note")

  if ((${#parts[@]} == 0)); then
    return 0
  fi

  local joined="" i
  for ((i = 0; i < ${#parts[@]}; i++)); do
    if (( i > 0 )); then
      joined+=" · "
    fi
    joined+="${parts[i]}"
  done
  if (( ${#joined} > 140 )); then
    printf '%s...\n' "${joined:0:137}"
  else
    printf '%s\n' "$joined"
  fi
}

wavemill_build_status_right() {
  local ports_csv="${1:-}" model="${2:-}"
  local -a parts=()
  [[ -n "$ports_csv" ]] && parts+=("ports: $ports_csv")
  [[ -n "$model" ]] && parts+=("model: $model")
  ((${#parts[@]} > 0)) || return 0
  local joined="" i
  for ((i = 0; i < ${#parts[@]}; i++)); do
    if (( i > 0 )); then
      joined+=" | "
    fi
    joined+="${parts[i]}"
  done
  printf '%s\n' "$joined"
}

wavemill_hook_file_path() {
  local session="${1:-}" issue="${2:-}"
  [[ -n "$session" && -n "$issue" ]] || return 1
  printf '/tmp/wavemill-%s-%s.hook\n' "$session" "$issue"
}

wavemill_read_hook_json() {
  local session="${1:-}" issue="${2:-}" hook_file
  hook_file="$(wavemill_hook_file_path "$session" "$issue" 2>/dev/null || true)"
  [[ -n "$hook_file" && -f "$hook_file" ]] || { printf '{}\n'; return 0; }
  jq -c . "$hook_file" 2>/dev/null || printf '{}\n'
}

wavemill_update_hook_pr_state() {
  local hook_file="${1:-}" pr_json="${2:-}"
  [[ -n "$hook_file" && -f "$hook_file" ]] || return 0
  command -v jq >/dev/null 2>&1 || return 0
  declare -F state_mutate >/dev/null 2>&1 || return 0

  state_mutate "$hook_file" \
    '.pr_state = ((.pr_state // {}) + $pr)' \
    --argjson pr "$pr_json" >/dev/null 2>&1 || true
}

wavemill_fetch_pr_state() {
  local session="${1:-}" issue="${2:-}" branch="${3:-}" hook_file hook_json now cached fetched_at
  now="$(date +%s)"
  hook_file="$(wavemill_hook_file_path "$session" "$issue" 2>/dev/null || true)"
  hook_json="$(wavemill_read_hook_json "$session" "$issue")"

  cached="$(jq -c '.pr_state // {}' <<<"$hook_json" 2>/dev/null || printf '{}')"
  fetched_at="$(jq -r '.fetched_at // 0' <<<"$cached" 2>/dev/null || echo 0)"
  if [[ "$fetched_at" =~ ^[0-9]+$ ]] && (( now - fetched_at < WAVEMILL_WINDOW_TITLE_PR_TTL )); then
    printf '%s\n' "$cached"
    return 0
  fi

  if [[ -z "$branch" || "$branch" == "null" ]] || ! command -v gh >/dev/null 2>&1; then
    printf '%s\n' "$cached"
    return 0
  fi

  local fresh pr_number pr_state is_draft merged
  fresh="$(gh pr view "$branch" --json number,state,isDraft 2>/dev/null || true)"
  if [[ -n "$fresh" ]] && jq -e . >/dev/null 2>&1 <<<"$fresh"; then
    pr_number="$(jq -r '.number // empty' <<<"$fresh" 2>/dev/null || true)"
    pr_state="$(jq -r '.state // empty' <<<"$fresh" 2>/dev/null || true)"
    is_draft="$(jq -r '.isDraft // false' <<<"$fresh" 2>/dev/null || echo false)"
    if [[ "$is_draft" == "true" && "$pr_state" == "OPEN" ]]; then
      pr_state="DRAFT"
    fi
    merged="$(jq -cn --arg n "$pr_number" --arg s "$pr_state" --argjson now "$now" '{number:(if $n=="" then null else ($n|tonumber) end),state:$s,fetched_at:$now}')"
    wavemill_update_hook_pr_state "$hook_file" "$merged"
    printf '%s\n' "$merged"
    return 0
  fi

  printf '%s\n' "$cached"
}

wavemill_collect_pid_tree() {
  local root_pid="${1:-}" pid
  [[ "$root_pid" =~ ^[0-9]+$ ]] || return 0
  printf '%s\n' "$root_pid"
  command -v pgrep >/dev/null 2>&1 || return 0

  local -a queue=("$root_pid")
  local idx=0 children child
  while (( idx < ${#queue[@]} )); do
    pid="${queue[idx]}"
    idx=$((idx + 1))
    children="$(pgrep -P "$pid" 2>/dev/null || true)"
    while IFS= read -r child; do
      [[ "$child" =~ ^[0-9]+$ ]] || continue
      printf '%s\n' "$child"
      queue+=("$child")
    done <<< "$children"
  done
}

wavemill_discover_listening_ports() {
  local pane_pid="${1:-}"
  [[ "$pane_pid" =~ ^[0-9]+$ ]] || return 0
  command -v lsof >/dev/null 2>&1 || return 0

  local pids_csv lsof_out
  pids_csv="$(wavemill_collect_pid_tree "$pane_pid" | awk '/^[0-9]+$/' | sort -n | uniq | paste -sd, -)"
  [[ -n "$pids_csv" ]] || return 0

  lsof_out="$(lsof -nP -a -p "$pids_csv" -iTCP -sTCP:LISTEN 2>/dev/null || true)"
  [[ -n "$lsof_out" ]] || return 0

  awk '
    {
      n=split($9, a, ":")
      p=a[n]
      gsub(/[^0-9]/, "", p)
      if (p ~ /^[0-9]+$/) print p
    }
  ' <<< "$lsof_out" | sort -n | uniq | paste -sd, -
}

wavemill_resolve_model() {
  local hook_json="${1:-{}}" state_file="${2:-}" issue="${3:-}" model

  model="$(jq -r '.model // .agent_model // .resolved_model // empty' <<<"$hook_json" 2>/dev/null || true)"
  [[ -n "$model" ]] || model="${WAVEMILL_RESOLVED_MODEL:-}"

  if [[ -z "$model" && -n "$state_file" && -f "$state_file" ]]; then
    model="$(jq -r --arg issue "$issue" '
      .tasks[$issue].plannerModel //
      .tasks[$issue].coderModel //
      .tasks[$issue].reviewerModel //
      .tasks[$issue].challengeModel // empty
    ' "$state_file" 2>/dev/null || true)"
  fi

  printf '%s\n' "$model"
}

wavemill_apply_window_metadata() {
  local session="${1:-}" issue="${2:-}" window_target="${3:-}" state_file="${4:-${STATE_FILE:-}}"
  local hook_json branch phase slug worktree detail target candidate pane_pid ports_csv model pr_json pr_number pr_state title status_right target_path

  [[ -n "$session" && -n "$issue" ]] || return 0
  command -v tmux >/dev/null 2>&1 || return 0
  command -v jq >/dev/null 2>&1 || return 0

  hook_json="$(wavemill_read_hook_json "$session" "$issue")"

  branch=""
  phase=""
  slug=""
  if [[ -n "$state_file" && -f "$state_file" ]]; then
    branch="$(jq -r --arg issue "$issue" '.tasks[$issue].branch // empty' "$state_file" 2>/dev/null || true)"
    phase="$(jq -r --arg issue "$issue" '.tasks[$issue].phase // empty' "$state_file" 2>/dev/null || true)"
    slug="$(jq -r --arg issue "$issue" '.tasks[$issue].slug // empty' "$state_file" 2>/dev/null || true)"
    worktree="$(jq -r --arg issue "$issue" '.tasks[$issue].worktree // empty' "$state_file" 2>/dev/null || true)"
    [[ -n "$window_target" ]] || window_target="$(jq -r --arg issue "$issue" '.tasks[$issue].windowId // empty' "$state_file" 2>/dev/null || true)"
  fi

  target="$window_target"
  if [[ -n "$target" && -n "$worktree" ]]; then
    target_path="$(tmux display-message -p -t "$target" '#{pane_current_path}' 2>/dev/null || true)"
    [[ "$target_path" == "$worktree" ]] || target=""
  fi
  if [[ -z "$target" && -n "$slug" ]]; then
    target="$session:$issue-$slug"
    if [[ -n "$worktree" ]]; then
      target_path="$(tmux display-message -p -t "$target" '#{pane_current_path}' 2>/dev/null || true)"
      [[ "$target_path" == "$worktree" ]] || target=""
    fi
  fi
  if [[ -z "$target" ]]; then
    target="$(tmux list-windows -t "$session" -F '#{window_id}|#{window_name}' 2>/dev/null | awk -F'|' -v issue="$issue" '$2 ~ ("^" issue "-") {print $1; exit}')"
    if [[ -n "$target" && -n "$worktree" ]]; then
      target_path="$(tmux display-message -p -t "$target" '#{pane_current_path}' 2>/dev/null || true)"
      [[ "$target_path" == "$worktree" ]] || target=""
    fi
  fi
  if [[ -z "$target" && -n "$worktree" ]]; then
    while IFS='|' read -r candidate _name; do
      [[ -n "$candidate" ]] || continue
      target_path="$(tmux display-message -p -t "$candidate" '#{pane_current_path}' 2>/dev/null || true)"
      if [[ "$target_path" == "$worktree" ]]; then
        target="$candidate"
        break
      fi
    done < <(tmux list-windows -t "$session" -F '#{window_id}|#{window_name}' 2>/dev/null || true)
  fi
  [[ -n "$target" ]] || return 0

  detail="$(jq -r '.detail // empty' <<<"$hook_json" 2>/dev/null || true)"
  pr_json="$(wavemill_fetch_pr_state "$session" "$issue" "$branch")"
  pr_number="$(jq -r '.number // empty' <<<"$pr_json" 2>/dev/null || true)"
  pr_state="$(jq -r '.state // empty' <<<"$pr_json" 2>/dev/null || true)"

  pane_pid="$(tmux display-message -p -t "$target" '#{pane_pid}' 2>/dev/null || true)"
  ports_csv="$(wavemill_discover_listening_ports "$pane_pid" 2>/dev/null || true)"
  model="$(wavemill_resolve_model "$hook_json" "$state_file" "$issue")"

  title="$(wavemill_build_window_title "$issue" "$branch" "$pr_number" "$pr_state" "$phase" "$detail")"
  status_right="$(wavemill_build_status_right "$ports_csv" "$model")"

  [[ -n "$title" ]] && tmux rename-window -t "$target" "$title" >/dev/null 2>&1 || true
  tmux set-window-option -t "$target" status-right "$status_right" >/dev/null 2>&1 || true
  return 0
}
