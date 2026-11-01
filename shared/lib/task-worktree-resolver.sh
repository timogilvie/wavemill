#!/usr/bin/env bash
# HOK-3373 — bash twin of shared/lib/task-worktree-resolver.ts: the one
# answer to "which git worktree does this task's current run own?".
#
# Only `registered` permits `git -C <path>` against a task path. Every other
# status is UNKNOWN to its caller: never "touches nothing", never "the main
# checkout" (git walks up from a plain directory to the enclosing repo — the
# HOK-2595 fall-through that made one dead task "touch" all of main).
#
#   task_worktree_path_status <path> [repo_dir]
#       Prints registered|missing|invalid|protected|none. Returns 0 only for
#       registered. A path with no .git entry is never handed to git.
#   task_worktree_resolve <issue> [state_file]
#       Prints "<status>\t<path>" for the row's worktree; returns 0 only for
#       registered.
#   task_dir_ensure <dir>
#       mkdir -p <dir> unless it lies inside a task worktree (under
#       $WORKTREE_ROOT) whose root is not a live git worktree. Marker writers
#       for task state dirs use this so no writer recreates a dead worktree
#       path as a plain directory. Returns 1 (and creates nothing) when
#       refused.
#
# repo_dir defaults to $REPO_DIR, state_file to $STATE_FILE.

if [[ -n "${WAVEMILL_TASK_WORKTREE_RESOLVER_SH_LOADED:-}" ]]; then
  return 0
fi
WAVEMILL_TASK_WORKTREE_RESOLVER_SH_LOADED=1

task_worktree_path_status() {
  local path="${1:-}" repo_dir="${2:-${REPO_DIR:-}}" resolved_path resolved_repo identity
  if [[ -z "$path" ]]; then
    printf 'none\n'
    return 1
  fi
  if [[ "$path" == "/" ]]; then
    printf 'protected\n'
    return 1
  fi
  if [[ -n "$repo_dir" && -d "$repo_dir" && -d "$path" ]]; then
    resolved_path="$(cd "$path" 2>/dev/null && pwd -P)" || resolved_path="$path"
    resolved_repo="$(cd "$repo_dir" 2>/dev/null && pwd -P)" || resolved_repo="$repo_dir"
    if [[ "$resolved_path" == "$resolved_repo" ]]; then
      printf 'protected\n'
      return 1
    fi
  fi
  if [[ ! -e "$path" ]]; then
    printf 'missing\n'
    return 1
  fi
  if [[ ! -d "$path" || ! -e "$path/.git" ]]; then
    printf 'invalid\n'
    return 1
  fi
  if declare -F wavemill_task_worktree_identity >/dev/null 2>&1; then
    identity="$(wavemill_task_worktree_identity "$path" "$repo_dir" 2>/dev/null || true)"
    if [[ "$identity" != "valid" ]]; then
      printf 'invalid\n'
      return 1
    fi
  fi
  printf 'registered\n'
  return 0
}

task_worktree_resolve() {
  local issue="${1:-}" state_file="${2:-${STATE_FILE:-}}" path="" status
  if [[ -n "$issue" && -n "$state_file" && -f "$state_file" ]]; then
    path="$(jq -r --arg i "$issue" '.tasks[$i].worktree // empty' "$state_file" 2>/dev/null || true)"
  fi
  status="$(task_worktree_path_status "$path")"
  printf '%s\t%s\n' "$status" "$path"
  [[ "$status" == "registered" ]]
}

task_dir_ensure() {
  local dir="${1:-}" root rel first
  [[ -n "$dir" ]] || return 1
  [[ -d "$dir" ]] && return 0
  root="${WORKTREE_ROOT:-}"
  if [[ -n "$root" && "$dir" == "$root"/* ]]; then
    rel="${dir#"$root"/}"
    first="${rel%%/*}"
    if [[ -n "$first" && ! -e "$root/$first/.git" ]]; then
      declare -F log >/dev/null 2>&1 \
        && log "debug" "task_dir_ensure: refusing to recreate $dir (worktree $root/$first is not live)"
      return 1
    fi
  fi
  mkdir -p "$dir"
}
