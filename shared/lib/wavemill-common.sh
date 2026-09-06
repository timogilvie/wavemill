#!/usr/bin/env bash
# Wavemill Common Library
# Shared functions used across wavemill-mill.sh and wavemill-expand.sh

# Bounded-retry invariant helpers (HOK-2924): every relaunch path counts
# attempts, backs off, terminalizes at a ceiling, and resets on a new head SHA
# through this one module. Sourced here so the mill, monitor, and startup
# runner all inherit the same implementation.
# shellcheck source=bounded-retry.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/bounded-retry.sh"

# Default tmux window names for mill mode surfaces.
WAVEMILL_WINDOW_MILL="${WAVEMILL_WINDOW_MILL:-mill}"
WAVEMILL_WINDOW_BACKSTAGE="${WAVEMILL_WINDOW_BACKSTAGE:-backstage}"
WAVEMILL_BACKSTAGE_TEND_PANE_TITLE="${WAVEMILL_BACKSTAGE_TEND_PANE_TITLE:-Wavemill Tend Loop}"
WAVEMILL_BACKSTAGE_JOBS_PANE_TITLE="${WAVEMILL_BACKSTAGE_JOBS_PANE_TITLE:-Wavemill Jobs}"
WAVEMILL_BACKSTAGE_QUEUE_PANE_TITLE="${WAVEMILL_BACKSTAGE_QUEUE_PANE_TITLE:-Wavemill Pending + Queue}"
WAVEMILL_BACKSTAGE_OBSERVER_PANE_TITLE="${WAVEMILL_BACKSTAGE_OBSERVER_PANE_TITLE:-Wavemill Observer}"

# Dashboard footer tips should stay short enough to fit on one line with the
# stable refresh prefix.
declare -a WAVEMILL_USAGE_TIPS=(
  "wavemill expand HOK-1234: build a task packet from Linear"
  "wavemill plan: split large work into scoped issues"
  "wavemill eval: inspect workflow results and export data"
  "wavemill ready 42: check if a PR can merge"
  "wavemill tend --once: run one integration queue pass"
  "wavemill context init --force: refresh subsystem specs"
  "WAVEMILL_DASHBOARD_REFRESH_SECONDS=1..10: tune refresh"
  "Ctrl+B N: jump to the next done task"
  "challenge.autoMergeWinner=true: auto-merge challenge winners"
  "constraints.cleanupAfterMerge=true: clean merged constraints"
)

WAVEMILL_GIT_REMOTE_TIMEOUT_DEFAULT=15
WAVEMILL_GIT_REMOTE_TIMEOUT_MIN=1
WAVEMILL_GIT_REMOTE_TIMEOUT_MAX=600

wavemill_backstage_health_file() {
  local state_dir="${1:-${STATE_DIR:-}}"
  if [[ -n "$state_dir" ]]; then
    printf '%s\n' "$state_dir/backstage-health.json"
    return 0
  fi
  if [[ -n "${REPO_DIR:-}" ]]; then
    printf '%s\n' "$REPO_DIR/.wavemill/backstage-health.json"
    return 0
  fi
  return 1
}

wavemill_build_tend_loop_command() {
  local session_name="${1:?session required}"
  local repo_dir="${2:?repo dir required}"
  local tools_dir="${3:?tools dir required}"
  local issue_name="${4:-integration}"
  local command

  printf -v command 'exec env WAVEMILL_SESSION=%q WAVEMILL_ISSUE=%q npx tsx %q --loop --repo-dir %q' \
    "$session_name" "$issue_name" "$tools_dir/tend.ts" "$repo_dir"
  printf '%s\n' "$command"
}

wavemill_capture_tend_pane_output() {
  local pane_id="${1:?pane id required}" session_name="${2:?session required}" repo_dir="${3:?repo dir required}"
  local log_dir log_file pipe_command

  log_dir="$repo_dir/.wavemill/logs"
  log_file="$log_dir/tend-${session_name}.log"
  mkdir -p "$log_dir"
  printf -v pipe_command 'cat >> %q' "$log_file"
  tmux pipe-pane -o -t "$pane_id" "$pipe_command" >/dev/null 2>&1 || true
}

wavemill_build_observer_loop_command() {
  local session_name="${1:?session required}"
  local repo_dir="${2:?repo dir required}"
  local tools_dir="${3:?tools dir required}"
  local interval_seconds="${4:-120}"
  local max_log_lines="${5:-240}"
  local command

  printf -v command 'exec env WAVEMILL_SESSION=%q WAVEMILL_BACKSTAGE_OBSERVER_PANE_TITLE=%q WAVEMILL_OBSERVER_SERVICE=1 npx tsx %q --loop --compact --dry-run --repo-dir %q --session %q --interval %q --max-log-lines %q' \
    "$session_name" "$WAVEMILL_BACKSTAGE_OBSERVER_PANE_TITLE" "$tools_dir/observer.ts" "$repo_dir" "$session_name" "$interval_seconds" "$max_log_lines"
  printf '%s\n' "$command"
}

wavemill_set_tmux_pane_title() {
  local target="${1:?target required}" title="${2:?title required}"
  tmux select-pane -t "$target" -T "$title" >/dev/null 2>&1
}

# Area (width*height) of a tmux pane, or empty when it cannot be read.
wavemill_pane_area() {
  local pane="${1:?pane required}" dims width height
  command -v tmux >/dev/null 2>&1 || return 1
  dims="$(tmux display-message -p -t "$pane" '#{pane_width} #{pane_height}' 2>/dev/null)" || return 1
  read -r width height <<< "$dims"
  [[ "$width" =~ ^[0-9]+$ && "$height" =~ ^[0-9]+$ ]] || return 1
  printf '%s\n' "$(( width * height ))"
}

_tmux_window_target_exists() {
  local session="$1" target="$2" expected_path="${3:-}"
  local target_session target_path expected_real target_real pane_dead

  [[ -n "$session" && -n "$target" ]] || return 1
  target_session="$(tmux display-message -p -t "$target" '#{session_name}' 2>/dev/null || true)"
  [[ "$target_session" == "$session" ]] || return 1
  if [[ -n "$expected_path" ]]; then
    target_path="$(tmux display-message -p -t "$target" '#{pane_current_path}' 2>/dev/null || true)"
    if [[ -z "$target_path" ]]; then
      pane_dead="$(tmux list-panes -t "$target" -F '#{pane_dead}' 2>/dev/null | head -1 || true)"
      [[ "$pane_dead" == "1" ]] && return 0
      return 1
    fi
    expected_real="$(cd -P "$expected_path" 2>/dev/null && printf '%s\n' "$PWD" || printf '%s\n' "$expected_path")"
    target_real="$(cd -P "$target_path" 2>/dev/null && printf '%s\n' "$PWD" || printf '%s\n' "$target_path")"
    [[ "$target_real" == "$expected_real" ]] || return 1
  fi
  return 0
}

_tmux_target_join() {
  local session="$1" target="$2"
  [[ -n "$target" ]] || return 1
  case "$target" in
    @*|*:*) printf '%s\n' "$target" ;;
    *) printf '%s:%s\n' "$session" "$target" ;;
  esac
}

_tmux_task_window_target() {
  local session="$1" issue="$2" slug="$3" state_file="${4:-${STATE_FILE:-}}" wt_dir="${5:-}"
  local stored_target="" canonical target issue_number renamed_target

  if [[ -n "$state_file" && -f "$state_file" ]]; then
    stored_target="$(jq -r --arg issue "$issue" '.tasks[$issue].windowId // empty' "$state_file" 2>/dev/null || true)"
  fi
  if _tmux_window_target_exists "$session" "$stored_target" "$wt_dir"; then
    printf '%s\n' "$stored_target"
    return 0
  fi

  issue_number="${issue##*-}"
  renamed_target="$(tmux list-windows -t "$session" -F '#{window_id}|#{window_name}' 2>/dev/null \
    | awk -F'|' -v issue="$issue" -v issue_number="$issue_number" -v slug="$slug" '
        index($2, issue_number " · " slug " ·") == 1 { print $1; exit }
        index($2, issue_number " · " slug) == 1 { print $1; exit }
        index($2, issue " · " slug " ·") == 1 { print $1; exit }
        index($2, issue " · " slug) == 1 { print $1; exit }
      ')"
  if _tmux_window_target_exists "$session" "$renamed_target" "$wt_dir"; then
    printf '%s\n' "$renamed_target"
    return 0
  fi

  canonical="${issue}-${slug}"
  target="$(tmux list-windows -t "$session" -F '#{window_id}|#{window_name}' 2>/dev/null \
    | awk -F'|' -v name="$canonical" '$2 == name { print $1; exit }')"
  if _tmux_window_target_exists "$session" "$target" "$wt_dir"; then
    printf '%s\n' "$target"
    return 0
  fi

  if [[ -n "$wt_dir" ]]; then
    while IFS='|' read -r target _name; do
      [[ -n "$target" ]] || continue
      if _tmux_window_target_exists "$session" "$target" "$wt_dir"; then
        printf '%s\n' "$target"
        return 0
      fi
    done < <(tmux list-windows -t "$session" -F '#{window_id}|#{window_name}' 2>/dev/null || true)
  fi

  return 1
}

retry_state_file() {
  local session="$1"
  local issue="$2"
  printf '/tmp/wavemill-%s-%s.retry\n' "$session" "$issue"
}

reset_retry_count() {
  local retry_file
  retry_file="$(retry_state_file "$1" "$2")"
  rm -f "$retry_file" 2>/dev/null || true
}

wavemill_cleanup_run() {
  if command -v execute >/dev/null 2>&1; then
    execute "$@"
  else
    "$@"
  fi
}

_wavemill_archive_copy() {
  local src="$1" dest="$2"
  [[ -f "$src" ]] || return 0
  mkdir -p "$(dirname "$dest")" 2>/dev/null || {
    log_warn "  Failed to create artifact archive directory: $(dirname "$dest")"
    return 1
  }
  if cp "$src" "$dest" 2>/dev/null; then
    return 0
  fi
  log_warn "  Failed to archive artifact: $src"
  return 1
}

_wavemill_archive_json_copy() {
  local src="$1" dest="$2" label="${3:-artifact}"
  [[ -f "$src" ]] || return 0
  if jq -e . "$src" >/dev/null 2>&1; then
    _wavemill_archive_copy "$src" "$dest"
    return $?
  fi
  log_warn "  Skipping invalid ${label} archive: $src"
  return 0
}

# Archive stage artifacts from worktree before cleanup.
# Cleanup treats an archive copy failure as retryable and stops before removing
# the window, worktree, branches, retry state, or task state.
archive_stage_artifacts() {
  local issue="$1" slug="$2"
  local wt_dir="${WORKTREE_ROOT}/${slug}"
  local archive_dir="${REPO_DIR}/.wavemill/evals/artifacts/${issue}"
  local feature_dir="" dir status=0

  [[ -d "$wt_dir" ]] || return 0
  mkdir -p "$archive_dir" 2>/dev/null || {
    log_warn "  Failed to create artifact archive directory: $archive_dir"
    return 1
  }

  for dir in features bugs; do
    if [[ -d "$wt_dir/$dir/$slug" ]]; then
      feature_dir="$wt_dir/$dir/$slug"
      break
    fi
  done

  if [[ -n "$feature_dir" ]]; then
    _wavemill_archive_copy "$feature_dir/plan.md" "$archive_dir/plan.md" || status=1
    if [[ -f "$feature_dir/task-packet.md" ]]; then
      _wavemill_archive_copy "$feature_dir/task-packet.md" "$archive_dir/task-packet.md" || status=1
    elif [[ -f "$feature_dir/task-packet-header.md" ]]; then
      _wavemill_archive_copy "$feature_dir/task-packet-header.md" "$archive_dir/task-packet-header.md" || status=1
      _wavemill_archive_copy "$feature_dir/task-packet-details.md" "$archive_dir/task-packet-details.md" || status=1
    fi

    _wavemill_archive_json_copy "$feature_dir/.routing-complete" "$archive_dir/routing-complete.json" "route artifact" || status=1
    _wavemill_archive_json_copy "$feature_dir/.initial-route.json" "$archive_dir/initial-route.json" "route artifact" || status=1
    _wavemill_archive_json_copy "$feature_dir/.post-expansion-route.json" "$archive_dir/post-expansion-route.json" "route artifact" || status=1
    _wavemill_archive_copy "$feature_dir/routing.jsonl" "$archive_dir/routing.jsonl" || status=1
    _wavemill_archive_copy "$feature_dir/.coding-uncommitted-output.resolved.jsonl" "$archive_dir/coding-uncommitted-output.resolved.jsonl" || status=1
    _wavemill_archive_json_copy "$feature_dir/.operator-intervention.json" "$archive_dir/operator-intervention.json" "operator intervention" || status=1

    local stage result_file sidecar sidecar_name
    for stage in planning coding review; do
      result_file="$feature_dir/.${stage}-result.json"
      _wavemill_archive_json_copy "$result_file" "$archive_dir/${stage}-result.json" "stage result" || status=1

      for sidecar in "$feature_dir/.${stage}-result.attempt-"*-failed.json; do
        [[ -f "$sidecar" ]] || continue
        sidecar_name="$(basename "$sidecar")"
        sidecar_name="${sidecar_name#.}"
        _wavemill_archive_json_copy "$sidecar" "$archive_dir/$sidecar_name" "failed attempt" || status=1
      done
    done

    local evidence_file evidence_name
    for evidence_name in ".challenge-aborted.json" ".coding-failure-handoff.json"; do
      evidence_file="$feature_dir/$evidence_name"
      _wavemill_archive_json_copy "$evidence_file" "$archive_dir/$evidence_name" "failure evidence" || status=1
    done

    if [[ -d "$feature_dir/.stale-artifacts" ]]; then
      local stale_file stale_rel stale_dest
      while IFS= read -r stale_file; do
        [[ -f "$stale_file" ]] || continue
        stale_rel="${stale_file#$feature_dir/.stale-artifacts/}"
        stale_dest="$archive_dir/stale-artifacts/$stale_rel"
        _wavemill_archive_copy "$stale_file" "$stale_dest" || status=1
      done < <(find "$feature_dir/.stale-artifacts" -type f \( -name '.challenge-aborted.json' -o -name '.coding-failure-handoff.json' -o -name '*.jsonl' \) 2>/dev/null)
    fi

    local json_file jsonl_ref jsonl_path jsonl_dest jsonl_base
    while IFS= read -r json_file; do
      [[ -f "$json_file" ]] || continue
      while IFS= read -r jsonl_ref; do
        [[ -n "$jsonl_ref" ]] || continue
        jsonl_path=""
        if [[ "$jsonl_ref" = /* && -f "$jsonl_ref" ]]; then
          jsonl_path="$jsonl_ref"
        elif [[ -f "$feature_dir/$jsonl_ref" ]]; then
          jsonl_path="$feature_dir/$jsonl_ref"
        elif [[ -f "$wt_dir/$jsonl_ref" ]]; then
          jsonl_path="$wt_dir/$jsonl_ref"
        fi
        [[ -n "$jsonl_path" ]] || continue
        jsonl_base="$(basename "$jsonl_path")"
        jsonl_dest="$archive_dir/native-sessions/$jsonl_base"
        _wavemill_archive_copy "$jsonl_path" "$jsonl_dest" || status=1
      done < <(jq -r '.. | select(type == "string" and test("\\.jsonl$"))' "$json_file" 2>/dev/null || true)
    done < <(find "$feature_dir" -maxdepth 3 -type f \( -name '*.json' -o -name '.*.json' \) 2>/dev/null)

    _wavemill_archive_copy "$feature_dir/trace.jsonl" "$archive_dir/trace.jsonl" || status=1

    local _tid _iid _sl
    _tid=$(trace_read_id "$feature_dir" 2>/dev/null || true)
    if [[ -n "$_tid" ]]; then
      _iid=$(jq -r '.issueId // empty' "$feature_dir/.trace-context.json" 2>/dev/null || true)
      _sl=$(jq -r '.slug // empty' "$feature_dir/.trace-context.json" 2>/dev/null || true)
      if [[ -n "$_iid" && -n "$_sl" ]]; then
        trace_append_event "$feature_dir" "$_tid" "$_iid" "$_sl" "cleanup" "cleanup_archived" "ok" "" "" \
          "$(jq -cn --arg dir "$archive_dir" '{meta:{archiveDir:$dir}}' 2>/dev/null || echo '{}')" 2>/dev/null || true
        _wavemill_archive_copy "$feature_dir/trace.jsonl" "$archive_dir/trace.jsonl" || status=1
      fi
    fi
  fi

  local count
  count=$(find "$archive_dir" -type f 2>/dev/null | wc -l | tr -d ' ')
  if [[ "$count" -gt 0 ]]; then
    log "debug" "Archived $count stage artifact(s) to .wavemill/evals/artifacts/$issue/"
  fi
  return "$status"
}

cleanup_remote_task_branch() {
  local issue="$1" task_branch="$2" pr="${3:-}"
  local deletion_allowed="false"
  if [[ "$task_branch" == "main" || "$task_branch" == "master" ]]; then
    log_warn "  Refusing to delete protected branch: $task_branch"
    return 0
  fi
  case "$task_branch" in
    task/*) ;;
    *) log "debug" "$issue: retaining non-task remote branch $task_branch"; return 0 ;;
  esac

  if [[ -n "${STATE_FILE:-}" && -f "$STATE_FILE" ]]; then
    deletion_allowed="$(jq -r --arg issue "$issue" '
      .tasks[$issue].lifecycle.launchContract.remoteBranchDeletionPolicy as $policy
      | if ($policy.allowed == true and (($policy.mode // "") | length > 0)) then "true" else "false" end
    ' "$STATE_FILE" 2>/dev/null || echo "false")"
  fi
  if [[ "$deletion_allowed" != "true" ]]; then
    log "debug" "$issue: retaining remote branch $task_branch (no authoritative lifecycle deletion policy)"
    return 0
  fi

  if [[ -z "$pr" ]]; then
    log "debug" "$issue: retaining remote branch $task_branch (no PR recorded)"
    return 0
  fi

  local state
  state=$(pr_state "$pr")
  if [[ "$state" != "MERGED" ]]; then
    log "debug" "$issue: retaining remote branch $task_branch (PR #$pr state=${state:-unknown}, not merged)"
    return 0
  fi

  local ls_remote_rc
  if _with_timeout "$API_TIMEOUT" git -C "$REPO_DIR" ls-remote --exit-code --heads origin "refs/heads/$task_branch" >/dev/null 2>&1; then
    ls_remote_rc=0
  else
    ls_remote_rc=$?
  fi
  if [[ "$ls_remote_rc" == "2" ]]; then
    log "debug" "$issue: remote branch already absent: $task_branch"
    return 0
  elif [[ "$ls_remote_rc" != "0" ]]; then
    log_warn "  Remote branch cleanup could not verify branch (retained): $task_branch"
    return 1
  fi

  if wavemill_cleanup_run _with_timeout "$API_TIMEOUT" git -C "$REPO_DIR" push origin --delete "$task_branch" >>"${MILL_LOG_FILE:-/dev/null}" 2>&1; then
    log "debug" "Deleted remote branch: $task_branch"
  else
    log_warn "  Remote branch cleanup failed (retained): $task_branch"
    return 1
  fi
}

_wavemill_write_preserved_branch_incident() {
  local reason="$1" branch="$2" wt_dir="$3" base_branch="$4" commits_ahead="$5" commit_shas="$6" caller="${7:-cleanup}"
  local base_sha="${8:-}" local_head_sha="${9:-}" remote_head_sha="${10:-}" verification_reason="${11:-}"
  local incident_dir marker_name marker_path tmp_path created_at

  [[ -n "${REPO_DIR:-}" && -n "$branch" ]] || return 1

  incident_dir="$REPO_DIR/.wavemill/incidents/preserved-branches"
  marker_name="${branch//\//__}.json"
  marker_path="$incident_dir/$marker_name"
  created_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

  mkdir -p "$incident_dir" 2>/dev/null || return 1
  tmp_path="$(mktemp "$incident_dir/.${marker_name}.XXXXXX")" || return 1
  if jq -cn \
    --arg reason "$reason" \
    --arg branch "$branch" \
    --arg worktree "$wt_dir" \
    --arg baseBranch "$base_branch" \
    --arg commitsAhead "$commits_ahead" \
    --arg commitShas "$commit_shas" \
    --arg createdAt "$created_at" \
    --arg caller "$caller" \
    --arg baseSha "$base_sha" \
    --arg localHeadSha "$local_head_sha" \
    --arg remoteHeadSha "$remote_head_sha" \
    --arg verificationReason "$verification_reason" \
    '{
      reason: $reason,
      branch: $branch,
      worktree: $worktree,
      baseBranch: $baseBranch,
      commitsAhead: (if ($commitsAhead | test("^[0-9]+$")) then ($commitsAhead | tonumber) else null end),
      commitShas: ($commitShas | split("\n") | map(select(length > 0))),
      createdAt: $createdAt,
      caller: $caller
    }
    | if $baseSha != "" then . + {baseSha: $baseSha} else . end
    | if $localHeadSha != "" then . + {localHeadSha: $localHeadSha} else . end
    | if $remoteHeadSha != "" then . + {remoteHeadSha: $remoteHeadSha} else . end
    | if $verificationReason != "" then . + {verificationReason: $verificationReason} else . end' > "$tmp_path"; then
    mv "$tmp_path" "$marker_path"
    return 0
  fi

  rm -f "$tmp_path" 2>/dev/null || true
  return 1
}

safe_remove_task_worktree_and_branch() {
  local wt_dir="${1:-}"
  local task_branch="${2:-}"
  local base_branch="${3:-${BASE_BRANCH:-main}}"
  local caller="${4:-cleanup}"
  local branch_is_deletable="false"
  local dirty_status=""
  local local_branch_exists="false"
  local remote_branch_exists="false"
  local base_ref=""
  local base_sha=""
  local local_head_sha=""
  local initial_head_sha=""
  local verified_head_sha=""
  local remote_head_sha=""
  local remote_timeout=""
  local remote_ref=""
  local remote_output=""
  local remote_lookup_rc=0
  local fetch_rc=0
  local commits_ahead=""
  local commit_shas=""
  local rev_list_ok="false"
  local merged_to_base="false"
  local merged_to_current_head="false"
  local remote_contains_head="false"
  local preservation_reason="unpushed_commits"
  local verification_reason=""

  if [[ "$task_branch" == "main" || "$task_branch" == "master" ]]; then
    log_warn "  Refusing to delete protected branch: $task_branch"
    return 0
  fi

  if [[ -n "$task_branch" ]]; then
    case "$task_branch" in
      task/*) branch_is_deletable="true" ;;
      *) log "debug" "$caller: retaining non-task local branch $task_branch" ;;
    esac
  fi

  if [[ -n "$wt_dir" && -d "$wt_dir" ]]; then
    if ! dirty_status="$(git -C "$wt_dir" status --porcelain --untracked-files=all 2>/dev/null)"; then
      if ! _wavemill_write_preserved_branch_incident "dirty_worktree" "$task_branch" "$wt_dir" "$base_branch" "" "" "$caller"; then
        log_warn "  Failed to write preserved-branch incident marker for $task_branch"
      fi
      log_warn "  PRESERVED_DIRTY_WORKTREE: ${wt_dir} status could not be inspected; retained (branch=${task_branch})."
      return 10
    fi
    if [[ -n "$dirty_status" ]]; then
      if ! _wavemill_write_preserved_branch_incident "dirty_worktree" "$task_branch" "$wt_dir" "$base_branch" "" "" "$caller"; then
        log_warn "  Failed to write preserved-branch incident marker for $task_branch"
      fi
      log_warn "  PRESERVED_DIRTY_WORKTREE: ${wt_dir} has uncommitted changes; retained (branch=${task_branch})."
      return 10
    fi
  fi

  if [[ "$branch_is_deletable" == "true" ]] \
    && git -C "$REPO_DIR" show-ref --verify --quiet "refs/heads/$task_branch" 2>/dev/null; then
    local_branch_exists="true"

    if ! initial_head_sha="$(git -C "$REPO_DIR" rev-parse --verify "${task_branch}^{commit}" 2>/dev/null)"; then
      verification_reason="local_head_unresolvable"
    else
      local_head_sha="$initial_head_sha"
    fi

    remote_timeout="$(wavemill_git_remote_timeout_seconds)"
    if [[ -z "$verification_reason" ]]; then
      wavemill_git_remote_with_timeout "$remote_timeout" -C "$REPO_DIR" fetch origin \
        "refs/heads/${base_branch}:refs/remotes/origin/${base_branch}" >/dev/null 2>&1 || fetch_rc=$?
      if (( fetch_rc != 0 )); then
        verification_reason="base_fetch_failed:$fetch_rc"
      fi
    fi

    if [[ -z "$verification_reason" ]]; then
      base_ref="refs/remotes/origin/$base_branch"
      if base_sha="$(git -C "$REPO_DIR" rev-parse --verify "${base_ref}^{commit}" 2>/dev/null)"; then
        :
      else
        base_ref=""
        verification_reason="origin_base_unresolvable"
      fi
    fi

    if [[ -z "$verification_reason" && -n "$base_ref" ]]; then
      if git -C "$REPO_DIR" merge-base --is-ancestor "$task_branch" "$base_ref" 2>/dev/null; then
        merged_to_base="true"
      fi
      if git -C "$REPO_DIR" merge-base --is-ancestor "$task_branch" HEAD 2>/dev/null; then
        merged_to_current_head="true"
      fi
      if commits_ahead="$(git -C "$REPO_DIR" rev-list --count "${base_ref}..${task_branch}" 2>/dev/null)" \
        && [[ "$commits_ahead" =~ ^[0-9]+$ ]]; then
        rev_list_ok="true"
        commit_shas="$(git -C "$REPO_DIR" rev-list "${base_ref}..${task_branch}" 2>/dev/null || true)"
      fi
    fi

    if [[ -z "$verification_reason" && "$rev_list_ok" != "true" ]]; then
      verification_reason="rev_list_failed"
    fi

    if [[ -z "$verification_reason" && "$merged_to_base" != "true" ]] && (( commits_ahead > 0 )); then
      remote_ref="refs/heads/$task_branch"
      remote_lookup_rc=0
      if remote_output="$(wavemill_git_remote_with_timeout "$remote_timeout" -C "$REPO_DIR" ls-remote --heads origin "$remote_ref" 2>/dev/null)"; then
        remote_head_sha="$(printf '%s\n' "$remote_output" | awk '{print $1; exit}')"
        :
      else
        remote_lookup_rc=$?
        verification_reason="remote_head_lookup_failed:$remote_lookup_rc"
      fi

      if [[ -z "$verification_reason" ]]; then
        if [[ -n "$remote_head_sha" ]]; then
          remote_branch_exists="true"
          if [[ "$remote_head_sha" == "$local_head_sha" ]]; then
            remote_contains_head="true"
          else
            fetch_rc=0
            wavemill_git_remote_with_timeout "$remote_timeout" -C "$REPO_DIR" fetch origin \
              "refs/heads/${task_branch}:refs/remotes/origin/${task_branch}" >/dev/null 2>&1 || fetch_rc=$?
            if (( fetch_rc != 0 )); then
              verification_reason="remote_task_fetch_failed:$fetch_rc"
            elif git -C "$REPO_DIR" cat-file -e "${remote_head_sha}^{commit}" 2>/dev/null \
              && git -C "$REPO_DIR" merge-base --is-ancestor "$local_head_sha" "$remote_head_sha" 2>/dev/null; then
              remote_contains_head="true"
            fi
          fi
        fi

        if [[ -z "$verification_reason" && "$remote_contains_head" != "true" ]]; then
          verification_reason="remote_missing_local_head"
        fi
      fi
    fi

    if [[ -z "$verification_reason" ]]; then
      if ! verified_head_sha="$(git -C "$REPO_DIR" rev-parse --verify "${task_branch}^{commit}" 2>/dev/null)" \
        || [[ "$verified_head_sha" != "$initial_head_sha" ]]; then
        local_head_sha="${verified_head_sha:-$local_head_sha}"
        verification_reason="local_head_changed"
      fi
    fi

    if [[ -n "$verification_reason" ]]; then
      commit_shas="$(git -C "$REPO_DIR" rev-list --max-count=20 "$task_branch" 2>/dev/null || true)"
      if [[ "$verification_reason" == remote_missing_local_head ]]; then
        commits_ahead="${commits_ahead:-}"
      else
        commits_ahead=""
      fi
      if ! _wavemill_write_preserved_branch_incident "$preservation_reason" "$task_branch" "$wt_dir" "$base_branch" "$commits_ahead" "$commit_shas" "$caller" "$base_sha" "$local_head_sha" "$remote_head_sha" "$verification_reason"; then
        log_warn "  Failed to write preserved-branch incident marker for $task_branch"
      fi
      log_warn "  PRESERVED_UNPUSHED_WORK: $task_branch cleanup lacked authoritative git evidence ($verification_reason); retained. Recover with: git -C $REPO_DIR push origin $task_branch"
      return 10
    fi

    if (( commits_ahead > 0 )) && [[ "$remote_branch_exists" != "true" && "$merged_to_base" != "true" ]]; then
      if ! _wavemill_write_preserved_branch_incident "unpushed_commits" "$task_branch" "$wt_dir" "$base_branch" "$commits_ahead" "$commit_shas" "$caller" "$base_sha" "$local_head_sha" "$remote_head_sha" "remote_branch_absent"; then
        log_warn "  Failed to write preserved-branch incident marker for $task_branch"
      fi
      log_warn "  PRESERVED_UNPUSHED_WORK: $task_branch has $commits_ahead unpushed commit(s) not on origin/${base_branch}; retained. Recover with: git -C $REPO_DIR push origin $task_branch"
      return 10
    fi
  fi

  if [[ -n "$wt_dir" && -d "$wt_dir" ]]; then
    if wavemill_cleanup_run git -C "$REPO_DIR" worktree remove "$wt_dir" >>"${MILL_LOG_FILE:-/dev/null}" 2>/dev/null; then
      log "debug" "Removed worktree: $wt_dir"
    else
      log_warn "  Worktree cleanup failed: $wt_dir"
      return 20
    fi
  fi

  if [[ "$local_branch_exists" == "true" ]]; then
    local branch_delete_flag="-D"
    [[ "$merged_to_current_head" == "true" ]] && branch_delete_flag="-d"
    if wavemill_cleanup_run git -C "$REPO_DIR" branch "$branch_delete_flag" "$task_branch" >>"${MILL_LOG_FILE:-/dev/null}" 2>/dev/null; then
      log "debug" "Deleted local branch: $task_branch"
    else
      log_warn "  Local branch cleanup failed after worktree removal: $task_branch"
      return 20
    fi
  fi

  return 0
}

# Canonical completed-task cleanup order:
# 1. archive artifacts, 2. close pane/window, 3. remove worktree,
# 4. remove local branch, 5. remove eligible remote branch,
# 6. prune hooks/worktrees, 7. reset retry state and remove task state.
cleanup_completed_task() {
  local issue="$1"
  local slug="$2"
  local completion_reason="${3:-}"
  local win="$issue-$slug"
  local target=""
  local target_gone="false"
  local pr=""

  pr=$(jq -r --arg i "$issue" '.tasks[$i].pr // empty' "$STATE_FILE" 2>/dev/null || true)
  if [[ -z "$pr" ]] && declare -p PR_BY_ISSUE >/dev/null 2>&1; then
    pr="${PR_BY_ISSUE[$issue]:-}"
  fi

  set_task_lifecycle_disposition "$issue" "" "reaping" "" "cleanup_completed_task" 2>/dev/null || true

  if ! archive_stage_artifacts "$issue" "$slug"; then
    set_task_lifecycle_disposition "$issue" "" "verification-required" "archive-stage-artifacts-failed" "cleanup_completed_task" 2>/dev/null || true
    log_warn "  $issue cleanup could not archive stage artifacts; keeping task state"
    return 1
  fi

  target="$(_tmux_task_window_target "$SESSION" "$issue" "$slug" "${STATE_FILE:-}" "${WORKTREE_ROOT}/${slug}" 2>/dev/null || true)"
  if [[ -z "$target" ]] || ! command -v tmux >/dev/null 2>&1; then
    target_gone="true"
  else
    wavemill_cleanup_run tmux kill-window -t "$(_tmux_target_join "$SESSION" "$target")" 2>/dev/null || true
    if ! _tmux_window_target_exists "$SESSION" "$target"; then
      target_gone="true"
    fi
  fi

  if [[ "$target_gone" != "true" ]]; then
    set_task_lifecycle_disposition "$issue" "" "retained" "tmux-window-close-failed" "cleanup_completed_task" 2>/dev/null || true
    set_window_attention_state "$win" "needs-user"
    log_warn "  $issue cleanup could not close tmux window; keeping task state"
    return 1
  fi

  log "debug" "Closed window: $win"

  local wt_dir="${WORKTREE_ROOT}/${slug}"
  local task_branch="task/${slug}"
  local cleanup_rc=0
  safe_remove_task_worktree_and_branch "$wt_dir" "$task_branch" "${BASE_BRANCH:-main}" "cleanup_completed_task" || cleanup_rc=$?
  if [[ "$cleanup_rc" -eq 20 ]]; then
    set_task_lifecycle_disposition "$issue" "" "retained" "worktree-or-local-branch-cleanup-failed" "cleanup_completed_task" 2>/dev/null || true
    return 1
  fi
  if [[ "$cleanup_rc" -eq 10 ]]; then
    set_task_lifecycle_disposition "$issue" "" "verification-required" "local-work-preserved" "cleanup_completed_task" 2>/dev/null || true
    set_window_attention_state "$win" "needs-user"
    log_warn "  $issue cleanup preserved local work; keeping task state"
    return 1
  fi

  if ! cleanup_remote_task_branch "$issue" "$task_branch" "$pr"; then
    set_task_lifecycle_disposition "$issue" "" "verification-required" "remote-branch-cleanup-unverified" "cleanup_completed_task" 2>/dev/null || true
    return 1
  fi

  wavemill_cleanup_run git -C "$REPO_DIR" worktree prune >>"${MILL_LOG_FILE:-/dev/null}" 2>/dev/null || true
  reconciliation_lease_release "${WORKTREE_ROOT}/${slug}/features/${slug}" 2>/dev/null || true
  rm -f "${WORKTREE_ROOT}/${slug}/features/${slug}/.pane-release-blocked.json" 2>/dev/null || true
  rm -f "/tmp/wavemill-${SESSION}-${issue}.hook" 2>/dev/null || true
  reset_retry_count "$SESSION" "$issue" 2>/dev/null || true
  set_task_lifecycle_disposition "$issue" "" "reaped" "" "cleanup_completed_task" 2>/dev/null || true
  remove_task_state "$issue"
  CLEANED["$issue"]=1

  if [[ -n "$completion_reason" ]]; then
    log "$issue: Complete ($completion_reason)"
  else
    log "$issue: Complete"
  fi
}

# Canonical challenge-eval retry ceilings (HOK-2924). Formerly duplicated in
# wavemill-mill.sh and the monitor; both scopes source this file.
challenge_eval_retry_max_attempts() {
  local max_attempts
  max_attempts=$(wavemill_load_config "$REPO_DIR" | jq -r '.challenge.eval.retryMaxAttempts // 1' 2>/dev/null || echo "1")
  if [[ "$max_attempts" =~ ^[0-9]+$ ]]; then
    printf '%s\n' "$max_attempts"
  else
    printf '1\n'
  fi
}

challenge_eval_hard_failure_max_retries() {
  local max_retries
  if [[ -n "${WAVEMILL_EVAL_HARD_FAILURE_MAX_RETRIES+x}" && "$WAVEMILL_EVAL_HARD_FAILURE_MAX_RETRIES" =~ ^[0-9]+$ ]]; then
    printf '%s\n' "$WAVEMILL_EVAL_HARD_FAILURE_MAX_RETRIES"
    return
  fi

  max_retries=$(wavemill_load_config "$REPO_DIR" | jq -r '.challenge.eval.hardFailureRetryMaxAttempts // 2' 2>/dev/null || echo "2")
  if [[ "$max_retries" =~ ^[0-9]+$ ]]; then
    printf '%s\n' "$max_retries"
  else
    printf '2\n'
  fi
}

# Canonical hard-failure resolution uses the monitor's live behavior: record
# only concrete terminal evidence and never perform loser cleanup from this path.
resolve_challenge_pair_hard_failure() {
  local pair_id="$1"
  local primary_key="$pair_id" challenger_key="${pair_id}_c"
  local primary_exists challenger_exists resolve_output resolve_status resolve_reason
  local retry_max primary_failed challenger_failed primary_completed challenger_completed
  local primary_retry_count challenger_retry_count failed_sides_csv terminal_reason outcome
  local primary_pr challenger_pr primary_model challenger_model primary_pr_url challenger_pr_url
  local winner winner_model rationale timestamp record_json

  [[ -n "$pair_id" ]] || return 1

  if challenge_pair_record_exists "$pair_id"; then
    mark_challenge_compared "$pair_id" "record"
    return 0
  fi

  retry_max=$(challenge_eval_hard_failure_max_retries)
  primary_exists=$(read_state_value "false" --arg i "$primary_key" '.tasks[$i] != null')
  challenger_exists=$(read_state_value "false" --arg i "$challenger_key" '.tasks[$i] != null')
  primary_failed=$(read_state_value "false" --arg i "$primary_key" '.tasks[$i].evalFailed // false')
  challenger_failed=$(read_state_value "false" --arg i "$challenger_key" '.tasks[$i].evalFailed // false')
  primary_completed=$(read_state_value "false" --arg i "$primary_key" '.tasks[$i].evalCompleted // false')
  challenger_completed=$(read_state_value "false" --arg i "$challenger_key" '.tasks[$i].evalCompleted // false')
  primary_retry_count=$(read_state_value "0" --arg i "$primary_key" '.tasks[$i].evalHardFailureRetryCount // 0')
  challenger_retry_count=$(read_state_value "0" --arg i "$challenger_key" '.tasks[$i].evalHardFailureRetryCount // 0')

  if [[ "$primary_exists" != "true" || "$challenger_exists" != "true" ]]; then
    resolve_output=$(npx tsx "$TOOLS_DIR/resolve-orphan-challenge-pair.ts" \
      --pair-id "$pair_id" \
      --reason orphan-sibling \
      --repo-dir "$REPO_DIR" 2>/dev/null || true)
    resolve_status=$(jq -r '.status // empty' <<<"$resolve_output" 2>/dev/null || true)
    if [[ "$resolve_status" == "resolved" || "$resolve_status" == "already-resolved" ]]; then
      mark_challenge_compared "$pair_id" "record"
      if [[ "$resolve_status" == "resolved" ]]; then
        resolve_reason=$(jq -r '.reason // "orphan-sibling"' <<<"$resolve_output" 2>/dev/null || echo "orphan-sibling")
        log_warn "challenge pair $pair_id resolved via $resolve_reason"
      fi
      return 0
    fi
  fi

  failed_sides_csv=""
  [[ "$primary_failed" == "true" ]] && failed_sides_csv="primary"
  if [[ "$challenger_failed" == "true" ]]; then
    if [[ -n "$failed_sides_csv" ]]; then
      failed_sides_csv="${failed_sides_csv},challenger"
    else
      failed_sides_csv="challenger"
    fi
  fi
  [[ -n "$failed_sides_csv" ]] || return 1

  if [[ "$primary_failed" == "true" && "$challenger_failed" == "true" ]]; then
    if (( primary_retry_count < retry_max )); then
      return 1
    fi
    if (( challenger_retry_count < retry_max )); then
      return 1
    fi
    outcome="double-forfeit"
    winner="primary"
    rationale="Both sides exhausted hard eval retries without persisting an eval record."
  elif [[ "$primary_failed" == "true" ]]; then
    [[ "$challenger_completed" == "true" ]] || return 1
    outcome="forfeit"
    winner="challenger"
    rationale="Primary exhausted hard eval retries without persisting an eval record."
  elif [[ "$challenger_failed" == "true" ]]; then
    [[ "$primary_completed" == "true" ]] || return 1
    outcome="forfeit"
    winner="primary"
    rationale="Challenger exhausted hard eval retries without persisting an eval record."
  else
    return 1
  fi

  terminal_reason=$(challenge_pair_hard_failure_reason "$failed_sides_csv")
  primary_pr=$(read_state_value "" --arg i "$primary_key" '.tasks[$i].pr // empty')
  challenger_pr=$(read_state_value "" --arg i "$challenger_key" '.tasks[$i].pr // empty')
  [[ -n "$primary_pr" && -n "$challenger_pr" ]] || return 1
  primary_model=$(read_state_value "" --arg i "$primary_key" '.tasks[$i].challengeModel // .tasks[$i].coderModel // empty')
  challenger_model=$(read_state_value "" --arg i "$challenger_key" '.tasks[$i].challengeModel // .tasks[$i].coderModel // empty')
  primary_pr_url=$(challenge_pr_url_from_number "$primary_pr")
  challenger_pr_url=$(challenge_pr_url_from_number "$challenger_pr")
  if [[ "$winner" == "primary" ]]; then
    winner_model="$primary_model"
  else
    winner_model="$challenger_model"
  fi
  [[ -n "$winner_model" ]] || winner_model="unknown"
  timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  record_json=$(jq -cn \
    --arg challengePairId "$pair_id" \
    --arg primaryModel "$primary_model" \
    --arg challengerModel "$challenger_model" \
    --arg primaryPrUrl "$primary_pr_url" \
    --arg challengerPrUrl "$challenger_pr_url" \
    --arg winner "$winner" \
    --arg winnerModel "$winner_model" \
    --arg rationale "$rationale" \
    --arg timestamp "$timestamp" \
    --arg comparisonOutcome "$outcome" \
    --arg terminalReason "$terminal_reason" \
    '{
      challengePairId: $challengePairId,
      primaryModel: $primaryModel,
      challengerModel: $challengerModel,
      primaryPrUrl: $primaryPrUrl,
      challengerPrUrl: $challengerPrUrl,
      primaryEvalScore: 0,
      challengerEvalScore: 0,
      winner: $winner,
      winnerModel: $winnerModel,
      rationale: $rationale,
      dimensions: {
        completeness: { primary: 0, challenger: 0 },
        correctness: { primary: 0, challenger: 0 },
        code_quality: { primary: 0, challenger: 0 },
        intervention_impact: { primary: 0, challenger: 0 },
        autonomy: { primary: 0, challenger: 0 }
      },
      timestamp: $timestamp,
      comparisonOutcome: $comparisonOutcome,
      terminalReason: $terminalReason,
      noComparisonReason: $terminalReason
    }')
  if ! challenge_pair_record_exists "$pair_id"; then
    printf '%s\n' "$record_json" >> "$(challenge_pair_records_file)"
  fi
  mark_challenge_compared "$pair_id"
  log_warn "challenge pair $pair_id resolved via $terminal_reason"
}

# The observer's findings are the highest-signal output in the backstage window,
# while the tend loop prints a single repeated status line. Give the observer the
# larger pane.
#
# Idempotent by construction: it swaps only when the observer is currently the
# smaller pane, so repeated startup/reconcile passes converge instead of
# flip-flopping the layout on every run.
wavemill_promote_observer_pane() {
  local observer_pane="${1:-}" tend_pane="${2:-}"
  [[ -n "$observer_pane" && -n "$tend_pane" ]] || return 0
  [[ "$observer_pane" != "$tend_pane" ]] || return 0
  command -v tmux >/dev/null 2>&1 || return 0

  local observer_area tend_area
  observer_area="$(wavemill_pane_area "$observer_pane")" || return 0
  tend_area="$(wavemill_pane_area "$tend_pane")" || return 0

  if (( observer_area < tend_area )); then
    # -d here is the destination via -t; swap-pane's own -d flag is a boolean
    # ("stay on the current pane"), so the target must be passed with -t.
    tmux swap-pane -s "$observer_pane" -t "$tend_pane" >/dev/null 2>&1 || return 0
  fi
  return 0
}

wavemill_list_backstage_panes_by_title() {
  local session_name="${1:?session required}" window_name="${2:?window required}" title="${3:?title required}"
  tmux list-panes -t "$session_name:$window_name" -F '#{pane_id}	#{pane_dead}	#{pane_title}' 2>/dev/null \
    | awk -F '\t' -v title="$title" '$3 == title { print $1 "\t" $2; found = 1 } END { exit found ? 0 : 1 }'
}

wavemill_reconcile_backstage_service_pane() {
  local session_name="${1:?session required}" window_name="${2:?window required}" title="${3:?title required}" command="${4:?command required}" mode="${5:?mode required}" split_target="${6:?split target required}"
  shift 6
  local -a split_args=("$@")
  local panes pane_id pane_dead keeper="" keeper_dead="" first_pane="" first_dead="" action="" killed_count=0
  local -a pane_ids=() pane_dead_values=()

  [[ "$mode" == "reuse" || "$mode" == "restart" ]] || return 2
  tmux list-panes -t "$session_name:$window_name" -F '#{pane_id}' >/dev/null 2>&1 || return 1

  panes="$(wavemill_list_backstage_panes_by_title "$session_name" "$window_name" "$title" 2>/dev/null || true)"
  while IFS=$'\t' read -r pane_id pane_dead; do
    [[ -n "$pane_id" ]] || continue
    pane_ids+=("$pane_id")
    pane_dead_values+=("$pane_dead")
    if [[ -z "$first_pane" ]]; then
      first_pane="$pane_id"
      first_dead="$pane_dead"
    fi
    if [[ -z "$keeper" && "$pane_dead" != "1" ]]; then
      keeper="$pane_id"
      keeper_dead="$pane_dead"
    fi
  done <<< "$panes"

  if [[ -z "$keeper" ]]; then
    keeper="$first_pane"
    keeper_dead="$first_dead"
  fi

  if [[ -n "$keeper" ]]; then
    local i
    for (( i = 0; i < ${#pane_ids[@]}; i++ )); do
      pane_id="${pane_ids[$i]}"
      [[ "$pane_id" != "$keeper" ]] || continue
      tmux kill-pane -t "$pane_id" >/dev/null 2>&1 || true
      killed_count=$((killed_count + 1))
    done

    if [[ "$mode" == "restart" || "$keeper_dead" == "1" ]]; then
      tmux respawn-pane -k -t "$keeper" "$command" >/dev/null 2>&1 || return 1
      action="respawned"
    else
      action="reused"
    fi
    wavemill_set_tmux_pane_title "$keeper" "$title"
    printf '%s\t%s\t%s\n' "$keeper" "$action" "$killed_count"
    return 0
  fi

  keeper="$(tmux split-window -t "$split_target" "${split_args[@]}" -P -F '#{pane_id}' "$command" 2>/dev/null || true)"
  [[ -n "$keeper" ]] || return 1
  wavemill_set_tmux_pane_title "$keeper" "$title"
  printf '%s\tcreated\t0\n' "$keeper"
}

wavemill_init_backstage_health_file() {
  local path="${1:?path required}"
  mkdir -p "$(dirname "$path")"
  [[ -f "$path" ]] || printf '{}\n' > "$path"
}

wavemill_write_backstage_health() {
  local path="${1:?path required}" status="${2:?status required}" detail="${3:-}" attempt_count="${4:-0}" last_attempt_at="${5:-}" executor_pane_id="${6:-}" instance_count="${7:-}"
  wavemill_write_backstage_service_health "$path" "tend" "$status" "$detail" "$attempt_count" "$last_attempt_at" "$executor_pane_id" "" "$instance_count"
}

wavemill_write_backstage_service_health() {
  local path="${1:?path required}" service="${2:?service required}" status="${3:?status required}" detail="${4:-}" attempt_count="${5:-0}" last_attempt_at="${6:-}" pane_id="${7:-}" heartbeat_at="${8:-}" instance_count="${9:-}"
  local instance_count_json="null"
  if [[ "$instance_count" =~ ^[0-9]+$ ]]; then
    instance_count_json="$instance_count"
  fi
  wavemill_init_backstage_health_file "$path"
  state_mutate "$path" '
    .updatedAt = $updatedAt
    | .services = (.services // {})
    | .services[$service] = ((.services[$service] // {}) + {
        updatedAt: $updatedAt,
        status: $status,
        detail: (if $detail == "" then null else $detail end),
        restartAttemptCount: $attemptCount,
        lastRestartAttemptAt: (if $lastAttemptAt == "" then null else $lastAttemptAt end),
        paneId: (if $paneId == "" then null else $paneId end),
        heartbeatAt: (if $heartbeatAt == "" then null else $heartbeatAt end),
        instanceCount: $instanceCount
      })
    | if $service == "tend" then
        .status = $status
        | .detail = (if $detail == "" then null else $detail end)
        | .restartAttemptCount = $attemptCount
        | .lastRestartAttemptAt = (if $lastAttemptAt == "" then null else $lastAttemptAt end)
        | .executorPaneId = (if $paneId == "" then null else $paneId end)
        | .instanceCount = $instanceCount
      else . end
  ' \
    --arg updatedAt "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
    --arg service "$service" \
    --arg status "$status" \
    --arg detail "$detail" \
    --argjson attemptCount "${attempt_count:-0}" \
    --arg lastAttemptAt "$last_attempt_at" \
    --arg paneId "$pane_id" \
    --arg heartbeatAt "$heartbeat_at" \
    --argjson instanceCount "$instance_count_json"
}

wavemill_iso8601_to_epoch() {
  local timestamp="${1-}" normalized_timestamp
  [[ -n "$timestamp" ]] || return 1

  # Node's toISOString() includes milliseconds, while BSD date's strptime
  # format used below does not. Epoch comparisons only need whole seconds.
  normalized_timestamp="$(printf '%s' "$timestamp" | sed -E 's/\.[0-9]+Z$/Z/')"

  if date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$normalized_timestamp" +%s >/dev/null 2>&1; then
    date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$normalized_timestamp" +%s
    return 0
  fi

  if date -u -d "$normalized_timestamp" +%s >/dev/null 2>&1; then
    date -u -d "$normalized_timestamp" +%s
    return 0
  fi

  return 1
}

wavemill_pick_usage_tip() {
  local tip_count="${#WAVEMILL_USAGE_TIPS[@]}"
  local tip_index="${WAVEMILL_TIP_INDEX:-}"

  if (( tip_count == 0 )); then
    printf 'Ctrl+B N: next done\n'
    return 0
  fi

  if [[ "$tip_index" =~ ^[0-9]+$ ]]; then
    printf '%s\n' "${WAVEMILL_USAGE_TIPS[tip_index % tip_count]}"
    return 0
  fi

  printf '%s\n' "${WAVEMILL_USAGE_TIPS[RANDOM % tip_count]}"
}

wavemill_repo_identity_root() {
  local repo_dir="${1:-$PWD}"
  local repo_root

  repo_root="$(git -C "$repo_dir" rev-parse --show-toplevel 2>/dev/null)" || repo_root=""
  if [[ -n "$repo_root" ]]; then
    printf '%s\n' "$repo_root"
    return 0
  fi

  (cd "$repo_dir" 2>/dev/null && pwd -P)
}

wavemill_slugify_session_part() {
  local value="${1-}"
  local slug

  slug="$(printf '%s' "$value" \
    | tr '[:upper:]' '[:lower:]' \
    | sed -E 's/[^a-z0-9-]+/-/g; s/-+/-/g; s/^-+//; s/-+$//')"

  if [[ -z "$slug" ]]; then
    slug="repo"
  fi

  printf '%s\n' "$slug"
}

wavemill_repo_session_hash() {
  local repo_root="${1:?repo root required}"
  local digest=""

  if command -v shasum >/dev/null 2>&1; then
    digest="$(printf '%s' "$repo_root" | shasum -a 256 | awk '{print substr($1, 1, 8)}')"
  elif command -v sha256sum >/dev/null 2>&1; then
    digest="$(printf '%s' "$repo_root" | sha256sum | awk '{print substr($1, 1, 8)}')"
  elif command -v md5 >/dev/null 2>&1; then
    digest="$(printf '%s' "$repo_root" | md5 | awk '{print substr($NF, 1, 8)}')"
  else
    digest="$(printf '%s' "$repo_root" | cksum | awk '{printf "%08d\n", $1 % 100000000}')"
  fi

  printf '%s\n' "$digest"
}

wavemill_default_session_name() {
  local repo_dir="${1:-$PWD}"
  local repo_root repo_basename repo_slug repo_hash

  repo_root="$(wavemill_repo_identity_root "$repo_dir")"
  repo_basename="$(basename "$repo_root")"
  repo_slug="$(wavemill_slugify_session_part "$repo_basename")"
  repo_hash="$(wavemill_repo_session_hash "$repo_root")"

  printf 'wavemill-%s-%s\n' "$repo_slug" "$repo_hash"
}

# ============================================================================
# LAYERED CONFIGURATION LOADING
# ============================================================================

# Format a task-scoped status/info/debug message so the task id appears first
# in the log pane. WARN/ERROR formatting is handled by separate helpers.
wavemill_task_log_message() {
  local task_id="${1:-}"
  shift || true
  local msg="$*"
  msg="${msg#"${msg%%[![:space:]]*}"}"

  if [[ -z "$task_id" ]]; then
    printf '%s\n' "$msg"
    return 0
  fi

  case "$msg" in
    "$task_id"*|"[$task_id]"*) printf '%s\n' "$msg" ;;
    *) printf '[%s]  %s\n' "$task_id" "$msg" ;;
  esac
}

# Hardcoded defaults (ultimate fallbacks)
_WAVEMILL_DEFAULTS='{
  "linear": { "project": "" },
  "git": {
    "fetchTtlSeconds": 60
  },
  "mill": {
    "session": "",
    "maxParallel": 7,
    "pollSeconds": 10,
    "baseBranch": "main",
    "worktreeRoot": "worktrees",
    "agentCmd": "claude",
    "requireConfirm": true,
    "planningMode": "interactive",
    "maxRetries": 3,
    "retryDelay": 2,
    "setupCommand": "",
    "defaultMaxCostUsd": 25.00
  },
  "expand": {
    "maxSelect": 3,
    "maxDisplay": 9
  },
  "plan": {
    "maxDisplay": 9
  },
  "projectContext": {
    "compactionThresholdKb": 100,
    "recentWorkKeep": 25
  },
  "dashboard": {
    "verbosity": "info",
    "logToFile": true
  },
  "observer": {
    "enabled": false,
    "intervalSeconds": 120,
    "heartbeatStaleSeconds": 300,
    "maxLogLines": 240,
    "retention": {
      "maxSnapshots": 50
    }
  },
  "challenge": {
    "enabled": false,
    "rate": 0.10,
    "autoMergeWinner": false
  },
  "mergeQueue": {
    "enabled": true,
    "maxConcurrentCandidates": 2,
    "stuckTimeoutSeconds": 900,
    "conflictGroupingEnabled": true,
    "skipCooldownSeconds": 60
  }
}'

# Load layered config: defaults < ~/.wavemill/config.json < .wavemill-config.json
# < .wavemill-config.local.json < env vars
#
# Resolution order (later wins):
#   1. Hardcoded defaults (_WAVEMILL_DEFAULTS)
#   2. User-level config (~/.wavemill/config.json)
#   3. Per-repo config (.wavemill-config.json)
#   4. Per-developer overlay (.wavemill-config.local.json) — gitignored,
#      mirrors the loadWavemillConfig() overlay on the TypeScript side.
#   5. Environment variables (always win)
#
# Sets: SESSION, MAX_PARALLEL, POLL_SECONDS, BASE_BRANCH, WORKTREE_ROOT,
#        AGENT_CMD, REQUIRE_CONFIRM, PLANNING_MODE, MAX_RETRIES, RETRY_DELAY,
#        PROJECT_NAME, MAX_SELECT, MAX_DISPLAY, SETUP_CMD,
#        GIT_FETCH_TTL_SECONDS
#
# Args: $1 = repo directory (default: $PWD)
load_config() {
  local repo_dir="${1:-$PWD}"
  local user_config="$HOME/.wavemill/config.json"
  local repo_config="$repo_dir/.wavemill-config.json"
  local local_config="$repo_dir/.wavemill-config.local.json"

  # Read config files (empty object if missing)
  local user_json='{}'
  local repo_json='{}'
  local local_json='{}'
  if [[ -f "$user_config" ]]; then
    user_json=$(cat "$user_config") || user_json='{}'
  fi
  if [[ -f "$repo_config" ]]; then
    repo_json=$(cat "$repo_config") || repo_json='{}'
  fi
  if [[ -f "$local_config" ]]; then
    local_json=$(cat "$local_config") || local_json='{}'
  fi

  # Single jq call: deep-merge all layers, emit shell-safe variable assignments
  local shell_vars
  shell_vars=$(jq -n -r \
    --argjson defaults "$_WAVEMILL_DEFAULTS" \
    --argjson user "$user_json" \
    --argjson repo "$repo_json" \
    --argjson local "$local_json" \
    '
    ($defaults * $user * $repo * $local) as $c |
    [
      "_CFG_PROJECT=\($c.linear.project // "" | @sh)",
      "_CFG_GIT_FETCH_TTL_SECONDS=\($c.git.fetchTtlSeconds // 60)",
      "_CFG_SESSION=\($c.mill.session | @sh)",
      "_CFG_MAX_PARALLEL=\($c.mill.maxParallel)",
      "_CFG_POLL_SECONDS=\($c.mill.pollSeconds)",
      "_CFG_BASE_BRANCH=\($c.mill.baseBranch | @sh)",
      "_CFG_WORKTREE_ROOT=\($c.mill.worktreeRoot | @sh)",
      "_CFG_AGENT_CMD=\($c.mill.agentCmd | @sh)",
      "_CFG_REQUIRE_CONFIRM=\($c.mill.requireConfirm)",
      "_CFG_PLANNING_MODE=\($c.mill.planningMode | @sh)",
      "_CFG_MAX_RETRIES=\($c.mill.maxRetries)",
      "_CFG_RETRY_DELAY=\($c.mill.retryDelay)",
      "_CFG_MAX_SELECT=\($c.expand.maxSelect)",
      "_CFG_MAX_DISPLAY=\($c.expand.maxDisplay)",
      "_CFG_PLAN_MAX_DISPLAY=\($c.plan.maxDisplay)",
      "_CFG_PROJECT_CONTEXT_COMPACTION_THRESHOLD_KB=\($c.projectContext.compactionThresholdKb // 100)",
      "_CFG_PROJECT_CONTEXT_RECENT_WORK_KEEP=\($c.projectContext.recentWorkKeep // 25)",
      "_CFG_PLAN_RESEARCH=\($c.plan.research // false)",
      "_CFG_PLAN_MODEL=\($c.plan.model // "claude-opus-4-8" | @sh)",
      "_CFG_DASHBOARD_VERBOSITY=\($c.dashboard.verbosity // "info" | @sh)",
      "_CFG_DASHBOARD_LOG_TO_FILE=\(if ($c.dashboard | has("logToFile")) then $c.dashboard.logToFile else true end)",
      "_CFG_ENTER_LAUNCHES_WAVE=\(if ($c.taskSelection | has("enterLaunchesWave")) then $c.taskSelection.enterLaunchesWave else true end)",
      "_CFG_CHALLENGE_ENABLED=\($c.challenge.enabled // false)",
      "_CFG_CHALLENGE_RATE=\($c.challenge.rate // 0.10)",
      "_CFG_CHALLENGE_AUTO_MERGE=\($c.challenge.autoMergeWinner // false)",
      "_CFG_INTEGRATION_MERGE_METHOD=\($c.integration.mergeMethod // "squash" | @sh)",
      "_CFG_INTEGRATION_DELETE_BRANCH_AFTER_MERGE=\($c.integration.deleteBranchAfterMerge // true)",
      "_CFG_MERGE_QUEUE_ENABLED=\($c.mergeQueue.enabled // true)",
      "_CFG_MERGE_QUEUE_MAX_CONCURRENT=\($c.mergeQueue.maxConcurrentCandidates // 2)",
      "_CFG_MERGE_QUEUE_STUCK_TIMEOUT_SECONDS=\($c.mergeQueue.stuckTimeoutSeconds // 900)",
      "_CFG_MERGE_QUEUE_CONFLICT_GROUPING_ENABLED=\($c.mergeQueue.conflictGroupingEnabled // true)",
      "_CFG_MERGE_QUEUE_SKIP_COOLDOWN_SECONDS=\($c.mergeQueue.skipCooldownSeconds // 60)",
      "_CFG_ROUTER_ENABLED=\($c.router.enabled // true)",
      "_CFG_AUTO_EVAL=\($c.autoEval // true)",
      "_CFG_SETUP_CMD=\($c.mill.setupCommand // "" | @sh)",
      "_CFG_DEFAULT_MAX_COST_USD=\(($c.mill.defaultMaxCostUsd // null) | if . == null then "" else tostring end | @sh)"
    ] | .[]
    '
  ) || {
    echo "Error: Failed to parse config files. Check JSON syntax in:" >&2
    [[ -f "$user_config" ]] && echo "  $user_config" >&2
    [[ -f "$repo_config" ]] && echo "  $repo_config" >&2
    [[ -f "$local_config" ]] && echo "  $local_config" >&2
    exit 1
  }

  eval "$shell_vars"

  # Apply env var overrides (env > repo config > user config > defaults)
  #
  # Project selection is special:
  # - LINEAR_PROJECT is the explicit override
  # - repo config should beat an ambient/exported PROJECT_NAME to avoid
  #   cross-repo leakage from prior shells or sessions
  # - legacy PROJECT_NAME is only used when no repo/user project is configured
  if [[ -n "${LINEAR_PROJECT:-}" ]]; then
    PROJECT_NAME="$LINEAR_PROJECT"
  elif [[ -n "$_CFG_PROJECT" ]]; then
    PROJECT_NAME="$_CFG_PROJECT"
  else
    PROJECT_NAME="${PROJECT_NAME:-}"
  fi

  # Session name: env var > config > repo-scoped default
  local _default_session
  _default_session="$(wavemill_default_session_name "$repo_dir")"
  if [[ -n "${SESSION:-}" ]]; then
    : # Explicit env var — keep it
  elif [[ -n "$_CFG_SESSION" ]]; then
    SESSION="$_CFG_SESSION"
  else
    SESSION="$_default_session"
  fi
  MAX_PARALLEL="${MAX_PARALLEL:-$_CFG_MAX_PARALLEL}"
  POLL_SECONDS="${POLL_SECONDS:-$_CFG_POLL_SECONDS}"
  GIT_FETCH_TTL_SECONDS="${GIT_FETCH_TTL_SECONDS:-$_CFG_GIT_FETCH_TTL_SECONDS}"
  BASE_BRANCH="${BASE_BRANCH:-$_CFG_BASE_BRANCH}"
  AGENT_CMD="${AGENT_CMD:-$_CFG_AGENT_CMD}"
  REQUIRE_CONFIRM="${REQUIRE_CONFIRM:-$_CFG_REQUIRE_CONFIRM}"
  PLANNING_MODE="${PLANNING_MODE:-$_CFG_PLANNING_MODE}"
  MAX_RETRIES="${MAX_RETRIES:-$_CFG_MAX_RETRIES}"
  RETRY_DELAY="${RETRY_DELAY:-$_CFG_RETRY_DELAY}"
  MAX_SELECT="${MAX_SELECT:-$_CFG_MAX_SELECT}"
  MAX_DISPLAY="${MAX_DISPLAY:-$_CFG_MAX_DISPLAY}"
  PLAN_MAX_DISPLAY="${PLAN_MAX_DISPLAY:-$_CFG_PLAN_MAX_DISPLAY}"
  PROJECT_CONTEXT_COMPACTION_THRESHOLD_KB="${PROJECT_CONTEXT_COMPACTION_THRESHOLD_KB:-$_CFG_PROJECT_CONTEXT_COMPACTION_THRESHOLD_KB}"
  PROJECT_CONTEXT_RECENT_WORK_KEEP="${PROJECT_CONTEXT_RECENT_WORK_KEEP:-$_CFG_PROJECT_CONTEXT_RECENT_WORK_KEEP}"
  PLAN_RESEARCH="${PLAN_RESEARCH:-$_CFG_PLAN_RESEARCH}"
  PLAN_MODEL="${PLAN_MODEL:-$_CFG_PLAN_MODEL}"
  DASHBOARD_VERBOSITY="${DASHBOARD_VERBOSITY:-$_CFG_DASHBOARD_VERBOSITY}"
  DASHBOARD_LOG_TO_FILE="${DASHBOARD_LOG_TO_FILE:-$_CFG_DASHBOARD_LOG_TO_FILE}"
  ENTER_LAUNCHES_WAVE="${ENTER_LAUNCHES_WAVE:-$_CFG_ENTER_LAUNCHES_WAVE}"
  CHALLENGE_ENABLED="${CHALLENGE_ENABLED:-$_CFG_CHALLENGE_ENABLED}"
  CHALLENGE_RATE="${CHALLENGE_RATE:-$_CFG_CHALLENGE_RATE}"
  CHALLENGE_MODELS_JSON="${CHALLENGE_MODELS_JSON:-null}"
  CHALLENGE_COMPARISON_MODEL="${CHALLENGE_COMPARISON_MODEL:-claude-opus-4-8}"
  CHALLENGE_AUTO_MERGE="${CHALLENGE_AUTO_MERGE:-$_CFG_CHALLENGE_AUTO_MERGE}"
  INTEGRATION_MERGE_METHOD="${INTEGRATION_MERGE_METHOD:-$_CFG_INTEGRATION_MERGE_METHOD}"
  INTEGRATION_DELETE_BRANCH_AFTER_MERGE="${INTEGRATION_DELETE_BRANCH_AFTER_MERGE:-$_CFG_INTEGRATION_DELETE_BRANCH_AFTER_MERGE}"
  MERGE_QUEUE_ENABLED="${MERGE_QUEUE_ENABLED:-$_CFG_MERGE_QUEUE_ENABLED}"
  MERGE_QUEUE_MAX_CONCURRENT="${MERGE_QUEUE_MAX_CONCURRENT:-$_CFG_MERGE_QUEUE_MAX_CONCURRENT}"
  MERGE_QUEUE_STUCK_TIMEOUT_SECONDS="${MERGE_QUEUE_STUCK_TIMEOUT_SECONDS:-$_CFG_MERGE_QUEUE_STUCK_TIMEOUT_SECONDS}"
  MERGE_QUEUE_CONFLICT_GROUPING_ENABLED="${MERGE_QUEUE_CONFLICT_GROUPING_ENABLED:-$_CFG_MERGE_QUEUE_CONFLICT_GROUPING_ENABLED}"
  MERGE_QUEUE_SKIP_COOLDOWN_SECONDS="${MERGE_QUEUE_SKIP_COOLDOWN_SECONDS:-$_CFG_MERGE_QUEUE_SKIP_COOLDOWN_SECONDS}"
  ROUTER_ENABLED="${ROUTER_ENABLED:-$_CFG_ROUTER_ENABLED}"
  ROUTER_DEFAULT_MODEL="${ROUTER_DEFAULT_MODEL:-}"
  AUTO_EVAL="${AUTO_EVAL:-$_CFG_AUTO_EVAL}"
  SETUP_CMD="${SETUP_CMD:-$_CFG_SETUP_CMD}"
  DEFAULT_MAX_COST_USD="${DEFAULT_MAX_COST_USD:-$_CFG_DEFAULT_MAX_COST_USD}"

  if [[ "$PLANNING_MODE" != "interactive" ]]; then
    echo "Warning: planningMode='$PLANNING_MODE' is no longer supported; forcing interactive planning." >&2
    PLANNING_MODE="interactive"
  fi

  # WORKTREE_ROOT: resolve relative paths against repo_dir
  local wt_raw="${WORKTREE_ROOT:-$_CFG_WORKTREE_ROOT}"
  if [[ "$wt_raw" != /* ]]; then
    WORKTREE_ROOT="$repo_dir/$wt_raw"
  else
    WORKTREE_ROOT="$wt_raw"
  fi

  # Export for child processes (orchestrator, monitor, agents)
  export SESSION MAX_PARALLEL POLL_SECONDS BASE_BRANCH WORKTREE_ROOT
  export GIT_FETCH_TTL_SECONDS
  export AGENT_CMD REQUIRE_CONFIRM PLANNING_MODE MAX_RETRIES RETRY_DELAY
  export PROJECT_NAME MAX_SELECT MAX_DISPLAY PLAN_MAX_DISPLAY PLAN_RESEARCH PLAN_MODEL
  export PROJECT_CONTEXT_COMPACTION_THRESHOLD_KB PROJECT_CONTEXT_RECENT_WORK_KEEP
  export DASHBOARD_VERBOSITY DASHBOARD_LOG_TO_FILE
  export ENTER_LAUNCHES_WAVE
  export CHALLENGE_ENABLED CHALLENGE_RATE CHALLENGE_MODELS_JSON
  export CHALLENGE_COMPARISON_MODEL CHALLENGE_AUTO_MERGE
  export INTEGRATION_MERGE_METHOD INTEGRATION_DELETE_BRANCH_AFTER_MERGE
  export MERGE_QUEUE_ENABLED MERGE_QUEUE_MAX_CONCURRENT
  export MERGE_QUEUE_STUCK_TIMEOUT_SECONDS MERGE_QUEUE_CONFLICT_GROUPING_ENABLED
  export MERGE_QUEUE_SKIP_COOLDOWN_SECONDS
  export ROUTER_ENABLED ROUTER_DEFAULT_MODEL AUTO_EVAL SETUP_CMD DEFAULT_MAX_COST_USD

  # Clean up temp variables
  unset _CFG_PROJECT _CFG_GIT_FETCH_TTL_SECONDS _CFG_SESSION _CFG_MAX_PARALLEL _CFG_POLL_SECONDS
  unset _CFG_BASE_BRANCH _CFG_WORKTREE_ROOT _CFG_AGENT_CMD _CFG_REQUIRE_CONFIRM
  unset _CFG_PLANNING_MODE _CFG_MAX_RETRIES _CFG_RETRY_DELAY _CFG_MAX_SELECT _CFG_MAX_DISPLAY
  unset _CFG_PLAN_MAX_DISPLAY _CFG_PLAN_RESEARCH _CFG_PLAN_MODEL
  unset _CFG_PROJECT_CONTEXT_COMPACTION_THRESHOLD_KB _CFG_PROJECT_CONTEXT_RECENT_WORK_KEEP
  unset _CFG_DASHBOARD_VERBOSITY _CFG_DASHBOARD_LOG_TO_FILE _CFG_ENTER_LAUNCHES_WAVE
  unset _CFG_CHALLENGE_ENABLED _CFG_CHALLENGE_RATE _CFG_CHALLENGE_AUTO_MERGE
  unset _CFG_INTEGRATION_MERGE_METHOD _CFG_INTEGRATION_DELETE_BRANCH_AFTER_MERGE
  unset _CFG_MERGE_QUEUE_ENABLED _CFG_MERGE_QUEUE_MAX_CONCURRENT
  unset _CFG_MERGE_QUEUE_STUCK_TIMEOUT_SECONDS _CFG_MERGE_QUEUE_CONFLICT_GROUPING_ENABLED
  unset _CFG_MERGE_QUEUE_SKIP_COOLDOWN_SECONDS
  unset _CFG_ROUTER_ENABLED _CFG_AUTO_EVAL _CFG_SETUP_CMD _CFG_DEFAULT_MAX_COST_USD

  # Sentinel so downstream scripts can skip re-loading
  _WAVEMILL_CONFIG_LOADED=1
}

wavemill_config_annotation() {
  local path="${1:-}"
  local value="${2:-}"

  printf ' (%s=%s)' "$path" "$value"
}

BACKLOG_BUDGET_WARNED=false

wavemill_backlog_compute_budget() {
  local session="${1:-}"
  local window_pane="${2:-}"
  local config_file="${3:-}"
  local budget=""

  if [[ -n "$config_file" && -f "$config_file" ]]; then
    budget="$(jq -r '.backlog.maxLines // empty' "$config_file" 2>/dev/null || true)"
  elif [[ -n "${REPO_DIR:-}" ]]; then
    budget="$(wavemill_load_config "$REPO_DIR" | jq -r '.backlog.maxLines // empty' 2>/dev/null || true)"
  fi

  if [[ "$budget" =~ ^[0-9]+$ ]] && (( budget >= 10 && budget <= 200 )); then
    printf '%s\n' "$budget"
    return 0
  fi

  local pane_height=""
  if [[ -n "$session" && -n "$window_pane" ]]; then
    pane_height="$(tmux display-message -t "$session:$window_pane" -p "#{pane_height}" 2>/dev/null || true)"
  fi

  if [[ "$pane_height" =~ ^[0-9]+$ ]]; then
    # The grouped renderer receives only the task-list body budget. The mill
    # pane frame adds "Next tasks:", a blank separator, and a long prompt that
    # commonly wraps, so reserve enough rows for that fixed chrome.
    budget=$((pane_height - 8))
    (( budget < 10 )) && budget=10
    printf '%s\n' "$budget"
    return 0
  fi

  if [[ "${BACKLOG_BUDGET_WARNED:-false}" != "true" ]]; then
    log_warn "Backlog pane height unavailable; using fallback budget 20"
    BACKLOG_BUDGET_WARNED=true
  fi
  printf '20\n'
  return 0
}

ready_debug_log_file() {
  local session="${SESSION:-${WAVEMILL_SESSION:-wavemill}}"
  local sanitized="${session//[^[:alnum:]._-]/-}"

  if [[ -z "$sanitized" ]]; then
    sanitized="wavemill"
  fi

  if (( ${#sanitized} > 40 )); then
    local session_hash
    session_hash="$(printf '%s' "$sanitized" | cksum | awk '{print $1}')"
    sanitized="${sanitized:0:28}-${session_hash}"
  fi

  printf '/tmp/wavemill-%s-ready-debug.jsonl\n' "$sanitized"
}

summarize_ready_result() {
  local payload="${1-}"
  local summary max_len=72 total_count failed_count other_count
  local failed_json item name detail
  local failed_parts=()

  if [[ -z "$payload" ]] || ! command -v jq >/dev/null 2>&1; then
    printf '%s\n' "(summary unavailable)"
    return 0
  fi

  total_count="$(printf '%s' "$payload" | jq -r '.checks | if type == "array" then length else 0 end' 2>/dev/null || printf '0')"
  failed_json="$(printf '%s' "$payload" | jq -c '[.checks[]? | select(.status == "fail")]' 2>/dev/null || printf '[]')"
  failed_count="$(printf '%s' "$failed_json" | jq -r 'length' 2>/dev/null || printf '0')"

  if [[ ! "$total_count" =~ ^[0-9]+$ ]] || [[ ! "$failed_count" =~ ^[0-9]+$ ]]; then
    printf '%s\n' "(summary unavailable)"
    return 0
  fi

  other_count=$(( total_count - failed_count ))
  while IFS= read -r item; do
    [[ -n "$item" ]] || continue
    name="$(printf '%s' "$item" | jq -r '.name // "unknown-check"' 2>/dev/null || printf 'unknown-check')"
    detail="$(printf '%s' "$item" | jq -r '
      (.details // null) as $details
      | if ($details | type) == "object" and (($details.failedChecks? | type) == "array") then
          ($details.failedChecks | length) as $count | ($count | tostring) + " check" + (if $count == 1 then "" else "s" end)
        elif ($details | type) == "array" then
          ($details | length) as $count | ($count | tostring) + " file" + (if $count == 1 then "" else "s" end)
        elif ($details | type) == "object" and (($details.files? | type) == "array") then
          ($details.files | length) as $count | ($count | tostring) + " file" + (if $count == 1 then "" else "s" end)
        elif ($details | type) == "object" and (($details.paths? | type) == "array") then
          ($details.paths | length) as $count | ($count | tostring) + " file" + (if $count == 1 then "" else "s" end)
        elif ($details | type) == "object" and ($details | length) > 0 then
          ($details | length) as $count | ($count | tostring) + " detail" + (if $count == 1 then "" else "s" end)
        else
          ""
        end
    ' 2>/dev/null || printf '')"
    if [[ -n "$detail" ]]; then
      failed_parts+=("$name: $detail")
    else
      failed_parts+=("$name")
    fi
  done < <(printf '%s' "$failed_json" | jq -c '.[]' 2>/dev/null)

  if (( failed_count == 0 )); then
    summary="0 failed, $other_count passed/skipped"
  else
    local failed_preview preview_limit
    preview_limit=$failed_count
    if (( preview_limit > 2 )); then
      preview_limit=2
    fi
    failed_preview="$(printf '%s, ' "${failed_parts[@]:0:preview_limit}")"
    failed_preview="${failed_preview%, }"
    summary="$failed_count failed ($failed_preview"
    if (( failed_count > 2 )); then
      summary+=", +$(( failed_count - 2 )) more"
    fi
    summary+="), $other_count passed/skipped"
  fi

  if [[ -z "$summary" ]]; then
    summary="(summary unavailable)"
  elif (( ${#summary} > max_len )); then
    summary="${summary:0:$(( max_len - 3 ))}..."
  fi

  printf '%s\n' "$summary"
}

log_debug_json() {
  local category="${1:-debug}"
  local payload="${2-}"
  local target ts record

  [[ -n "$payload" ]] || return 0
  command -v jq >/dev/null 2>&1 || return 0

  target="$(ready_debug_log_file)"
  ts="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  mkdir -p "$(dirname "$target")" 2>/dev/null || true

  if record="$(
    printf '%s' "$payload" | jq -c --arg ts "$ts" --arg category "$category" \
      '{ts: $ts, category: $category, payload: .}' 2>/dev/null
  )"; then
    printf '%s\n' "$record" >> "$target" 2>/dev/null || true
    return 0
  fi

  if record="$(
    jq -cn --arg ts "$ts" --arg category "$category" --arg raw "$payload" \
      '{ts: $ts, category: $category, raw: $raw, error: "non_json"}' 2>/dev/null
  )"; then
    printf '%s\n' "$record" >> "$target" 2>/dev/null || true
  fi

  return 0
}

wavemill_fetch_base_branch() {
  local base_branch="${1:-}"
  shift || true

  local force_fetch="false"
  while (( $# > 0 )); do
    case "$1" in
      --force)
        force_fetch="true"
        ;;
      *)
        return 1
        ;;
    esac
    shift
  done

  [[ -n "$base_branch" ]] || return 1

  local ttl="${GIT_FETCH_TTL_SECONDS:-60}"
  if [[ ! "$ttl" =~ ^[0-9]+$ ]]; then
    ttl=60
  fi

  local now last_fetch_at
  now="$(date +%s)"

  if [[ "$force_fetch" != "true" ]] && (( ttl > 0 )) && [[ -r "${STATE_FILE:-}" ]] && [[ -s "${STATE_FILE:-}" ]]; then
    if last_fetch_at=$(jq -r --arg branch "$base_branch" '.baseBranchFetchCache[$branch].last_fetch_at // empty' "$STATE_FILE" 2>/dev/null); then
      if [[ "$last_fetch_at" =~ ^[0-9]+$ ]] && (( now - last_fetch_at < ttl )); then
        return 0
      fi
    fi
  fi

  local remote_timeout fetch_rc=0
  remote_timeout="$(wavemill_git_remote_timeout_seconds)"
  wavemill_git_remote_with_timeout "$remote_timeout" -C "$REPO_DIR" fetch origin "$base_branch" || fetch_rc=$?
  if (( fetch_rc != 0 )); then
    wavemill_warn "git fetch origin $base_branch failed for repo=$REPO_DIR timeout=${remote_timeout}s exit=$fetch_rc; continuing without refreshing base-branch cache"
    return "$fetch_rc"
  fi

  if [[ -n "${STATE_FILE:-}" ]]; then
    local state_dir tmp
    state_dir="$(dirname "$STATE_FILE")"
    mkdir -p "$state_dir" 2>/dev/null || true
    tmp="$(mktemp "${state_dir%/}/fetch-cache.XXXXXX")" || return 0

    if [[ ! -s "$STATE_FILE" ]]; then
      printf '{"tasks":{}}\n' > "$STATE_FILE" 2>/dev/null || true
    fi

    if jq --arg branch "$base_branch" --argjson fetchedAt "$now" \
      '.baseBranchFetchCache = (.baseBranchFetchCache // {})
       | .baseBranchFetchCache[$branch] = ((.baseBranchFetchCache[$branch] // {}) + {last_fetch_at: $fetchedAt})' \
      "$STATE_FILE" > "$tmp" 2>/dev/null; then
      mv "$tmp" "$STATE_FILE"
    else
      rm -f "$tmp"
    fi
  fi
}

wavemill_base_ref_checked_refs() {
  local base_branch="${1:-}"
  [[ -n "$base_branch" ]] || return 1

  printf 'refs/heads/%s\n' "$base_branch"
  printf 'refs/remotes/origin/%s\n' "$base_branch"

  local upstream
  upstream="$(git -C "${REPO_DIR:-$PWD}" rev-parse --abbrev-ref --symbolic-full-name "refs/heads/$base_branch@{upstream}" 2>/dev/null || true)"
  if [[ -n "$upstream" && "$upstream" != "origin/$base_branch" ]]; then
    printf 'refs/remotes/%s\n' "$upstream"
  fi
}

wavemill_resolve_base_ref() {
  local base_branch="${1:-}"
  [[ -n "$base_branch" ]] || return 1

  local ref
  while IFS= read -r ref; do
    [[ -n "$ref" ]] || continue
    if git -C "${REPO_DIR:-$PWD}" show-ref --verify --quiet "$ref"; then
      printf '%s\n' "$ref"
      return 0
    fi
  done < <(wavemill_base_ref_checked_refs "$base_branch")

  return 1
}

wavemill_default_remote_branch() {
  local repo_dir="${REPO_DIR:-$PWD}"
  local target

  target="$(git -C "$repo_dir" symbolic-ref -q --short refs/remotes/origin/HEAD 2>/dev/null || true)"
  if [[ -n "$target" ]]; then
    printf '%s\n' "$target"
    return 0
  fi

  if git -C "$repo_dir" show-ref --verify --quiet refs/remotes/origin/main; then
    printf '%s\n' "origin/main"
    return 0
  fi

  return 1
}

wavemill_base_ref_preflight() {
  local base_branch="${1:-}"
  shift || true

  local force_fetch="false"
  local json_out=""
  while (( $# > 0 )); do
    case "$1" in
      --force-fetch)
        force_fetch="true"
        ;;
      --json-out)
        json_out="${2:-}"
        shift
        ;;
      *)
        return 1
        ;;
    esac
    shift
  done

  [[ -n "$base_branch" ]] || return 1
  command -v jq >/dev/null 2>&1 || return 1

  local fetch_rc=0 fetch_attempted=true fetch_degraded=false resolved_ref="" reason="ok" status="ok" default_branch=""
  if [[ "${WAVEMILL_DRY_RUN:-}" == "1" || "${DRY_RUN:-}" == "true" ]]; then
    fetch_attempted=false
  elif [[ "$force_fetch" == "true" ]]; then
    wavemill_fetch_base_branch "$base_branch" --force || fetch_rc=$?
  else
    wavemill_fetch_base_branch "$base_branch" || fetch_rc=$?
  fi

  if resolved_ref="$(wavemill_resolve_base_ref "$base_branch" 2>/dev/null)"; then
    status="ok"
    reason="ok"
    if [[ "$fetch_attempted" == "true" && "$fetch_rc" -ne 0 ]]; then
      fetch_degraded=true
    fi
  else
    status="failed"
    if [[ "$fetch_attempted" == "true" && "$fetch_rc" -ne 0 ]]; then
      reason="base_ref_fetch_failed"
    else
      reason="base_ref_unavailable"
    fi
  fi

  default_branch="$(wavemill_default_remote_branch 2>/dev/null || true)"

  local checked_refs_json
  checked_refs_json="$(wavemill_base_ref_checked_refs "$base_branch" | jq -R . | jq -sc .)"

  local payload
  payload="$(jq -cn \
    --arg status "$status" \
    --arg reason "$reason" \
    --arg configuredBranch "$base_branch" \
    --arg resolvedRef "$resolved_ref" \
    --arg defaultBranch "$default_branch" \
    --argjson fetchExit "$fetch_rc" \
    --argjson fetchAttempted "$fetch_attempted" \
    --argjson fetchDegraded "$fetch_degraded" \
    --argjson checkedRefs "$checked_refs_json" \
    '{
      status: $status,
      reason: $reason,
      configuredBranch: $configuredBranch,
      checkedRefs: $checkedRefs,
      fetchAttempted: $fetchAttempted,
      fetchExit: $fetchExit,
      fetchDegraded: $fetchDegraded
    }
    + (if $resolvedRef == "" then {} else {resolvedRef: $resolvedRef} end)
    + (if $defaultBranch == "" then {} else {defaultBranch: $defaultBranch} end)')"

  if [[ -n "$json_out" ]]; then
    mkdir -p "$(dirname "$json_out")" 2>/dev/null || true
    printf '%s\n' "$payload" > "$json_out"
  else
    printf '%s\n' "$payload"
  fi

  [[ "$status" == "ok" ]]
}

wavemill_format_base_ref_preflight_failure() {
  local preflight_json="${1:-}"
  [[ -n "$preflight_json" ]] || return 1
  command -v jq >/dev/null 2>&1 || return 1

  local branch checked default_branch reason
  branch="$(printf '%s' "$preflight_json" | jq -r '.configuredBranch // "unknown"')"
  checked="$(printf '%s' "$preflight_json" | jq -r '.checkedRefs | join(" and ")')"
  default_branch="$(printf '%s' "$preflight_json" | jq -r '.defaultBranch // empty')"
  reason="$(printf '%s' "$preflight_json" | jq -r '.reason // "base_ref_unavailable"')"

  if [[ "$reason" == "base_ref_fetch_failed" ]]; then
    printf 'Wavemill cannot start: configured base branch "%s" could not be fetched or resolved.\n' "$branch"
  else
    printf 'Wavemill cannot start: configured base branch "%s" is unavailable.\n' "$branch"
  fi
  printf 'Checked: %s.\n' "$checked"
  if [[ -n "$default_branch" ]]; then
    printf 'Available default branch: %s.\n' "$default_branch"
  fi
  printf 'Update .wavemill-config.json (mill.baseBranch / integration.integrationBranch), create the branch, or rerun with BASE_BRANCH=main.\n'
  printf 'No worktrees or agents were started.\n'
}

wavemill_record_startup_terminal_reason() {
  local reason="${1:-startup_failed}" preflight_json="${2:-{}}" cleanup_status="${3:-not_attempted}"
  command -v jq >/dev/null 2>&1 || return 0

  local log_dir="${MILL_LOG_DIR:-}"
  if [[ -z "$log_dir" && -n "${REPO_DIR:-}" ]]; then
    log_dir="$REPO_DIR/.wavemill/logs"
  fi
  [[ -n "$log_dir" ]] || return 0
  mkdir -p "$log_dir" 2>/dev/null || true

  local record
  record="$(printf '%s' "$preflight_json" | jq -c \
    --arg event "startup_terminal" \
    --arg reason "$reason" \
    --arg session "${SESSION:-}" \
    --arg repoDir "${REPO_DIR:-}" \
    --arg cleanupStatus "$cleanup_status" \
    '. as $p | {
      event: $event,
      reason: $reason,
      configuredBranch: ($p.configuredBranch // null),
      checkedRefs: ($p.checkedRefs // []),
      resolvedRef: ($p.resolvedRef // null),
      fetchDegraded: ($p.fetchDegraded // false),
      session: $session,
      repoDir: $repoDir,
      cleanupStatus: $cleanupStatus
    }' 2>/dev/null)" || return 0

  printf '%s\n' "$record" >> "$log_dir/startup-terminal.jsonl" 2>/dev/null || true
}

wavemill_cleanup_launch_attempt() {
  local cleanup_status="ok"
  local session="${SESSION:-}"
  local repo_dir="${REPO_DIR:-}"
  local launch_plan_file="${LAUNCH_PLAN_FILE:-${PLAN_FILE:-}}"
  local status_log_file="${STATUS_LOG_FILE:-}"
  local launched_issues_file="${LAUNCHED_ISSUES_FILE:-}"
  local monitor_script="${MONITOR_SCRIPT:-}"
  local monitor_env="${MONITOR_ENV:-}"

  if [[ -n "$session" ]] && command -v tmux >/dev/null 2>&1 && tmux has-session -t "$session" 2>/dev/null; then
    local existing_dir
    existing_dir="$(tmux show-environment -t "$session" REPO_DIR 2>/dev/null | sed 's/^REPO_DIR=//' || true)"
    if [[ -n "$repo_dir" && "$existing_dir" == "$repo_dir" ]]; then
      tmux kill-session -t "$session" 2>/dev/null || cleanup_status="partial"
    fi
  fi

  if [[ -n "$launch_plan_file" && -f "$launch_plan_file" && -n "${STATE_FILE:-}" && -f "${STATE_FILE:-}" ]]; then
    local tmp
    tmp="$(mktemp "${STATE_FILE%/*}/cleanup.XXXXXX" 2>/dev/null || true)"
    if [[ -n "$tmp" ]]; then
      if jq --slurpfile plan "$launch_plan_file" '
        ($plan[0].tasks // [] | map(.issue)) as $issues
        | .tasks = ((.tasks // {}) | with_entries(select((.key as $k | $issues | index($k)) | not)))
      ' "$STATE_FILE" > "$tmp" 2>/dev/null; then
        mv "$tmp" "$STATE_FILE" 2>/dev/null || cleanup_status="partial"
      else
        rm -f "$tmp"
        cleanup_status="partial"
      fi
    fi
  fi

  if [[ -n "$launch_plan_file" && -f "$launch_plan_file" ]]; then
    while IFS= read -r path; do
      [[ -n "$path" ]] || continue
      case "$path" in
        /tmp/"$session"-*)
          rm -f "$path" 2>/dev/null || cleanup_status="partial"
          ;;
      esac
    done < <(jq -r '.tasks[]? | .taskPacketFile, .taskPacketDetailsFile, .issueJsonFile, .routeFile | select(type == "string" and length > 0)' "$launch_plan_file" 2>/dev/null || true)
  fi

  local path
  for path in "$launch_plan_file" "$status_log_file" "$launched_issues_file" "$monitor_script" "$monitor_env"; do
    [[ -n "$path" ]] || continue
    case "$path" in
      /tmp/"$session"-*|/tmp/"$session".*)
        rm -f "$path" 2>/dev/null || cleanup_status="partial"
        ;;
    esac
  done

  if declare -F startup_log >/dev/null 2>&1; then
    startup_log "Cleanup after failed startup: $cleanup_status"
  elif declare -F log_warn >/dev/null 2>&1; then
    log_warn "Cleanup after failed startup: $cleanup_status"
  fi

  printf '%s\n' "$cleanup_status"
}

wavemill_warn() {
  local message="$*"
  if declare -F log_warn >/dev/null 2>&1; then
    log_warn "$message"
  else
    printf 'WARN: %s\n' "$message" >&2
  fi
}

wavemill_git_remote_timeout_seconds() {
  local raw="${WAVEMILL_GIT_REMOTE_TIMEOUT_SECONDS:-}"

  if [[ -z "$raw" ]]; then
    printf '%s\n' "$WAVEMILL_GIT_REMOTE_TIMEOUT_DEFAULT"
    return 0
  fi

  if [[ "$raw" =~ ^[0-9]+$ ]] \
    && (( raw >= WAVEMILL_GIT_REMOTE_TIMEOUT_MIN )) \
    && (( raw <= WAVEMILL_GIT_REMOTE_TIMEOUT_MAX )); then
    printf '%s\n' "$raw"
    return 0
  fi

  if [[ "${__WAVEMILL_GIT_REMOTE_TIMEOUT_INVALID_WARNED:-false}" != "true" ]]; then
    wavemill_warn "Invalid WAVEMILL_GIT_REMOTE_TIMEOUT_SECONDS=$raw; using default ${WAVEMILL_GIT_REMOTE_TIMEOUT_DEFAULT}s"
    __WAVEMILL_GIT_REMOTE_TIMEOUT_INVALID_WARNED="true"
  fi

  printf '%s\n' "$WAVEMILL_GIT_REMOTE_TIMEOUT_DEFAULT"
}

_wavemill_kill_process_tree() {
  local pid="${1:-}"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 0

  if command -v pgrep >/dev/null 2>&1; then
    local child_pid
    while IFS= read -r child_pid; do
      [[ "$child_pid" =~ ^[0-9]+$ ]] || continue
      _wavemill_kill_process_tree "$child_pid"
    done < <(pgrep -P "$pid" 2>/dev/null || true)
  fi

  kill -TERM "$pid" 2>/dev/null || true
  sleep 1
  kill -KILL "$pid" 2>/dev/null || true
}

wavemill_collect_descendant_pids() {
  local root_pid="${1:-}" pid children child
  [[ "$root_pid" =~ ^[0-9]+$ ]] || return 0
  command -v pgrep >/dev/null 2>&1 || return 1

  local -a queue=("$root_pid")
  local idx=0
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

wavemill_process_command_line() {
  local pid="${1:-}" command_line=""
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1

  command_line="$(ps -p "$pid" -o command= 2>/dev/null || ps -o command= -p "$pid" 2>/dev/null || true)"
  command_line="$(printf '%s' "$command_line" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')"
  [[ -n "$command_line" ]] || return 1
  printf '%s\n' "$command_line"
}

wavemill_pid_is_descendant() {
  local root_pid="${1:-}" candidate_pid="${2:-}" pid
  [[ "$root_pid" =~ ^[0-9]+$ && "$candidate_pid" =~ ^[0-9]+$ ]] || return 1

  while IFS= read -r pid; do
    [[ "$pid" == "$candidate_pid" ]] && return 0
  done < <(wavemill_collect_descendant_pids "$root_pid" 2>/dev/null || true)

  return 1
}

mill_pane_has_live_blocking_process() {
  local pane_pid="${1:-}"
  shift || true

  # shellcheck disable=SC2034
  MILL_BLOCKING_PROCESS_COMMAND=""
  MILL_BLOCKING_PROCESS_REASON=""
  MILL_BLOCKING_PROCESS_MATCH_COUNT=0
  MILL_BLOCKING_PROCESS_PIDS=()

  if ! command -v pgrep >/dev/null 2>&1; then
    MILL_BLOCKING_PROCESS_REASON="pgrep missing"
    return 2
  fi

  if [[ -z "$pane_pid" || ! "$pane_pid" =~ ^[0-9]+$ ]]; then
    MILL_BLOCKING_PROCESS_REASON="pane pid unavailable"
    return 2
  fi

  if ! kill -0 "$pane_pid" 2>/dev/null; then
    return 1
  fi

  local -a blocking_commands=()
  local raw_command sanitized_command
  for raw_command in "$@"; do
    sanitized_command="$(sanitize_blocked_completion_text "$raw_command")"
    [[ -n "$sanitized_command" ]] || continue
    blocking_commands+=("$sanitized_command")
  done

  local -a descendant_pids=()
  local pid command_line matched=false blocking_command
  mapfile -t descendant_pids < <(wavemill_collect_descendant_pids "$pane_pid" 2>/dev/null || true)
  (( ${#descendant_pids[@]} > 0 )) || return 1

  if (( ${#blocking_commands[@]} == 0 )); then
    for pid in "${descendant_pids[@]}"; do
      kill -0 "$pid" 2>/dev/null || continue
      MILL_BLOCKING_PROCESS_PIDS=("$pid")
      MILL_BLOCKING_PROCESS_MATCH_COUNT=1
      command_line="$(wavemill_process_command_line "$pid" 2>/dev/null || true)"
      MILL_BLOCKING_PROCESS_COMMAND="${command_line:-pid $pid}"
      return 0
    done
    return 1
  fi

  if ! command -v ps >/dev/null 2>&1; then
    MILL_BLOCKING_PROCESS_REASON="ps missing"
    return 2
  fi

  local -a matched_pids=()
  for pid in "${descendant_pids[@]}"; do
    kill -0 "$pid" 2>/dev/null || continue
    command_line="$(wavemill_process_command_line "$pid" 2>/dev/null || true)"
    if [[ -z "$command_line" ]]; then
      if kill -0 "$pid" 2>/dev/null; then
        MILL_BLOCKING_PROCESS_REASON="could not read command line for pid $pid"
        return 2
      fi
      continue
    fi

    for blocking_command in "${blocking_commands[@]}"; do
      if [[ "$command_line" == *"$blocking_command"* ]]; then
        matched=true
        matched_pids+=("$pid")
        if [[ -z "$MILL_BLOCKING_PROCESS_COMMAND" ]]; then
          MILL_BLOCKING_PROCESS_COMMAND="$command_line"
        fi
        break
      fi
    done
  done

  if [[ "$matched" == true ]]; then
    # shellcheck disable=SC2034
    MILL_BLOCKING_PROCESS_PIDS=("${matched_pids[@]}")
    MILL_BLOCKING_PROCESS_MATCH_COUNT="${#matched_pids[@]}"
    return 0
  fi

  return 1
}

mill_terminate_blocking_processes() {
  local pane_pid="${1:-}"
  shift || true

  [[ "$pane_pid" =~ ^[0-9]+$ ]] || return 1

  local pid terminated_any=false
  for pid in "$@"; do
    [[ "$pid" =~ ^[0-9]+$ ]] || continue
    (( pid > 1 )) || continue
    [[ "$pid" != "$$" ]] || continue
    kill -0 "$pid" 2>/dev/null || continue
    wavemill_pid_is_descendant "$pane_pid" "$pid" || continue
    _wavemill_kill_process_tree "$pid"
    terminated_any=true
  done

  [[ "$terminated_any" == true ]]
}

# Run a command with a hard wall-clock timeout.
#
# Backend selection is portable across Linux and macOS:
#   1. GNU timeout, when available as `timeout`
#   2. GNU timeout, when available as Homebrew's `gtimeout`
#   3. A bash watchdog fallback
#
# Exit semantics are canonical across all paths:
#   - command finishes before the deadline: return the command's exit status
#   - command exceeds the deadline: return 124
#   - invalid invocation: return non-zero without running the command
#
# The fallback waits only for the wrapped command, so fast commands return
# immediately instead of waiting for the watchdog sleep. The watchdog redirects
# its own descriptors to /dev/null so command substitutions such as
# `out=$(_with_timeout 5 echo hi)` do not stay open after the command exits.
# Cleanup kills the watchdog sleep child before killing the watchdog subshell,
# which avoids leaked `sleep` processes on macOS.
# Usage: _with_timeout <seconds> <command> [args...]
_with_timeout() {
  local secs="${1:-}"

  [[ "$secs" =~ ^[0-9]+([.][0-9]+)?$ ]] || return 1
  shift || return 1
  (( $# > 0 )) || return 1

  if command -v timeout >/dev/null 2>&1; then
    timeout "$secs" "$@"
    return $?
  fi
  if command -v gtimeout >/dev/null 2>&1; then
    gtimeout "$secs" "$@"
    return $?
  fi

  local marker_dir timeout_marker cmd_pid watchdog_pid rc=0
  marker_dir="${TMPDIR:-/tmp}"
  timeout_marker="$(mktemp "${marker_dir%/}/wavemill-timeout.XXXXXX")" || return 1
  rm -f "$timeout_marker"

  "$@" &
  cmd_pid=$!

  (
    sleep "$secs" || exit 0
    : > "$timeout_marker"
    _wavemill_kill_process_tree "$cmd_pid"
  ) >/dev/null 2>&1 &
  watchdog_pid=$!

  wait "$cmd_pid" 2>/dev/null || rc=$?

  if command -v pkill >/dev/null 2>&1; then
    pkill -P "$watchdog_pid" 2>/dev/null || true
  fi
  kill "$watchdog_pid" 2>/dev/null || true
  wait "$watchdog_pid" 2>/dev/null || true

  if [[ -f "$timeout_marker" ]]; then
    rc=124
  fi
  rm -f "$timeout_marker"

  return "$rc"
}

wavemill_git_remote_with_timeout() {
  local timeout_seconds="${1:-}"
  shift || true

  [[ "$timeout_seconds" =~ ^[0-9]+$ ]] || return 1
  (( $# > 0 )) || return 1

  if command -v timeout >/dev/null 2>&1; then
    timeout "$timeout_seconds" git "$@"
    return $?
  fi
  if command -v gtimeout >/dev/null 2>&1; then
    gtimeout "$timeout_seconds" git "$@"
    return $?
  fi

  local marker_dir timeout_marker cmd_pid watchdog_pid rc=0
  local process_group_pid=""
  marker_dir="${TMPDIR:-/tmp}"
  timeout_marker="$(mktemp "${marker_dir%/}/wavemill-git-timeout.XXXXXX")" || return 1
  rm -f "$timeout_marker"

  if command -v setsid >/dev/null 2>&1; then
    setsid git "$@" &
    cmd_pid=$!
    process_group_pid="$cmd_pid"
  else
    git "$@" &
    cmd_pid=$!
  fi

  (
    sleep "$timeout_seconds"
    : > "$timeout_marker"
    if [[ -n "$process_group_pid" ]]; then
      kill -TERM -- "-$process_group_pid" 2>/dev/null || true
      sleep 1
      kill -KILL -- "-$process_group_pid" 2>/dev/null || true
    else
      _wavemill_kill_process_tree "$cmd_pid"
    fi
  ) >/dev/null 2>&1 &
  watchdog_pid=$!

  wait "$cmd_pid" 2>/dev/null || rc=$?
  kill "$watchdog_pid" 2>/dev/null || true

  if [[ -f "$timeout_marker" ]]; then
    rc=124
  fi
  rm -f "$timeout_marker"

  return "$rc"
}

# Backwards-compatible wrapper for callers that haven't migrated to load_config()
detect_project_name() {
  local repo_dir="${1:-$PWD}"

  # If load_config() already ran, PROJECT_NAME is set
  if [[ -n "${PROJECT_NAME:-}" ]]; then
    echo "$PROJECT_NAME"
    return
  fi

  # Legacy fallback
  local project_name=""
  project_name=$(wavemill_load_config "$repo_dir" | jq -r '.linear.project // empty' 2>/dev/null)
  if [[ -z "$project_name" ]]; then
    project_name="${PROJECT_NAME:-}"
  fi
  echo "$project_name"
}

# Returns the operating mode for a specific model: normal|constrained|survival
get_model_operating_mode() {
  local model_id="$1"
  local repo_dir="${2:-${REPO_DIR:-$PWD}}"
  local tools_dir="${TOOLS_DIR:-${repo_dir%/}/tools}"

  npx tsx "$tools_dir/get-operating-mode.ts" model "$model_id" --repo-dir "$repo_dir" 2>/dev/null || echo "normal"
}

# Returns exit code 0 if any model is healthy, 1 if all are degraded/exhausted.
# On unexpected errors (exit code > 1, e.g. npx not found), returns 0 to safely assume models are healthy.
has_any_healthy_model() {
  local repo_dir="${1:-${REPO_DIR:-$PWD}}"
  local tools_dir="${TOOLS_DIR:-${repo_dir%/}/tools}"

  npx tsx "$tools_dir/get-operating-mode.ts" any-healthy --repo-dir "$repo_dir" 2>/dev/null
  local exit_code=$?
  if [[ $exit_code -gt 1 ]]; then
    return 0  # Unexpected error, assume models are healthy
  fi
  return $exit_code  # Pass through 0 or 1
}

# ============================================================================
# PR CACHE HELPERS
# ============================================================================

wavemill_pr_cache_refresh() {
  local session="${SESSION:-wavemill}"
  local cache_file="${MONITOR_PR_CACHE:-/tmp/${session}-pr-cache.json}"
  local tmp_file
  # Per-writer tmp file: monitor and dashboard both refresh this cache, and a
  # shared "${cache_file}.tmp" leads to a race where one writer's mv consumes
  # the file before the other's mv runs.
  tmp_file="$(mktemp "${cache_file}.tmp.XXXXXX" 2>/dev/null)" || return 0
  if gh pr list --json number,headRefName,state,statusCheckRollup --limit 50 \
       < /dev/null 2>/dev/null > "$tmp_file"; then
    if [[ -s "$tmp_file" ]]; then
      mv "$tmp_file" "$cache_file" 2>/dev/null || rm -f "$tmp_file"
    else
      rm -f "$tmp_file"
    fi
  else
    rm -f "$tmp_file"
  fi
}

wavemill_pr_lookup_by_branch() {
  local branch="${1:-}"
  local session="${SESSION:-wavemill}"
  local cache_file="${MONITOR_PR_CACHE:-/tmp/${session}-pr-cache.json}"
  [[ -n "$branch" && -f "$cache_file" ]] || return 0
  jq -r --arg b "$branch" \
    '.[] | select(.headRefName == $b) | .number' \
    "${cache_file}" 2>/dev/null | head -1
}

wavemill_pr_live_state() {
  local pr_number="${1:-}"
  [[ -n "$pr_number" ]] || return 1
  gh pr view "$pr_number" --json number,state,mergedAt --jq \
    '{number, state, mergedAt, terminalState: (if .mergedAt != null then "MERGED" elif .state == "CLOSED" then "CLOSED" else .state end)}' 2>/dev/null
}

wavemill_reconcile_terminal() {
  local lib_dir="${LIB_DIR:-}"
  if [[ -z "$lib_dir" && -n "${BASH_SOURCE[0]:-}" ]]; then
    lib_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || true)"
  fi
  if [[ -n "$lib_dir" && -f "$lib_dir/terminal-reconciler.sh" ]]; then
    # shellcheck source=terminal-reconciler.sh
    source "$lib_dir/terminal-reconciler.sh" || return 0
    wavemill_reconcile_terminal "$@"
    return $?
  fi
  return 0
}

# ============================================================================
# GITHUB HELPERS
# ============================================================================

# Check whether a branch has any PR in GitHub, including closed or merged PRs.
# Returns 0 when a PR exists and 1 when no PR is found or GitHub cannot be
# queried. Callers use this as a guard before taking destructive cleanup paths.
check_pr_exists() {
  local branch="$1"
  local pr_number=""

  if [[ -z "$branch" ]]; then
    return 1
  fi

  pr_number=$(gh pr list --head "$branch" --state all --json number --jq '.[0].number // empty' 2>/dev/null || echo "")
  [[ -n "$pr_number" ]]
}

# Read a field from the canonical startup routing artifact.
# Fallback chain: route.json -> model-suggestion.json shim -> default value.
#
# Canonical route.json contract (written by tools/route-task.ts):
#   {
#     planner,
#     coder,
#     reviewer,
#     planDepth,
#     codeDepth,
#     reviewRecommended,
#     routingMode,
#     neighborCount,
#     expectedSuccess,
#     constraints,
#     signals,
#     reasoning
#   }
#
# COMPAT: model-suggestion.json is a temporary coder-only shim for pre-HOK-1198
# consumers and pre-HOK-1197 startup sessions. New routing consumers should
# read route.json through this helper instead of reading the shim directly.
#
# Usage: read_route_json <session> <issue> <field> [default]
route_read_field() {
  local route_file="$1" field="$2" default_value="${3:-}"
  local value=""

  if [[ ! -f "$route_file" ]]; then
    return 1
  fi

  if ! jq -e '.' "$route_file" >/dev/null 2>&1; then
    return 2
  fi

  value=$(jq -r --arg field "$field" '
    if ($field | contains(".")) then
      ($field | split(".")) as $path | getpath($path) // empty
    else
      .[$field] // .provenance[$field] // empty
    end
  ' "$route_file" 2>/dev/null || true)
  if [[ -n "$value" ]]; then
    echo "$value"
    return 0
  fi

  echo "$default_value"
  return 0
}

write_json_artifact() {
  local target_path="$1"
  local tmp_file
  tmp_file="$(mktemp "${target_path}.tmp.XXXXXX")" || {
    echo "write_json_artifact: failed to allocate temp file for $target_path" >&2
    return 1
  }

  if ! cat > "$tmp_file"; then
    rm -f "$tmp_file"
    echo "write_json_artifact: failed to read JSON payload for $target_path" >&2
    return 1
  fi

  if ! jq -e . "$tmp_file" >/dev/null 2>&1; then
    rm -f "$tmp_file"
    echo "write_json_artifact: invalid JSON for $target_path" >&2
    return 1
  fi

  if ! mv "$tmp_file" "$target_path"; then
    rm -f "$tmp_file"
    echo "write_json_artifact: failed to move temp file into place for $target_path" >&2
    return 1
  fi
}

read_route_json() {
  local session="$1" issue="$2" field="$3" default_value="${4:-}"
  local route_file="/tmp/${session}-${issue}-route.json"
  local suggestion_file="/tmp/${session}-${issue}-model-suggestion.json"
  local value=""

  if value=$(route_read_field "$route_file" "$field" ""); then
    if [[ -n "$value" ]]; then
      echo "$value"
      return 0
    fi
  fi

  if [[ -f "$suggestion_file" ]]; then
    case "$field" in
      coder)
        value=$(jq -r '.recommendedModel // empty' "$suggestion_file" 2>/dev/null || true)
        if [[ -n "$value" ]]; then
          echo "$value"
          return 0
        fi
        ;;
    esac
  fi

  echo "$default_value"
}

find_expanded_route_artifact() {
  local feature_dir="$1"
  local route_file=""

  for route_file in \
    "$feature_dir/.post-expansion-route.json" \
    "$feature_dir/.expanded-route.json"; do
    if [[ -f "$route_file" ]]; then
      printf '%s\n' "$route_file"
      return 0
    fi
  done

  return 1
}

get_expansion_handshake_policy() {
  local repo_dir="$1"
  local cfg_policy=""

  cfg_policy=$(wavemill_load_config "$repo_dir" | jq -r '.mill.expansionHandshake.policy // "recover"' 2>/dev/null || echo "recover")
  case "$cfg_policy" in
    recover|block|warn)
      printf '%s\n' "$cfg_policy"
      ;;
    *)
      printf 'recover\n'
      ;;
  esac
}

get_expansion_handshake_timeout_seconds() {
  local repo_dir="$1"
  local cfg_timeout=""

  cfg_timeout=$(wavemill_load_config "$repo_dir" | jq -r '.mill.expansionHandshake.timeoutSeconds // 300' 2>/dev/null || echo "300")
  if [[ "$cfg_timeout" =~ ^[0-9]+$ ]] && (( cfg_timeout >= 1 )); then
    printf '%s\n' "$cfg_timeout"
  else
    printf '300\n'
  fi
}

validate_expanded_route_artifact() {
  local route_file="$1"

  [[ -n "$route_file" && -f "$route_file" ]] || return 1

  jq -e '
    type == "object"
    and (.coder | type == "string" and length > 0)
    and (.codeDepth | type == "string" and length > 0)
    and (.reviewer | type == "string" and length > 0)
    and ((.reviewMode // .reviewRecommended // "") | type == "string" and length > 0)
  ' "$route_file" >/dev/null 2>&1
}

mill_expansion_handshake_reason() {
  local feature_dir="$1"
  local packet_file="$feature_dir/task-packet.md"
  local route_file=""
  local packet_content=""

  if [[ -f "$packet_file" ]]; then
    packet_content=$(cat "$packet_file" 2>/dev/null || echo "")
  fi

  if is_task_packet "$packet_content"; then
    printf 'already-expanded\n'
    return 0
  fi

  route_file="$(find_expanded_route_artifact "$feature_dir" 2>/dev/null || true)"
  if [[ -n "$route_file" ]]; then
    if ! jq -e '.' "$route_file" >/dev/null 2>&1; then
      printf 'invalid-json\n'
      return 0
    fi
    if validate_expanded_route_artifact "$route_file"; then
      printf 'expanded-route-present\n'
      return 0
    fi
    printf 'missing-required-field\n'
    return 0
  fi

  printf 'missing\n'
  return 0
}

route_lifecycle_route_id() {
  local route_file="$1"
  [[ -n "$route_file" && -f "$route_file" ]] || return 1

  jq -r '
    "coder=\(.coder // ""),codeDepth=\(.codeDepth // ""),reviewer=\(.reviewer // ""),reviewMode=\(.reviewMode // .reviewRecommended // "")"
  ' "$route_file" 2>/dev/null
}

router_log_verbose_enabled() {
  local raw="${WAVEMILL_ROUTER_LOG_VERBOSE:-}"
  raw="$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]')"
  case "$raw" in
    1|true|yes|on)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

route_summary_signature() {
  local route_file="$1"
  [[ -n "$route_file" && -f "$route_file" ]] || return 1

  local parts=() value
  value="$(jq -r '.planner // empty' "$route_file" 2>/dev/null || true)"
  [[ -n "$value" ]] && parts+=("planner=$value")
  value="$(jq -r '.planDepth // empty' "$route_file" 2>/dev/null || true)"
  [[ -n "$value" ]] && parts+=("planDepth=$value")
  value="$(jq -r '.coder // empty' "$route_file" 2>/dev/null || true)"
  [[ -n "$value" ]] && parts+=("coder=$value")
  value="$(jq -r '.codeDepth // empty' "$route_file" 2>/dev/null || true)"
  [[ -n "$value" ]] && parts+=("codeDepth=$value")
  value="$(jq -r '.reviewer // empty' "$route_file" 2>/dev/null || true)"
  [[ -n "$value" ]] && parts+=("reviewer=$value")
  value="$(jq -r '.reviewMode // .reviewRecommended // empty' "$route_file" 2>/dev/null || true)"
  [[ -n "$value" ]] && parts+=("reviewMode=$value")
  value="$(jq -r '.signals.taskType // .provenance.signalVector.taskType // empty' "$route_file" 2>/dev/null || true)"
  [[ -n "$value" ]] && parts+=("taskType=$value")
  value="$(jq -r '.signals.complexityScore // .provenance.signalVector.complexityScore // empty' "$route_file" 2>/dev/null || true)"
  [[ -n "$value" ]] && parts+=("complexity=$value")
  value="$(jq -r '.signals.complexityBand // .provenance.signalVector.complexityBand // empty' "$route_file" 2>/dev/null || true)"
  [[ -n "$value" ]] && parts+=("band=$value")
  value="$(jq -r '(.signals.riskFlags // .provenance.signalVector.riskFlags // []) | if type == "array" then join("|") else tostring end' "$route_file" 2>/dev/null || true)"
  [[ -n "$value" ]] && parts+=("riskFlags=$value")
  value="$(jq -r '.signals.suspiciousZero // .provenance.signalVector.suspiciousZero // false' "$route_file" 2>/dev/null || true)"
  [[ "$value" == "true" ]] && parts+=("suspiciousZero=true")

  local IFS=", "
  printf '%s\n' "${parts[*]}"
}

route_summary_mode_tag() {
  local route_file="$1"
  [[ -n "$route_file" && -f "$route_file" ]] || return 1

  local mode
  mode="$(jq -r '.provenance.routerMode // .routerMode // .routingMode // empty' "$route_file" 2>/dev/null || true)"
  case "$mode" in
    constrained|survival)
      printf '[mode=%s] ' "$mode"
      ;;
    *)
      printf ''
      ;;
  esac
}

log_router_route_summary() {
  local issue="$1" route_file="$2"
  [[ -n "$issue" && -n "$route_file" && -f "$route_file" ]] || return 0

  local signature mode_tag key
  signature="$(route_summary_signature "$route_file" 2>/dev/null || true)"
  [[ -n "$signature" ]] || return 0
  mode_tag="$(route_summary_mode_tag "$route_file" 2>/dev/null || true)"
  key="${issue}|${mode_tag}${signature}"
  if [[ "${_WAVEMILL_LAST_ROUTE_SUMMARY_KEY:-}" == "$key" ]]; then
    return 0
  fi
  _WAVEMILL_LAST_ROUTE_SUMMARY_KEY="$key"
  log "info" "[$issue] [router] ${mode_tag}${signature}"
}

log_route_lifecycle() {
  local event="$1"
  shift || true

  if ! router_log_verbose_enabled; then
    case "$event" in
      bootstrap_assigned|expanded_assigned|expansion_cache_hit|execution_active)
        return 0
        ;;
    esac
  fi

  local line="route.lifecycle: event=${event}"
  local token
  for token in "$@"; do
    [[ -n "$token" ]] || continue
    line+=" ${token}"
  done
  log "info" "$line"
}

emit_execution_active_route() {
  local feature_dir="$1" issue="$2"
  local routing_file="$feature_dir/.routing-complete"
  local bootstrap_file="$feature_dir/.initial-route.json"
  local expanded_file=""
  local active_route="" bootstrap_route="" expanded_route="" route_changed="" source=""

  [[ -f "$routing_file" ]] || return 0
  active_route="$(route_lifecycle_route_id "$routing_file" 2>/dev/null || true)"
  [[ -n "$active_route" ]] || return 0

  if [[ -f "$bootstrap_file" ]]; then
    bootstrap_route="$(route_lifecycle_route_id "$bootstrap_file" 2>/dev/null || true)"
  fi

  expanded_file="$(find_expanded_route_artifact "$feature_dir" 2>/dev/null || true)"
  if [[ -n "$expanded_file" ]]; then
    expanded_route="$(route_lifecycle_route_id "$expanded_file" 2>/dev/null || true)"
  fi

  route_changed="false"
  if [[ -n "$bootstrap_route" && "$bootstrap_route" != "$active_route" ]]; then
    route_changed="true"
  fi

  source="bootstrap"
  if [[ -n "$expanded_route" ]]; then
    if [[ "$expanded_route" == "$active_route" ]]; then
      if [[ -n "$bootstrap_route" && "$bootstrap_route" == "$active_route" ]]; then
        source="preserved"
      else
        source="expanded"
      fi
    else
      source="preserved"
    fi
  fi

  log_router_route_summary "$issue" "$routing_file"
  log_route_lifecycle "execution_active" \
    "issue=$issue" \
    "route=\"$active_route\"" \
    "route_changed=$route_changed" \
    "source=$source"
}

ensure_phase_config_state_file() {
  local feature_dir="$1"
  local config_file="$feature_dir/.phase-config.json"

  if [[ -f "$config_file" ]] && jq empty "$config_file" >/dev/null 2>&1; then
    return 0
  fi

  mkdir -p "$feature_dir"
  cat > "$config_file" <<'EOF'
{
  "planning": {
    "model": "",
    "agent": "",
    "depth": ""
  },
  "coding": {
    "model": "",
    "agent": "",
    "depth": ""
  },
  "review": {
    "model": "",
    "agent": "",
    "mode": ""
  },
  "resolvedAt": "",
  "forceModel": null
}
EOF
}

apply_expanded_route_if_present() {
  local feature_dir="$1" issue="$2" slug="$3" worktree_dir="$4" state_file="${5:-${STATE_FILE:-}}"
  local route_file routing_file phase_config_file planner_model plan_depth coder_model code_depth reviewer_model review_mode
  local planner_agent="" coder_agent="" reviewer_agent=""
  local planner_provider="" coder_provider="" reviewer_provider=""
  local active_route="" bootstrap_route="" expanded_route="" route_changed="false" source="expanded"
  local challenge_intent_file="" challenge_intent_tmp="" challenge_side=""

  route_file="$(find_expanded_route_artifact "$feature_dir" 2>/dev/null || true)"
  [[ -n "$route_file" ]] || return 0

  if ! jq -e '.' "$route_file" >/dev/null 2>&1; then
    log "warn" "expanded route invalid: $route_file (malformed JSON)"
    active_route="$(route_lifecycle_route_id "$feature_dir/.routing-complete" 2>/dev/null || true)"
    log_route_lifecycle "expansion_failed" "issue=$issue" "reason=invalid_artifact" "active_route=\"${active_route}\""
    return 1
  fi

  if ! validate_expanded_route_artifact "$route_file"; then
    log "warn" "expanded route invalid: $route_file (missing required execution fields)"
    active_route="$(route_lifecycle_route_id "$feature_dir/.routing-complete" 2>/dev/null || true)"
    log_route_lifecycle "expansion_failed" "issue=$issue" "reason=invalid_artifact" "active_route=\"${active_route}\""
    return 1
  fi

  routing_file="$feature_dir/.routing-complete"
  phase_config_file="$feature_dir/.phase-config.json"

  if [[ -f "$routing_file" && ! -f "$feature_dir/.initial-route.json" ]]; then
    cp "$routing_file" "$feature_dir/.initial-route.json"
  fi

  if [[ ! -f "$routing_file" ]]; then
    printf '{}\n' | write_json_artifact "$routing_file"
  fi

  for candidate in "$feature_dir/challenge-intent.json" "$feature_dir/.challenge-intent.json"; do
    if [[ -f "$candidate" ]] && jq -e . "$candidate" >/dev/null 2>&1; then
      challenge_intent_file="$candidate"
      break
    fi
  done
  if [[ -z "$challenge_intent_file" && -n "$state_file" && -f "$state_file" ]]; then
    # Newer launches persist the canonical execution intent; startup launches
    # persist its projected challengeIntent.  Both carry expectedRoute and are
    # valid inputs for retaining the arm selected before expansion.
    if jq -e --arg issue "$issue" '(.tasks[$issue].challengeIntent? // .tasks[$issue].challengeExecutionIntent? // empty)' "$state_file" >/dev/null 2>&1; then
      challenge_intent_tmp="$(mktemp "${TMPDIR:-/tmp}/wavemill-challenge-intent.XXXXXX")"
      jq --arg issue "$issue" '(.tasks[$issue].challengeIntent? // .tasks[$issue].challengeExecutionIntent? // empty)' "$state_file" > "$challenge_intent_tmp" 2>/dev/null || true
      if [[ -s "$challenge_intent_tmp" ]] && jq -e . "$challenge_intent_tmp" >/dev/null 2>&1; then
        challenge_intent_file="$challenge_intent_tmp"
      fi
    fi
  fi
  if [[ -n "$challenge_intent_file" ]]; then
    challenge_side="$(jq -r --arg issue "$issue" '
      if ($issue | endswith("_c")) then "challenger"
      elif (.primary.pairId // .pairId // "") != "" then "primary"
      else empty end
    ' "$challenge_intent_file" 2>/dev/null || true)"
  fi

  if ! state_mutate "$routing_file" \
    '# nz: first argument unless it is null/empty string, else the fallback.
     # jq "//" only rejects null and false, so "" would otherwise win.
     def nz(a; b): if ((a) // "") == "" then (b) else (a) end;
     # Both persisted intent schemas are accepted here.  The projection schema
     # (challenge-execution-contract.ts) carries challengeStage and a per-side
     # expectedRoute; the envelope schema (challenge-mode.ts) carries
     # selectedStage and per-side {planner,coder,reviewer}:{model,agent}.
     # Reading only one of them silently degrades to a no-op merge, which is
     # how selected challenge arms were being replaced by the expanded route.
     def stage_of($intentObj; $sideObj):
       (nz($intentObj.challengeStage;
           nz($intentObj.selectedStage; $sideObj.challengeStage)) | tostring | ascii_downcase) as $raw
       | if   $raw == "plan"   or $raw == "planning" or $raw == "planner" then "plan"
         elif $raw == "review" or $raw == "reviewer" then "review"
         elif $raw == "implementation" or $raw == "coding" or $raw == "coder" then "implementation"
         else "" end;
     def expected_of($sideObj):
       nz($sideObj.expectedRoute;
          { planner:  ($sideObj.planner.model  // ""),
            coder:    ($sideObj.coder.model    // ""),
            reviewer: ($sideObj.reviewer.model // ""),
            planDepth: "", codeDepth: "", reviewMode: "" });
     . as $base
     | $route[0] as $route
     | ($intent[0]? // null) as $intentObj
     | ($side // "") as $sideName
     | ($base + $route) as $rawEffective
     | (if $intentObj == null or $sideName == "" then $rawEffective
        else
          ($intentObj[$sideName] // {}) as $sideObj
          | expected_of($sideObj) as $expected
          | stage_of($intentObj; $sideObj) as $stage
          | (if   $stage == "plan"   then ($expected.planner  // "")
             elif $stage == "review" then ($expected.reviewer // "")
             elif $stage == "implementation" then ($expected.coder // "")
             else "" end) as $variedModel
          | if $stage == "" or $variedModel == "" then
              # The intent could not be read.  Leave the expanded route alone
              # rather than claiming a preservation that did not happen: a false
              # challengeIntentApplied hides the loss from every later check.
              $rawEffective
              | .challengeArmPreserved = false
              | .challengeArmPreserveReason =
                  (if $stage == "" then "unresolved_challenge_stage" else "missing_expected_stage_model" end)
            else
              $rawEffective
              | if $stage == "plan" then
                  .planner = $variedModel
                  | .planDepth = nz($expected.planDepth; .planDepth)
                elif $stage == "review" then
                  .reviewer = $variedModel
                  | .reviewMode = nz($expected.reviewMode; nz(.reviewMode; .reviewRecommended))
                  | .reviewRecommended = .reviewMode
                else
                  .coder = $variedModel
                  | .codeDepth = nz($expected.codeDepth; .codeDepth)
                end
              | .challengeIntentApplied = true
              | .challengeArmPreserved = true
              | .challengeArmPreserveReason = "applied"
              | .intendedStage = $stage
              | .rawExpandedRoute = $route
            end
        end)
     | .reviewMode = (
         if (.challengeIntentApplied == true and .intendedStage == "review") then
           (.reviewMode // $route.reviewMode // $route.reviewRecommended // $base.reviewMode // $base.reviewRecommended // "")
         else
           ($route.reviewMode // $route.reviewRecommended // .reviewMode // $base.reviewMode // $base.reviewRecommended // "")
         end
       )
     | .reviewRecommended = .reviewMode
     | .provenance = (($base.provenance // {}) + ($route.provenance // {}) + {
         source: "expanded",
         appliedFrom: $routeFile,
         appliedAt: (
           if (($base.provenance.appliedFrom // "") == $routeFile)
             and (($base.coder // "") == ($route.coder // ""))
             and (($base.codeDepth // "") == ($route.codeDepth // ""))
             and (($base.reviewer // "") == ($route.reviewer // ""))
             and (($base.reviewMode // $base.reviewRecommended // "") == ($route.reviewMode // $route.reviewRecommended // ""))
           then ($base.provenance.appliedAt // (now | todateiso8601))
           else (now | todateiso8601)
           end
         )
       })' \
    --arg routeFile "$route_file" \
    --arg side "$challenge_side" \
    --slurpfile intent "${challenge_intent_file:-/dev/null}" \
    --slurpfile route "$route_file"; then
    log "warn" "expanded route invalid: $route_file (failed to update .routing-complete)"
    active_route="$(route_lifecycle_route_id "$feature_dir/.routing-complete" 2>/dev/null || true)"
    log_route_lifecycle "expansion_failed" "issue=$issue" "reason=invalid_artifact" "active_route=\"${active_route}\""
    return 1
  fi
  if [[ -n "$challenge_intent_file" ]]; then
    local arm_preserved arm_reason
    arm_preserved="$(jq -r '.challengeArmPreserved // "unset"' "$routing_file" 2>/dev/null || echo "unset")"
    arm_reason="$(jq -r '.challengeArmPreserveReason // "unknown"' "$routing_file" 2>/dev/null || echo "unknown")"
    if [[ "$arm_preserved" != "true" ]]; then
      # The selected experimental arm was NOT retained through rerouting.  The
      # pair will still run, but its varied stage now matches the expanded
      # route instead of the selection, so any comparison is unattributable.
      local arm_msg="  $issue: challenge arm NOT preserved through expanded routing (reason=$arm_reason, side=${challenge_side:-unknown}, intent=$challenge_intent_file)"
      if declare -F log_error >/dev/null 2>&1; then
        log_error "$arm_msg"
      else
        log "warn" "$arm_msg"
      fi
      log_route_lifecycle "challenge_arm_lost" \
        "issue=$issue" \
        "reason=$arm_reason" \
        "side=${challenge_side:-unknown}"
    fi
  fi
  # The intent is written once at selection and is read-only from here on.
  # Copying the consumed intent back over the feature-dir file (and, previously,
  # over .tasks[].challengeIntent) let a rerouting pass overwrite the selection
  # record with whichever schema it happened to load — one-way corruption that
  # disarmed preservation for every later phase of the same task.
  if [[ -n "$challenge_intent_file" && ! -f "$feature_dir/challenge-intent.json" ]]; then
    cp "$challenge_intent_file" "$feature_dir/challenge-intent.json" 2>/dev/null || true
  fi
  if [[ -n "$challenge_intent_tmp" ]]; then
    rm -f "$challenge_intent_tmp" 2>/dev/null || true
    challenge_intent_tmp=""
  fi

  planner_model="$(jq -r '.planner // empty' "$routing_file" 2>/dev/null || true)"
  plan_depth="$(jq -r '.planDepth // empty' "$routing_file" 2>/dev/null || true)"
  coder_model="$(jq -r '.coder // empty' "$routing_file" 2>/dev/null || true)"
  code_depth="$(jq -r '.codeDepth // empty' "$routing_file" 2>/dev/null || true)"
  reviewer_model="$(jq -r '.reviewer // empty' "$routing_file" 2>/dev/null || true)"
  review_mode="$(jq -r '(.reviewMode // .reviewRecommended // empty)' "$routing_file" 2>/dev/null || true)"

  ensure_phase_config_state_file "$feature_dir"

  if declare -F agent_resolve_models_for_roles >/dev/null 2>&1; then
    if agent_resolve_models_for_roles "$planner_model" "$coder_model" "$reviewer_model"; then
      :
    fi
    planner_agent="$(agent_resolve_batch_agent_for_role "planner")"
    coder_agent="$(agent_resolve_batch_agent_for_role "coder")"
    reviewer_agent="$(agent_resolve_batch_agent_for_role "reviewer")"
  elif declare -F agent_resolve_from_model >/dev/null 2>&1; then
    [[ -n "$planner_model" ]] && planner_agent="$(agent_resolve_from_model "$planner_model" "planning" || true)"
    [[ -n "$coder_model" ]] && coder_agent="$(agent_resolve_from_model "$coder_model" "coding" || true)"
    [[ -n "$reviewer_model" ]] && reviewer_agent="$(agent_resolve_from_model "$reviewer_model" "review" || true)"
  fi

  case "$planner_agent" in
    native-openrouter) planner_provider="native-openrouter" ;;
    native-openai) planner_provider="native-openai" ;;
    claude) planner_provider="anthropic" ;;
    codex) planner_provider="openai" ;;
  esac
  case "$coder_agent" in
    native-openrouter) coder_provider="native-openrouter" ;;
    native-openai) coder_provider="native-openai" ;;
    claude) coder_provider="anthropic" ;;
    codex) coder_provider="openai" ;;
  esac
  case "$reviewer_agent" in
    native-openrouter) reviewer_provider="native-openrouter" ;;
    native-openai) reviewer_provider="native-openai" ;;
    claude) reviewer_provider="anthropic" ;;
    codex) reviewer_provider="openai" ;;
  esac

  if ! state_mutate "$phase_config_file" \
    '.planning.model = $plannerModel
     | .planning.agent = $plannerAgent
     | .planning.provider = $plannerProvider
     | .planning.stageRole = "planning"
     | .planning.selectedAt = (.planning.selectedAt // .resolvedAt // (now | todateiso8601))
     | .planning.depth = $planDepth
     | .coding.model = $coderModel
     | .coding.agent = $coderAgent
     | .coding.provider = $coderProvider
     | .coding.stageRole = "coding"
     | .coding.selectedAt = (.coding.selectedAt // .resolvedAt // (now | todateiso8601))
     | .coding.depth = $codeDepth
     | .review.model = $reviewerModel
     | .review.agent = $reviewerAgent
     | .review.provider = $reviewerProvider
     | .review.stageRole = "review"
     | .review.selectedAt = (.review.selectedAt // .resolvedAt // (now | todateiso8601))
     | .review.mode = $reviewMode
     | .resolvedAt = (if (.resolvedAt // "") == "" then (now | todateiso8601) else .resolvedAt end)
     | .forceModel = (.forceModel // null)' \
    --arg plannerModel "$planner_model" \
    --arg plannerAgent "$planner_agent" \
    --arg plannerProvider "$planner_provider" \
    --arg planDepth "$plan_depth" \
    --arg coderModel "$coder_model" \
    --arg coderAgent "$coder_agent" \
    --arg coderProvider "$coder_provider" \
    --arg codeDepth "$code_depth" \
    --arg reviewerModel "$reviewer_model" \
    --arg reviewerAgent "$reviewer_agent" \
    --arg reviewerProvider "$reviewer_provider" \
    --arg reviewMode "$review_mode"; then
    log "warn" "expanded route invalid: $route_file (failed to update .phase-config.json)"
    active_route="$(route_lifecycle_route_id "$routing_file" 2>/dev/null || true)"
    log_route_lifecycle "expansion_failed" "issue=$issue" "reason=invalid_artifact" "active_route=\"${active_route}\""
    return 1
  fi

  if [[ -n "$state_file" && -f "$state_file" ]]; then
    if ! state_mutate "$state_file" \
      '.tasks[$issue].plannerModel = $plannerModel
       | .tasks[$issue].coderModel = $coderModel
       | .tasks[$issue].reviewerModel = $reviewerModel
       | .tasks[$issue].planDepth = $planDepth
       | .tasks[$issue].codeDepth = $codeDepth
       | .tasks[$issue].reviewMode = $reviewMode
       # challengeIntent is deliberately NOT written here.  It records the arm
       # chosen at selection time; rerouting consumes it and must never author it.
       | .tasks[$issue].slug = (.tasks[$issue].slug // $slug)
       | .tasks[$issue].worktree = (.tasks[$issue].worktree // $worktree)
       | .tasks[$issue].updated = (now | todate)' \
      --arg issue "$issue" \
      --arg slug "$slug" \
      --arg worktree "$worktree_dir" \
      --arg plannerModel "$planner_model" \
      --arg coderModel "$coder_model" \
      --arg reviewerModel "$reviewer_model" \
      --arg planDepth "$plan_depth" \
      --arg codeDepth "$code_depth" \
      --arg reviewMode "$review_mode"; then
      log "warn" "expanded route invalid: $route_file (failed to update workflow state)"
      active_route="$(route_lifecycle_route_id "$routing_file" 2>/dev/null || true)"
      log_route_lifecycle "expansion_failed" "issue=$issue" "reason=invalid_artifact" "active_route=\"${active_route}\""
      return 1
    fi
  fi

  bootstrap_route="$(route_lifecycle_route_id "$feature_dir/.initial-route.json" 2>/dev/null || true)"
  expanded_route="$(route_lifecycle_route_id "$route_file" 2>/dev/null || true)"
  active_route="$(route_lifecycle_route_id "$routing_file" 2>/dev/null || true)"
  if [[ -n "$bootstrap_route" && -n "$active_route" && "$bootstrap_route" != "$active_route" ]]; then
    route_changed="true"
  fi
  if [[ -n "$bootstrap_route" && "$bootstrap_route" == "$active_route" ]]; then
    source="preserved"
  fi

  local is_cache_hit
  is_cache_hit="$(jq -r '.cache_hit // false' "$route_file" 2>/dev/null || echo "false")"

  if [[ "$is_cache_hit" == "true" ]]; then
    local packet_hash
    packet_hash="$(jq -r '.packet_hash // ""' "$route_file" 2>/dev/null || true)"
    log_route_lifecycle "expansion_cache_hit" \
      "issue=$issue" \
      "route=\"${expanded_route}\"" \
      "packet_hash=${packet_hash:0:12}"
  else
    log_route_lifecycle "expanded_assigned" \
      "issue=$issue" \
      "bootstrap_route=\"${bootstrap_route}\"" \
      "expanded_route=\"${expanded_route}\"" \
      "route_changed=$route_changed" \
      "source=$source"
  fi

  log_router_route_summary "$issue" "$routing_file"

  return 0
}

# Gate: check expansion handshake before plan→code transition.
# Args: <feature_dir> <issue> <repo_dir>
# Returns 0 (pass or warn) or 1 (block).
mill_check_expansion_handshake() {
  local feature_dir="$1" issue="$2" repo_dir="$3"
  local reason policy

  reason="$(mill_expansion_handshake_reason "$feature_dir")"
  case "$reason" in
    already-expanded|expanded-route-present)
      if router_log_verbose_enabled; then
        log "info" "[expansion-handshake] PASS issue=$issue reason=$reason"
      fi
      return 0
      ;;
  esac

  policy="$(get_expansion_handshake_policy "$repo_dir")"

  if [[ "$policy" == "warn" ]]; then
    log "warn" "[expansion-handshake] WARN issue=$issue reason=$reason policy=warn"
    return 0
  fi

  log "warn" "[expansion-handshake] BLOCKED issue=$issue reason=$reason policy=$policy recover=\"wavemill expand $issue\""
  return 1
}

expansion_recovery_state_file() {
  local feature_dir="$1"
  printf '%s/.expansion-recovery-state.json\n' "$feature_dir"
}

ensure_expansion_recovery_state_file() {
  local feature_dir="$1"
  local state_file
  state_file="$(expansion_recovery_state_file "$feature_dir")"

  if [[ -f "$state_file" ]]; then
    return 0
  fi

  printf '{}\n' | write_json_artifact "$state_file"
}

expansion_recovery_already_attempted() {
  local feature_dir="$1"
  local state_file
  state_file="$(expansion_recovery_state_file "$feature_dir")"

  [[ -f "$state_file" ]] || return 1
  jq -e '.attempted == true' "$state_file" >/dev/null 2>&1
}

expansion_recovery_mark_attempted() {
  local feature_dir="$1" issue="$2" reason="$3"
  local state_file
  state_file="$(expansion_recovery_state_file "$feature_dir")"

  ensure_expansion_recovery_state_file "$feature_dir" || return 1
  state_mutate "$state_file" \
    '.attempted = true
     | .issue = $issue
     | .reason = $reason
     | .status = (.status // "pending")
     | .attemptedAt = (.attemptedAt // (now | todateiso8601))
     | .completedAt = (.completedAt // null)
     | .exitCode = (.exitCode // null)
     | .detail = (.detail // "")' \
    --arg issue "$issue" \
    --arg reason "$reason"
}

expansion_recovery_mark_result() {
  local feature_dir="$1" issue="$2" status="$3" detail="${4:-}" exit_code="${5:-}"
  local state_file
  state_file="$(expansion_recovery_state_file "$feature_dir")"

  ensure_expansion_recovery_state_file "$feature_dir" || return 1
  state_mutate "$state_file" \
    '.attempted = true
     | .issue = $issue
     | .status = $status
     | .detail = $detail
     | .completedAt = (now | todateiso8601)
     | .exitCode = (if $exitCode == "" then null else ($exitCode | tonumber) end)' \
    --arg issue "$issue" \
    --arg status "$status" \
    --arg detail "$detail" \
    --arg exitCode "$exit_code"
}

wavemill_command_file_path() {
  local session="$1"
  printf '/tmp/wavemill-%s-commands\n' "$session"
}

wavemill_control_pane_bash() {
  local shell_bin="/opt/homebrew/bin/bash"
  [[ -x "$shell_bin" ]] || shell_bin="bash"
  printf '%s\n' "$shell_bin"
}

# Output the merged wavemill config JSON for a repo dir, applying
# .wavemill-config.local.json (gitignored) on top of .wavemill-config.json.
# Mirrors loadWavemillConfig() in shared/lib/config.ts: objects are recursively
# merged via jq's `*`, arrays are replaced. Use this in shell sites that need to
# see per-developer overrides — currently the integration-window spawn gate.
# Most shell reads of the base file remain direct; migrate when an overlay
# need surfaces for them.
wavemill_load_config() {
  local repo_dir="$1"
  local base="$repo_dir/.wavemill-config.json"
  local lcl="$repo_dir/.wavemill-config.local.json"
  if [[ -f "$base" && -f "$lcl" ]]; then
    jq -s '.[0] * .[1]' "$base" "$lcl" 2>/dev/null || cat "$base" 2>/dev/null || echo '{}'
  elif [[ -f "$base" ]]; then
    cat "$base"
  elif [[ -f "$lcl" ]]; then
    cat "$lcl"
  else
    echo '{}'
  fi
}

wavemill_observer_config_enabled() {
  local merged="${1:-}"
  [[ -n "$merged" ]] || merged="$(wavemill_load_config "${REPO_DIR:-$PWD}")"
  [[ "$(printf '%s' "$merged" | jq -r '.observer.enabled // false' 2>/dev/null || echo false)" == "true" ]]
}

wavemill_observer_interval_seconds() {
  local merged="${1:-}" value
  [[ -n "$merged" ]] || merged="$(wavemill_load_config "${REPO_DIR:-$PWD}")"
  value="$(printf '%s' "$merged" | jq -r '.observer.intervalSeconds // 120' 2>/dev/null || echo 120)"
  [[ "$value" =~ ^[0-9]+$ && "$value" -gt 0 ]] || value=120
  printf '%s\n' "$value"
}

wavemill_observer_heartbeat_stale_seconds() {
  local merged="${1:-}" value
  [[ -n "$merged" ]] || merged="$(wavemill_load_config "${REPO_DIR:-$PWD}")"
  value="$(printf '%s' "$merged" | jq -r '.observer.heartbeatStaleSeconds // 300' 2>/dev/null || echo 300)"
  [[ "$value" =~ ^[0-9]+$ && "$value" -gt 0 ]] || value=300
  printf '%s\n' "$value"
}

wavemill_observer_max_log_lines() {
  local merged="${1:-}" value
  [[ -n "$merged" ]] || merged="$(wavemill_load_config "${REPO_DIR:-$PWD}")"
  value="$(printf '%s' "$merged" | jq -r '.observer.maxLogLines // 240' 2>/dev/null || echo 240)"
  [[ "$value" =~ ^[0-9]+$ && "$value" -gt 0 ]] || value=240
  printf '%s\n' "$value"
}

wavemill_command_offset_path() {
  local session="$1"
  printf '/tmp/wavemill-%s-commands.offset\n' "$session"
}

wavemill_build_control_pane_command() {
  local mode="$1" session="$2" monitor_script="$3" monitor_env="$4" lib_dir="$5"
  local input_reader_script cmd_file offset_file shell_bin setup_cmd command_string

  input_reader_script="$lib_dir/wavemill-input-reader.sh"
  cmd_file="$(wavemill_command_file_path "$session")"
  offset_file="$(wavemill_command_offset_path "$session")"
  shell_bin="$(wavemill_control_pane_bash)"

  case "$mode" in
    startup)
      setup_cmd=": > $(printf '%q' "$cmd_file"); printf '0\\n' > $(printf '%q' "$offset_file"); "
      ;;
    recovery)
      setup_cmd=""
      ;;
    *)
      return 1
      ;;
  esac

  printf -v command_string '%q -lc %q' "$shell_bin" \
    "clear; ${setup_cmd}$(printf '%q %q' "$monitor_script" "$monitor_env") </dev/null & monitor_pid=\$!; trap 'kill \"\$monitor_pid\" >/dev/null 2>&1 || true' EXIT INT TERM; exec env WAVEMILL_SESSION=$(printf '%q' "$session") $(printf '%q %q' "$input_reader_script" "$session")"
  printf '%s\n' "$command_string"
}

# ============================================================================
# TASK PACKET DETECTION
# ============================================================================

# Check if issue description is already a detailed task packet
# Recognizes both old (9-section) and new (header) formats
is_task_packet() {
  local description="$1"
  # Check for common task packet markers (h2 or h3 level)
  # Now also recognizes the new "Quick Reference" header format
  echo "$description" | grep -qE "(##+ (1\\.|Objective)|##+ What|##+ Technical Context|##+ Success Criteria|## Task Packet|Quick Reference|## Detailed Sections)"
}

# ============================================================================
# PRIORITY SCORING ALGORITHM
# ============================================================================

# Calculate priority score for a list of issues (JSON input)
# Returns: identifier|slug|title|area|score
score_and_rank_issues() {
  local backlog_json="$1"
  local show_limit="${2:-9}"
  local focus_milestones_json="${3:-[]}"
  local today="${WAVEMILL_BACKLOG_SCORE_TODAY:-$(date +%F)}"

  printf '%s\n' "$backlog_json" | jq -r \
    --argjson show_limit "$show_limit" \
    --argjson focus_milestones "$focus_milestones_json" \
    --arg today "$today" '
    def epoch_ymd:
      try (strptime("%Y-%m-%d") | mktime) catch null;
    def days_until:
      . as $date
      | ($date | epoch_ymd) as $target
      | ($today | epoch_ymd) as $now
      | if $target == null or $now == null then null else (($target - $now) / 86400 | floor) end;
    def date_urgency($days):
      if $days == null then 0
      elif $days < 0 then 55
      elif $days <= 3 then 45
      elif $days <= 7 then 30
      elif $days <= 14 then 15
      else 0
      end;

    # Filter to backlog/todo only
    map(select((.state.name|ascii_downcase) == "todo" or (.state.name|ascii_downcase) == "backlog"))

    # Enrich each task with scoring factors
    | map(. + {
        # Extract area for conflict detection
        area: (
          (.labels.nodes // [])
          | map(.name)
          | map(select(test("^(Area|Component|Page|Route):")))
          | .[0] // ""
        ),

        # Check if task has detailed description (task packet)
        has_detailed_plan: (
          .description // ""
          | test("##+ (1\\.|Objective|What|Technical Context|Success Criteria|Implementation)")
        ),

        # Check for foundational labels
        is_foundational: (
          (.labels.nodes // [])
          | map(.name | ascii_downcase)
          | any(test("foundational|architecture|epic|infrastructure"))
        ),

        # Count how many issues this blocks (foundational work)
        blocks_count: (
          (.relations.nodes // [])
          | map(select(.type == "blocks" and .relatedIssue.completedAt == null and .relatedIssue.canceledAt == null))
          | length
        ),

        # Count how many incomplete issues block this (dependency risk)
        blocked_by_count: (
          (.inverseRelations.nodes // [])
          | map(select(.type == "blocks" and .issue.completedAt == null and .issue.canceledAt == null))
          | length
        ),

        is_focus_milestone: (
          (.projectMilestone.name // "") as $milestone
          | ((($focus_milestones // []) | length) > 0 and (($focus_milestones // []) | index($milestone)) != null)
        ),

        milestone_days_until: (.projectMilestone.targetDate // null | days_until),
        due_days_until: (.dueDate // null | days_until)
      })

    | map(. + {
        milestone_urgency: (
          if .is_focus_milestone then 80
          else date_urgency(.milestone_days_until)
          end
        ),
        due_urgency: date_urgency(.due_days_until)
      })

    | map(. + {
        # Prefer work on earlier dated milestones when score is otherwise close.
        milestone_sort_date: (.projectMilestone.targetDate // "9999-12-31"),
        due_sort_date: (.dueDate // "9999-12-31")
      })

    # Calculate composite priority score (higher = higher priority)
    | map(. + {
        score: (
          # Base: Baseline for all items (prevents negative scores)
          20

          # Linear priority (1=urgent, 0=none, 4=low)
          + (if .priority > 0 then (5 - .priority) * 20 else 0 end)

          # Boost: Has detailed task packet (+30 points)
          + (if .has_detailed_plan then 30 else 0 end)

          # Boost: Foundational/architecture work (+25 points)
          + (if .is_foundational then 25 else 0 end)

          # Boost: Blocks other work (+10 per blocked issue)
          + (.blocks_count * 10)

          # Boost: Unblocked work is ready to go (+15 points)
          + (if .blocked_by_count == 0 then 15 else 0 end)

          # Boost: User-configured focus milestones, near milestone targets, and due dates
          + .milestone_urgency
          + .due_urgency

          # Penalty: Blocked by other work (-20 per blocker, harder penalty)
          - (.blocked_by_count * 20)

          # Penalty: Large estimates (prefer smaller, deliverable work)
          - ((.estimate // 3) * 2)
        )
      })

    # Sort by score descending (higher score = higher priority)
    | sort_by(-.score, .milestone_sort_date, .due_sort_date, .identifier)

    # Take top candidates for display
    | .[0:$show_limit]
    | .[]
    | "\(.identifier)|\(.title|ascii_downcase|gsub("[^a-z0-9]+";"-"))|\(.title)|\(.area)|\(.score)|\(.has_detailed_plan)|\(.blocked_by_count)"
  '
}

# Fields mill startup reads from issue.json. Keep this aligned with the
# startup consumers before broadening backlog-payload reuse.
# Note: labels.nodes is also required (checked separately in jq filter below)
_WAVEMILL_REQUIRED_ISSUE_FIELDS=(identifier title description)

# issue_payload_is_complete <json>
# Exit 0 when startup can safely reuse the backlog payload as issue.json.
# Accepts JSON as $1 or on stdin.
issue_payload_is_complete() {
  local json="${1:-}"
  if [[ -z "$json" ]]; then
    json=$(cat)
  fi

  local field_filter field
  field_filter='['
  for field in "${_WAVEMILL_REQUIRED_ISSUE_FIELDS[@]}"; do
    field_filter+="\"$field\","
  done
  field_filter="${field_filter%,}]"

  local ok
  ok=$(printf '%s' "$json" | jq -e --argjson required_fields "$field_filter" '
    . as $record |
    ($required_fields | all(. as $field | (($record[$field] // "") != "")))
    and ((.labels.nodes | type) == "array")
  ' 2>/dev/null) || return 1

  [[ "$ok" == "true" ]]
}

# ============================================================================
# PARENT ISSUE FILTERING (HOK-2867)
# ============================================================================

# Filter parent issues from the backlog JSON.
# Parents are identified by having children.nodes with at least one entry.
# Args: $1 = backlog_json, $2 = optional log_dest (file descriptor for skip warnings)
# Output: Filtered JSON (parents removed), one warning per skipped parent to stderr/log
filter_parent_issues() {
  local backlog_json="$1"
  local log_dest="${2:-/dev/stderr}"

  # Emit warnings for skipped parents first, then output filtered JSON
  {
    printf '%s\n' "$backlog_json" | jq -r '
      .[]
      | select((.children.nodes // []) | length > 0)
      | "\(.identifier)|\(([.children.nodes[].identifier] | join(",")))"
    '
  } 2>/dev/null | while IFS='|' read -r parent_id child_ids; do
    printf 'WARN: Skipping parent issue %s (has Linear children: %s)\n' "$parent_id" "$child_ids" >&"$log_dest"
  done

  # Output filtered JSON (remove parents)
  printf '%s\n' "$backlog_json" | jq '[ .[] | select((.children.nodes // []) | length == 0) ]'
}

# ============================================================================
# ISSUE EXPANSION
# ============================================================================

# Expand issue with expand-issue.ts if available
# Args: issue_id, output_file, [--no-update to skip Linear update]
# Note: Linear is always updated by default. Pass --no-update to opt out.
expand_issue_with_tool() {
  local issue_id="$1"
  local out_file="$2"
  local no_update_flag="${3:-}"
  local tools_dir="${TOOLS_DIR:?TOOLS_DIR must be set}"

  if [[ ! -f "$tools_dir/expand-issue.ts" ]]; then
    return 1
  fi

  # Build command — Linear update is the default, --no-update opts out
  local cmd_args=("$tools_dir/expand-issue.ts" "$issue_id" "--output" "$out_file")
  if [[ "$no_update_flag" == "--no-update" ]]; then
    cmd_args+=("--no-update")
  fi

  # Run with real-time output using process substitution
  local log_file="/tmp/expand-issue-${issue_id}.log"

  # Show command being run
  echo "  Running: npx tsx expand-issue.ts $issue_id --output ... ${no_update_flag}" >&2

  # Use tee to show output in real-time AND capture to log file
  if npx tsx "${cmd_args[@]}" 2>&1 | tee "$log_file"; then
    return 0
  else
    # Print error summary
    echo "" >&2
    echo "Error expanding issue $issue_id (exit code: $?)" >&2
    echo "Full log saved to: $log_file" >&2
    return 1
  fi
}

# For backwards compatibility with wavemill-mill.sh
# Fetches current description and checks if expansion is needed
# If needed, calls expand_issue_with_tool
write_task_packet() {
  local issue_id="$1"
  local out_file="$2"
  local tools_dir="${TOOLS_DIR:?TOOLS_DIR must be set}"

  # Fetch current description (strip dotenv stdout noise before parsing JSON)
  local issue_json=$(npx tsx "$tools_dir/get-issue.ts" "$issue_id" --json 2>/dev/null | sed '/^\[dotenv/d' || echo "{}")
  local current_desc=$(echo "$issue_json" | jq -r '.description // ""')

  # Check if already a task packet
  if is_task_packet "$current_desc"; then
    # For existing task packets, write to main file
    echo "$current_desc" > "$out_file"
    return 0
  fi

  # Try to expand (Linear update is now the default)
  # This will create three files:
  #   - $out_file (full content for Linear)
  #   - ${out_file%.md}-header.md (brief header)
  #   - ${out_file%.md}-details.md (detailed sections)
  if expand_issue_with_tool "$issue_id" "$out_file"; then
    # Move header to main file for loading by mill
    local header_file="${out_file%.md}-header.md"
    if [[ -f "$header_file" ]]; then
      mv "$header_file" "$out_file"
      # Details file stays as ${out_file%.md}-details.md for on-demand access
    fi
    return 0
  else
    # Fallback: just use the raw description
    echo "$current_desc" > "$out_file"
    return 1
  fi
}

# ============================================================================
# CLAUDE TRUST PRE-SEEDING
# ============================================================================

# Pre-trust a directory in Claude Code's config so it doesn't prompt on launch.
# Each worktree path is treated as a separate "project" by Claude, triggering a
# trust dialog on first use. This function sets hasTrustDialogAccepted=true
# and hasCompletedProjectOnboarding=true before the agent starts.
#
# Args: $1 = directory path to trust
pretrust_directory() {
  local dir_path="$1"
  local claude_json="$HOME/.claude.json"

  # Only relevant for claude agent
  [[ "${AGENT_CMD:-claude}" != "claude" ]] && return 0
  [[ ! -f "$claude_json" ]] && return 0

  # Check if already trusted
  local already_trusted
  already_trusted=$(jq -r --arg p "$dir_path" '.projects[$p].hasTrustDialogAccepted // false' "$claude_json" 2>/dev/null)
  [[ "$already_trusted" == "true" ]] && return 0

  # Set trust fields
  local tmp
  tmp=$(mktemp)
  if jq --arg p "$dir_path" '
    .projects[$p] = (.projects[$p] // {}) |
    .projects[$p].hasTrustDialogAccepted = true |
    .projects[$p].hasCompletedProjectOnboarding = true
  ' "$claude_json" > "$tmp" 2>/dev/null; then
    mv "$tmp" "$claude_json"
  else
    rm -f "$tmp"
  fi
}

# ============================================================================
# TASK PHASE MANAGEMENT
# ============================================================================

# Update the phase field on a task in the state file.
# Args: $1 = state_file, $2 = issue_id, $3 = phase (planning|executing|pr-review|merged)
set_task_phase() {
  local state_file="$1" issue="$2" phase="$3"
  state_mutate "$state_file" \
    '.tasks[$issue].phase = $phase | .tasks[$issue].updated = (now | todate)' \
    --arg issue "$issue" --arg phase "$phase"
}

# Canonical task-phase reader (HOK-2903). Before canonicalization the parent
# mill and the extracted monitor each carried a private copy: the parent's raw
# `jq -r ... 2>/dev/null` silently returned an empty string when $STATE_FILE
# was missing, unreadable, or malformed — making downstream comparisons like
# [[ "$phase" == "planning" ]] read as "some other phase" instead of "state is
# gone" — while the monitor wrapped the read in read_state_value so every
# failure mode fell back to "executing". The monitor was the only scope with
# live callers, so its semantics are canonical:
#   - $STATE_FILE missing, zero-byte, or unreadable  -> "executing"
#   - jq parse error                                 -> "executing"
#   - task absent, or task present without a .phase  -> "executing"
#   - otherwise                                      -> .tasks[$issue].phase
# The read_state_value guard is inlined here (rather than moving that helper
# out of the monitor, which has 74 other callers) so this stays self-contained
# while remaining byte-equivalent to the monitor's pre-change behavior.
get_task_phase() {
  local issue="$1"
  local value
  if [[ ! -r "$STATE_FILE" || ! -s "$STATE_FILE" ]]; then
    printf 'executing\n'
    return 0
  fi
  if value=$(jq -r --arg issue "$issue" \
      '.tasks[$issue].phase // "executing"' "$STATE_FILE" 2>/dev/null); then
    printf '%s\n' "$value"
  else
    printf 'executing\n'
  fi
}

# ============================================================================
# Hook Configuration
# ============================================================================

# Log a hook warning once per session to avoid repeated noise for the same
# broken installation state across planning/coding/review launches.
warn_once_per_session() {
  local warning_key="$1" message="$2"
  local session="${SESSION:-}"
  local warning_file

  if [[ -z "$session" ]]; then
    log "warn" "$message"
    return 0
  fi

  warning_file="/tmp/wavemill-${session}-hook-warnings.txt"
  if [[ -f "$warning_file" ]] && grep -qxF "$warning_key" "$warning_file" 2>/dev/null; then
    return 0
  fi

  log "warn" "$message"
  printf '%s\n' "$warning_key" >> "$warning_file" 2>/dev/null || true
}

normalize_worktree_path() {
  local path="$1"
  local parent_dir base_name

  if [[ -d "$path" ]]; then
    (cd "$path" && pwd -P)
    return 0
  fi

  parent_dir="$(dirname "$path")"
  base_name="$(basename "$path")"
  if [[ -d "$parent_dir" ]]; then
    printf '%s/%s\n' "$(cd "$parent_dir" && pwd -P)" "$base_name"
    return 0
  fi

  printf '%s\n' "$path"
}

ensure_worktree() {
  local branch="$1"
  local desired_path="$2"
  local repo_dir="${3:-$PWD}"
  local worktree_list="" existing_path="" line="" current_path=""
  local hook_script agent_name
  local desired_cmp_path existing_cmp_path

  if ! worktree_list="$(git -C "$repo_dir" worktree list --porcelain 2>/dev/null)"; then
    echo "Error: failed to inspect git worktree registrations for $branch" >&2
    if [[ -n "${WAVEMILL_SESSION:-}" && -n "${WAVEMILL_ISSUE:-}" ]] && command -v jq >/dev/null 2>&1; then
      hook_script="$(cd "$(dirname "${BASH_SOURCE[0]}")/../hooks" && pwd)/wavemill-hook-protocol.sh"
      if ! declare -F wavemill_hook_write >/dev/null 2>&1 && [[ -f "$hook_script" ]]; then
        # shellcheck source=/dev/null
        source "$hook_script"
      fi
      if declare -F wavemill_hook_write >/dev/null 2>&1; then
        agent_name="${AGENT_CMD:-${CURRENT_AGENT:-wavemill}}"
        wavemill_hook_write "error" "worktree-setup" "worktree-collision" "$agent_name" || true
      fi
    fi
    return 1
  fi

  while IFS= read -r line || [[ -n "$line" ]]; do
    case "$line" in
      worktree\ *)
        current_path="${line#worktree }"
        ;;
      branch\ refs/heads/*)
        if [[ "${line#branch refs/heads/}" == "$branch" ]]; then
          existing_path="$current_path"
          break
        fi
        ;;
      "")
        current_path=""
        ;;
    esac
  done <<< "$worktree_list"

  desired_cmp_path="$(normalize_worktree_path "$desired_path")"

  if [[ -z "$existing_path" ]]; then
    git -C "$repo_dir" worktree add "$desired_path" "$branch" >/dev/null || return 1
    printf '%s\n' "$desired_path"
    return 0
  fi

  existing_cmp_path="$(normalize_worktree_path "$existing_path")"

  if [[ "$existing_cmp_path" == "$desired_cmp_path" ]]; then
    if [[ -d "$existing_path" ]]; then
      printf '%s\n' "$desired_path"
      return 0
    fi
    echo "Detected stale worktree registration for $branch at $desired_path; pruning" >&2
  else
    if [[ -d "$existing_path" ]]; then
      echo "Reusing existing worktree for $branch at $existing_path" >&2
      printf '%s\n' "$existing_path"
      return 0
    fi
    echo "Detected stale worktree registration for $branch at $existing_path; recreating at $desired_path" >&2
  fi

  if ! git -C "$repo_dir" worktree prune >/dev/null; then
    echo "Error: failed to prune stale worktree registration for $branch" >&2
  elif git -C "$repo_dir" worktree add "$desired_path" "$branch" >/dev/null; then
    printf '%s\n' "$desired_path"
    return 0
  fi

  echo "Error: failed to prepare worktree for $branch" >&2
  if [[ -n "${WAVEMILL_SESSION:-}" && -n "${WAVEMILL_ISSUE:-}" ]] && command -v jq >/dev/null 2>&1; then
    hook_script="$(cd "$(dirname "${BASH_SOURCE[0]}")/../hooks" && pwd)/wavemill-hook-protocol.sh"
    if ! declare -F wavemill_hook_write >/dev/null 2>&1 && [[ -f "$hook_script" ]]; then
      # shellcheck source=/dev/null
      source "$hook_script"
    fi
    if declare -F wavemill_hook_write >/dev/null 2>&1; then
      agent_name="${AGENT_CMD:-${CURRENT_AGENT:-wavemill}}"
      wavemill_hook_write "error" "worktree-setup" "worktree-collision" "$agent_name" || true
    fi
  fi
  return 1
}

wavemill_lock_run() {
  local lock_name="$1"
  shift

  local session="${SESSION:-global}"
  local lock_root="/tmp/wavemill-${session}-locks"
  mkdir -p "$lock_root"

  if command -v flock >/dev/null 2>&1; then
    local lock_file="$lock_root/${lock_name}"
    touch "$lock_file"
    { flock -x 9; "$@"; } 9>"$lock_file"
    return
  fi

  local lock_dir="$lock_root/${lock_name}.lk"
  local attempts=0
  local max_retries="${WAVEMILL_LOCK_MAX_RETRIES:-300}"
  local sleep_seconds="${WAVEMILL_LOCK_SLEEP_SECONDS:-0.1}"
  local stale_seconds="${WAVEMILL_LOCK_STALE_SECONDS:-120}"
  local observed_owner current_owner
  while true; do
    while ! mkdir "$lock_dir" 2>/dev/null; do
      observed_owner="$(cat "$lock_dir/owner.pid" 2>/dev/null || true)"
      if wavemill_lock_dir_is_stale "$lock_dir" "$stale_seconds"; then
        current_owner="$(cat "$lock_dir/owner.pid" 2>/dev/null || true)"
        if [[ -n "$observed_owner" && "$current_owner" == "$observed_owner" ]]; then
          rm -f "$lock_dir/owner.pid" "$lock_dir/owner.command" 2>/dev/null || true
          rmdir "$lock_dir" 2>/dev/null || true
          continue
        fi
      fi
      attempts=$((attempts + 1))
      if (( attempts >= max_retries )); then
        if declare -F startup_log >/dev/null 2>&1; then
          startup_log "Warning: wavemill_lock_run timeout on $lock_name; aborting locked operation"
        fi
        return 1
      fi
      sleep "$sleep_seconds"
    done

    # If another process removed the lock directory before owner metadata could
    # be written, retry instead of running the critical section unlocked.
    if printf '%s\n' "${BASHPID:-$$}" > "$lock_dir/owner.pid" 2>/dev/null \
      && printf '%s\n' "$*" > "$lock_dir/owner.command" 2>/dev/null; then
      break
    fi

    rm -f "$lock_dir/owner.pid" "$lock_dir/owner.command" 2>/dev/null || true
    rmdir "$lock_dir" 2>/dev/null || true
    sleep "$sleep_seconds"
  done

  "$@"
  local rc=$?
  rm -f "$lock_dir/owner.pid" "$lock_dir/owner.command" 2>/dev/null || true
  rmdir "$lock_dir" 2>/dev/null || true
  return "$rc"
}

wavemill_lock_dir_mtime_epoch() {
  local path="$1"
  stat -c %Y "$path" 2>/dev/null || stat -f %m "$path" 2>/dev/null || echo 0
}

wavemill_lock_dir_is_stale() {
  local lock_dir="$1" stale_seconds="$2"
  local owner_pid mtime now

  if [[ ! -f "$lock_dir/owner.pid" ]]; then
    # Treat owner-less directories as still in-flight so waiters do not delete
    # a lock that another process is still acquiring or releasing.
    return 1
  fi

  owner_pid="$(cat "$lock_dir/owner.pid" 2>/dev/null || true)"
  if [[ "$owner_pid" =~ ^[0-9]+$ ]]; then
    kill -0 "$owner_pid" 2>/dev/null && return 1
    return 0
  fi

  [[ "$stale_seconds" =~ ^[0-9]+$ ]] || stale_seconds=120
  (( stale_seconds <= 0 )) && return 0
  mtime="$(wavemill_lock_dir_mtime_epoch "$lock_dir")"
  now="$(date +%s)"
  [[ "$mtime" =~ ^[0-9]+$ && "$now" =~ ^[0-9]+$ ]] || return 1
  (( now - mtime >= stale_seconds ))
}

# Configure agent hooks for status tracking in a worktree-specific settings file.
# This writes to .claude/settings.local.json (gitignored) so hooks only affect
# wavemill-launched agents, not standalone Claude usage.
#
# Args: $1 = agent_cmd (claude|codex), $2 = worktree_dir
configure_agent_hooks() {
  local agent_cmd="$1" worktree_dir="$2"
  local tools_dir="${TOOLS_DIR:-}"
  local wavemill_root="${tools_dir%/tools}"
  local hooks_dir="$wavemill_root/shared/hooks"
  local claude_hook="$hooks_dir/claude-status-hook.sh"
  local tmp config_file

  # Gracefully skip if jq is unavailable or worktree is invalid
  command -v jq >/dev/null 2>&1 || return 0
  [[ -n "$worktree_dir" && -d "$worktree_dir" ]] || return 0

  case "$agent_cmd" in
    claude)
      # Claude hooks are part of the wavemill installation, so every repo uses
      # the same canonical adapter.
      if [[ ! -x "$claude_hook" ]]; then
        warn_once_per_session \
          "claude-hook-unavailable:$claude_hook" \
          "  Hook status unavailable (missing wavemill hook $claude_hook)"
        return 0
      fi

      # Create .claude directory if needed
      mkdir -p "$worktree_dir/.claude"
      config_file="$worktree_dir/.claude/settings.local.json"

      # Initialize or validate existing config
      if [[ ! -f "$config_file" ]]; then
        printf '{}\n' > "$config_file"
      elif ! jq empty "$config_file" >/dev/null 2>&1; then
        log "warn" "  Invalid JSON in $config_file, resetting local hook config"
        printf '{}\n' > "$config_file"
      fi

      # Merge hook configuration using jq (atomic via tmp + mv)
      # WAVEMILL_DASHBOARD_PID is available via tmux session environment
      tmp=$(mktemp) || {
        log "warn" "  Failed to allocate temp file for Claude hook config"
        return 0
      }

      if jq \
        --arg hook_cmd "$claude_hook" \
        '
        . as $base |
        ($base.hooks // {}) as $hooks |
        $base + {
          hooks: ($hooks + {
            UserPromptSubmit: (($hooks.UserPromptSubmit // []) + [{hooks: [{type: "command", command: $hook_cmd}]}] | unique_by(.hooks[0].command)),
            PreToolUse: (($hooks.PreToolUse // []) + [{hooks: [{type: "command", command: $hook_cmd}]}] | unique_by(.hooks[0].command)),
            Stop: (($hooks.Stop // []) + [{hooks: [{type: "command", command: $hook_cmd}]}] | unique_by(.hooks[0].command)),
            StopFailure: (($hooks.StopFailure // []) + [{hooks: [{type: "command", command: $hook_cmd}]}] | unique_by(.hooks[0].command)),
            Notification: (($hooks.Notification // []) + [{hooks: [{type: "command", command: $hook_cmd}]}] | unique_by(.hooks[0].command))
          })
        }
        ' "$config_file" > "$tmp" 2>/dev/null; then
        mv "$tmp" "$config_file"
        log "debug" "  Configured Claude hook status in $config_file"
      else
        rm -f "$tmp"
        log "warn" "  Failed to write Claude hook config at $config_file"
      fi
      ;;

    codex)
      # Codex autonomous launches report completion from their wrapper; while
      # running, the dashboard falls back to pane/process liveness.
      log "debug" "  Codex status tracking via launcher exit hook"
      ;;

    *)
      # Generic agents use process monitoring - no config needed
      log "debug" "  Generic agent status tracking via process monitor"
      ;;
  esac
}

# Mutate a JSON state file under a portable POSIX lock.
# Usage: state_mutate <state_path> <jq_filter> [jq_args...]
state_mutate() {
  local state_path="$1" jq_filter="$2"
  shift 2

  local lock_dir="${state_path}.lock"
  local tmp_file="${state_path}.tmp.$$.$RANDOM"
  local err_file="/tmp/wavemill-state-mutate-$$.$RANDOM.err"
  local max_retries="${STATE_MUTATE_MAX_RETRIES:-50}"
  local sleep_seconds="${STATE_MUTATE_SLEEP_SECONDS:-0.1}"
  local retry=0

  if [[ ! -f "$state_path" ]]; then
    echo "state_mutate: state file not found: $state_path" >&2
    return 1
  fi

  while ! mkdir "$lock_dir" 2>/dev/null; do
    retry=$((retry + 1))
    if (( retry >= max_retries )); then
      echo "state_mutate: lock timeout on $state_path after $max_retries retries" >&2
      return 1
    fi
    sleep "$sleep_seconds"
  done

  local mutate_status=0
  if jq "$@" "$jq_filter" "$state_path" > "$tmp_file" 2>"$err_file"; then
    mv "$tmp_file" "$state_path" || mutate_status=$?
  else
    mutate_status=$?
    cat "$err_file" >&2
  fi

  rm -f "$tmp_file" "$err_file"
  if ! rmdir "$lock_dir" 2>/dev/null && (( mutate_status == 0 )); then
    echo "state_mutate: failed to release lock: $lock_dir" >&2
    return 1
  fi

  return "$mutate_status"
}

# ============================================================================
# TASK STATE LEDGER
# ============================================================================

task_lifecycle_jq_defs() {
  cat <<'JQ'
def wm_terminal_status:
  (.status // "") as $status
  | (.phase // "") as $phase
  | (["merged","complete","completed","completed-external","closed","done","aborted"] | index($status)) != null
    or $status == "error"
    or ($phase | IN("done","closed","aborted","error"));

def wm_workflow_outcome:
  (.status // "") as $status
  | (.phase // "") as $phase
  | if $status == "merged" or $phase == "done" then "merged"
    elif ($status | IN("closed","complete","completed","completed-external","done")) or $phase == "closed" then "closed"
    elif $status == "aborted" or $phase == "aborted" then "aborted"
    elif $status == "error" or $phase == "error" then "error"
    else "active"
    end;

def wm_resource_disposition:
  (.lifecycle.resourceDisposition // "") as $disposition
  | if $disposition | IN("allocated","released","retained","reaping","reaped","verification-required") then $disposition
    elif ((.executionOwner // "task") == "queue" and (.paneState // "active") == "released") or (.paneState // "") == "released" then "released"
    elif wm_terminal_status then "verification-required"
    else "allocated"
    end;

def wm_retention_required:
  (wm_workflow_outcome != "active") and (wm_resource_disposition | IN("allocated","retained","verification-required"));

def wm_has_retention:
  ((.lifecycle.retention.reason // "") | type == "string" and length > 0);

def wm_normalized_lifecycle($baseBranch; $baseSha; $integrationMode; $mergeMethod; $remoteDeletionAllowed; $challengeRole; $challengePair; $session; $runEpoch; $windowId; $actor):
  . as $task
  | ($task.lifecycle // {}) as $l
  | ($task | wm_workflow_outcome) as $outcome
  | ($task | wm_resource_disposition) as $disposition
  | ($l.launchContract // {
      baseBranch: $baseBranch,
      baseSha: $baseSha,
      integrationMode: $integrationMode,
      mergeMethod: $mergeMethod,
      remoteBranchDeletionPolicy: {
        allowed: ($remoteDeletionAllowed == "true"),
        mode: (if $remoteDeletionAllowed == "true" then "merged-pr-task-branch" else "manual-verification" end),
        source: "cleanup_remote_task_branch"
      },
      challengeRole: $challengeRole,
      challengePairId: $challengePair,
      session: $session,
      runEpoch: $runEpoch,
      windowId: $windowId
    }) as $contract
  | ($l.deliveryEvidence // {}) as $delivery
  | ($l + {
      schemaVersion: 1,
      workflowOutcome: $outcome,
      resourceDisposition: $disposition,
      launchContract: $contract,
      deliveryEvidence: $delivery
    })
  | if $task | wm_retention_required and ($task | wm_has_retention | not) then
      .resourceDisposition = "verification-required"
      | .retention = {
          reason: "verification-required",
          policy: "manual-verification-required",
          actor: $actor,
          timestamp: (now | todateiso8601),
          evidence: {
            status: ($task.status // null),
            phase: ($task.phase // null),
            paneState: ($task.paneState // null),
            executionOwner: ($task.executionOwner // null)
          }
        }
      | .verificationRequiredReason = "terminal-resource-retention-unexplained"
    else .
    end;

def wm_slot_consumes:
  (wm_resource_disposition | IN("allocated","reaping"));
JQ
}

task_lifecycle_jq_filter() {
  local body="$1"
  printf '%s\n%s\n' "$(task_lifecycle_jq_defs)" "$body"
}

task_lifecycle_effective_base_sha() {
  local base_branch="${1:-${BASE_BRANCH:-}}"
  local ref=""
  [[ -n "${RESOLVED_BASE_SHA:-}" ]] && { printf '%s\n' "$RESOLVED_BASE_SHA"; return 0; }
  [[ -n "${WAVEMILL_RESOLVED_BASE_SHA:-}" ]] && { printf '%s\n' "$WAVEMILL_RESOLVED_BASE_SHA"; return 0; }
  [[ -n "${RESOLVED_BASE_REF:-}" ]] && ref="$RESOLVED_BASE_REF"
  [[ -z "$ref" && -n "$base_branch" ]] && ref="origin/$base_branch"
  [[ -n "$ref" && -n "${REPO_DIR:-}" ]] || return 0
  git -C "$REPO_DIR" rev-parse --verify "${ref}^{commit}" 2>/dev/null || true
}

set_task_lifecycle_disposition() {
  local issue="$1" workflow_outcome="${2:-}" resource_disposition="${3:-}" reason="${4:-}" actor="${5:-wavemill}"
  [[ -n "$issue" && -n "$resource_disposition" ]] || return 1
  [[ -n "${STATE_FILE:-}" && -f "$STATE_FILE" ]] || return 1
  state_mutate "$STATE_FILE" '
    (.tasks[$issue] // {}) as $existing
    | ($existing.lifecycle // {}) as $l
    | .tasks[$issue].lifecycle = ($l + {
        schemaVersion: 1,
        workflowOutcome: (if $workflowOutcome != "" then $workflowOutcome else ($l.workflowOutcome // "active") end),
        resourceDisposition: $resourceDisposition
      })
    | if $reason != "" then
        .tasks[$issue].lifecycle.retention = {
          reason: $reason,
          policy: "manual-verification-required",
          actor: $actor,
          timestamp: (now | todateiso8601)
        }
      else .
      end
    | .tasks[$issue].updated = (now | todateiso8601)' \
    --arg issue "$issue" \
    --arg workflowOutcome "$workflow_outcome" \
    --arg resourceDisposition "$resource_disposition" \
    --arg reason "$reason" \
    --arg actor "$actor"
}

get_task_resource_disposition() {
  local issue="$1"
  [[ -n "${STATE_FILE:-}" && -f "$STATE_FILE" ]] || { printf 'allocated\n'; return 0; }
  jq -r --arg issue "$issue" "$(task_lifecycle_jq_filter '(.tasks[$issue] // {}) | wm_resource_disposition')" "$STATE_FILE" 2>/dev/null || printf 'allocated\n'
}

task_consumes_mill_slot() {
  local issue="$1"
  [[ -n "${STATE_FILE:-}" && -f "$STATE_FILE" ]] || return 1
  jq -e --arg issue "$issue" "$(task_lifecycle_jq_filter '(.tasks[$issue] // {}) | wm_slot_consumes')" "$STATE_FILE" >/dev/null 2>&1
}

slot_consuming_task_count() {
  [[ -n "${STATE_FILE:-}" && -f "$STATE_FILE" ]] || { printf '0\n'; return 0; }
  jq -r "$(task_lifecycle_jq_filter '(.tasks // {}) | to_entries | map(select(.value | wm_slot_consumes)) | length')" "$STATE_FILE" 2>/dev/null || printf '0\n'
}

slot_consuming_challenger_task_count() {
  [[ -n "${STATE_FILE:-}" && -f "$STATE_FILE" ]] || { printf '0\n'; return 0; }
  jq -r "$(task_lifecycle_jq_filter '(.tasks // {}) | to_entries | map(select((.value.challengeRole // "") == "challenger") | select(.value | wm_slot_consumes)) | length')" "$STATE_FILE" 2>/dev/null || printf '0\n'
}

get_task_execution_owner() {
  local issue="$1" owner=""
  if [[ -n "${STATE_FILE:-}" && -f "$STATE_FILE" ]]; then
    owner="$(jq -r --arg issue "$issue" '.tasks[$issue].executionOwner // "task"' "$STATE_FILE" 2>/dev/null || echo "task")"
  fi
  case "$owner" in
    task|queue|reconciliation) printf '%s\n' "$owner" ;;
    *) printf '%s\n' "task" ;;
  esac
}

get_task_pane_state() {
  local issue="$1" pane_state=""
  if [[ -n "${STATE_FILE:-}" && -f "$STATE_FILE" ]]; then
    pane_state="$(jq -r --arg issue "$issue" '.tasks[$issue].paneState // "active"' "$STATE_FILE" 2>/dev/null || echo "active")"
  fi
  case "$pane_state" in
    active|released|rehydrating) printf '%s\n' "$pane_state" ;;
    *) printf '%s\n' "active" ;;
  esac
}

set_task_queue_owned() {
  local issue="$1" capsule_digest="${2:-}" handoff_at="${3:-}"
  [[ -n "$handoff_at" ]] || handoff_at="$(date +%s)"
  [[ -n "${STATE_FILE:-}" && -f "$STATE_FILE" ]] || return 1
  state_mutate "$STATE_FILE" \
    '(.tasks[$issue] // {}) as $existing
     | .tasks[$issue] = ($existing + {
         executionOwner: "queue",
         paneState: "released",
         queueHandoffAt: ($handoffAt | tonumber),
         capsuleDigest: $capsuleDigest,
         updated: (now | todate)
       })
     | .tasks[$issue].lifecycle = ((.tasks[$issue].lifecycle // {}) + {
         schemaVersion: 1,
         workflowOutcome: (.tasks[$issue].lifecycle.workflowOutcome // "active"),
         resourceDisposition: "released"
       })' \
    --arg issue "$issue" \
    --arg capsuleDigest "$capsule_digest" \
    --arg handoffAt "$handoff_at"
}

set_task_reconciliation_owned() {
  local issue="$1"
  [[ -n "${STATE_FILE:-}" && -f "$STATE_FILE" ]] || return 1
  state_mutate "$STATE_FILE" \
    '(.tasks[$issue] // {}) as $existing
     | .tasks[$issue] = ($existing + {
         executionOwner: "reconciliation",
         paneState: "rehydrating",
         updated: (now | todate)
       })
     | .tasks[$issue].lifecycle = ((.tasks[$issue].lifecycle // {}) + {
         schemaVersion: 1,
         workflowOutcome: (.tasks[$issue].lifecycle.workflowOutcome // "active"),
         resourceDisposition: "allocated"
       })' \
    --arg issue "$issue"
}

set_task_task_owned() {
  local issue="$1" pane_state="${2:-active}"
  [[ "$pane_state" == "active" || "$pane_state" == "rehydrating" || "$pane_state" == "released" ]] || pane_state="active"
  [[ -n "${STATE_FILE:-}" && -f "$STATE_FILE" ]] || return 1
  state_mutate "$STATE_FILE" \
    '(.tasks[$issue] // {}) as $existing
     | .tasks[$issue] = ($existing + {
         executionOwner: "task",
         paneState: $paneState,
         updated: (now | todate)
       })
     | .tasks[$issue].lifecycle = ((.tasks[$issue].lifecycle // {}) + {
         schemaVersion: 1,
         workflowOutcome: (.tasks[$issue].lifecycle.workflowOutcome // "active"),
         resourceDisposition: (if $paneState == "released" then "released" else "allocated" end)
       })' \
    --arg issue "$issue" \
    --arg paneState "$pane_state"
}

task_worktree_release_safety() {
  local wt_dir="${1:-}" task_branch="${2:-}" base_branch="${3:-${BASE_BRANCH:-main}}"
  local dirty_status="" commits_ahead=""

  if [[ -z "$wt_dir" || ! -d "$wt_dir" ]]; then
    printf '%s\n' "git-error"
    return 1
  fi
  if [[ -z "$task_branch" ]]; then
    task_branch="$(git -C "$wt_dir" branch --show-current 2>/dev/null || true)"
  fi
  if [[ -z "$task_branch" ]]; then
    printf '%s\n' "git-error"
    return 1
  fi
  if ! dirty_status="$(git -C "$wt_dir" status --porcelain --untracked-files=all 2>/dev/null)"; then
    printf '%s\n' "git-error"
    return 1
  fi
  if [[ -n "$dirty_status" ]]; then
    printf '%s\n' "dirty-worktree"
    return 1
  fi
  if ! git -C "$wt_dir" rev-parse --verify --quiet "origin/${task_branch}^{commit}" >/dev/null 2>&1; then
    printf '%s\n' "no-remote-branch"
    return 1
  fi
  if ! commits_ahead="$(git -C "$wt_dir" rev-list --count "origin/${task_branch}..${task_branch}" 2>/dev/null)" \
    || [[ ! "$commits_ahead" =~ ^[0-9]+$ ]]; then
    printf '%s\n' "git-error"
    return 1
  fi
  if (( commits_ahead > 0 )); then
    printf '%s\n' "unpushed-commits"
    return 1
  fi
  printf '%s\n' "ok"
  return 0
}

reconciliation_lease_dir() {
  local state_dir="$1"
  printf '%s\n' "$state_dir/.reconciliation-lease"
}

reconciliation_lease_info() {
  local state_dir="$1" lease_file
  lease_file="$(reconciliation_lease_dir "$state_dir")/lease.json"
  [[ -f "$lease_file" ]] || return 1
  cat "$lease_file"
}

reconciliation_lease_release() {
  local state_dir="$1" lease_dir
  lease_dir="$(reconciliation_lease_dir "$state_dir")"
  rm -f "$lease_dir/lease.json" 2>/dev/null || true
  rmdir "$lease_dir" 2>/dev/null || true
}

reconciliation_lease_held() {
  local state_dir="$1" lease_dir lease_pid
  lease_dir="$(reconciliation_lease_dir "$state_dir")"
  [[ -d "$lease_dir" ]] || return 1
  lease_pid="$(jq -r '.pid // empty' "$lease_dir/lease.json" 2>/dev/null || true)"
  if [[ "$lease_pid" =~ ^[0-9]+$ ]] && ! kill -0 "$lease_pid" 2>/dev/null; then
    local task_state issue slug wt_dir pane_state target
    task_state=""
    if [[ -n "${STATE_FILE:-}" && -f "$STATE_FILE" ]]; then
      task_state="$(jq -c --arg state_dir "$state_dir" '
        (.tasks // {}) | to_entries[]
        | select((.value.worktree + "/features/" + .value.slug) == $state_dir)
        | {issue:.key, slug:.value.slug, worktree:.value.worktree, paneState:(.value.paneState // "active")}
      ' "$STATE_FILE" 2>/dev/null | head -n 1 || true)"
    fi
    issue="$(jq -r '.issue // empty' <<< "$task_state" 2>/dev/null || true)"
    slug="$(jq -r '.slug // empty' <<< "$task_state" 2>/dev/null || true)"
    wt_dir="$(jq -r '.worktree // empty' <<< "$task_state" 2>/dev/null || true)"
    pane_state="$(jq -r '.paneState // "active"' <<< "$task_state" 2>/dev/null || echo "active")"
    if [[ -n "$issue" && -n "$slug" && "$pane_state" != "rehydrating" ]]; then
      target="$(_tmux_task_window_target "${SESSION:-wavemill}" "$issue" "$slug" "${STATE_FILE:-}" "$wt_dir" 2>/dev/null || true)"
      if [[ -z "$target" ]]; then
        reconciliation_lease_release "$state_dir"
        return 1
      fi
    fi
  fi
  return 0
}

reconciliation_lease_acquire() {
  local state_dir="$1" pr="$2" head="$3" lease_dir lease_file tmp_file
  lease_dir="$(reconciliation_lease_dir "$state_dir")"
  if reconciliation_lease_held "$state_dir"; then
    printf '%s\n' "reconciliation-lease-held"
    return 1
  fi
  if ! mkdir "$lease_dir" 2>/dev/null; then
    printf '%s\n' "reconciliation-lease-held"
    return 1
  fi
  lease_file="$lease_dir/lease.json"
  tmp_file="$lease_dir/lease.json.tmp.$$"
  jq -n \
    --arg pr "$pr" \
    --arg headSha "$head" \
    --arg session "${SESSION:-}" \
    --argjson pid "$$" \
    --argjson acquiredAt "$(date +%s)" \
    '{pr:$pr, headSha:$headSha, session:$session, pid:$pid, acquiredAt:$acquiredAt}' > "$tmp_file" 2>/dev/null \
    && mv "$tmp_file" "$lease_file" 2>/dev/null || {
      rm -f "$tmp_file" 2>/dev/null || true
      rmdir "$lease_dir" 2>/dev/null || true
      printf '%s\n' "reconciliation-lease-write-failed"
      return 1
    }
  printf '%s\n' "ok"
  return 0
}

# Canonical task-state writer (HOK-2900). Before canonicalization the parent
# mill, the startup runner, and the extracted monitor each carried a private
# copy whose semantics had drifted: the parent copy defaulted an omitted
# status to "" and never resolved a traceId (and had no production call site
# left after the monitor extraction), while the monitor copy defaulted to
# "active" and resolved traceId but rebuilt the task object from a fixed
# field literal, silently dropping any stored field missing from its
# allowlist (windowId among them). The startup copy instead collided on
# positional argument 19 (phase there, challengeStage in the monitor). One
# implementation lives here, sourced by all three scopes, so the live startup
# launch writes and monitor runtime writes cannot drift apart again.
#
# Usage:
#   save_task_state <issue> <slug> <branch> <worktree> [pr] [status] [agent]
#     [linearIssue] [challenge] [challengePair] [challengeRole]
#     [challengeModel] [plannerModel] [coderModel] [reviewerModel]
#     [planDepth] [codeDepth] [reviewMode] [challengeStage] [phase]
#     [windowId]
#
# Canonical positional tail: challengeStage (19), phase (20), windowId (21).
# The monitor passes challengeStage at 19; startup callers pass phase and
# windowId at 20/21 so both live layouts are unambiguous.
#
# Merge contract: the write is a single atomic state_mutate that overlays only
# the supplied core fields onto the existing task object; every key the writer
# does not understand (phase/window, challenge intent and varied routing,
# retry/evaluation/comparison state, execution metadata, unknown future
# fields) is retained. Blank optional arguments mean "leave the stored value
# unchanged"; pr and status are always written.
#
# Status default: a blank or omitted status argument saves "active" — the
# monitor's live default — instead of an accidental empty status. An explicit
# non-empty status (including terminal and error states) always wins.
#
# traceId is resolved best-effort from the worktree's
# features/<slug>/.trace-context.json, then bugs/<slug>/.trace-context.json
# (HOK-2259); an absent or malformed context never fails the write and never
# erases a traceId already stored in the ledger.
save_task_state() {
  local issue="$1" slug="$2" branch="$3" worktree="$4" pr="${5:-}" status_arg="${6:-}" agent="${7:-}"
  local linear_issue="${8:-$issue}" challenge="${9:-}" challenge_pair="${10:-}" challenge_role="${11:-}" challenge_model="${12:-}"
  local planner_model="${13:-}" coder_model="${14:-}" reviewer_model="${15:-}" plan_depth="${16:-}" code_depth="${17:-}" review_mode="${18:-}"
  local challenge_stage="${19:-}" phase="${20:-}" window_id="${21:-}"
  local status="${status_arg:-active}" effective_base_branch effective_base_sha integration_mode merge_method remote_deletion_allowed run_epoch
  if [[ "$challenge" == "true" && -z "$challenge_role" && -n "$challenge_pair" && "$challenge_pair" == "$issue" ]]; then
    challenge_role="primary"
  fi
  if [[ "$challenge" == "true" && -z "$challenge_role" ]]; then
    echo "Error: challengeRole cannot be empty for challenge task $issue (challengePairId '$challenge_pair' does not identify a primary role)" >&2
    return 1
  fi

  # Resolve traceId from the worktree's feature (then bug) directory —
  # best-effort, never fails the state write.
  local _trace_id_for_state="" _dir_prefix _ctx_candidate
  for _dir_prefix in features bugs; do
    _ctx_candidate="$worktree/$_dir_prefix/$slug/.trace-context.json"
    if [[ -f "$_ctx_candidate" ]]; then
      _trace_id_for_state=$(jq -r '.traceId // empty' "$_ctx_candidate" 2>/dev/null || true)
      break
    fi
  done

  effective_base_branch="${BASE_BRANCH:-}"
  effective_base_sha="$(task_lifecycle_effective_base_sha "$effective_base_branch" 2>/dev/null || true)"
  integration_mode="direct-monitor"
  [[ "${MERGE_QUEUE_ENABLED:-true}" == "1" || "${MERGE_QUEUE_ENABLED:-true}" == "true" ]] && integration_mode="merge-queue"
  merge_method="${INTEGRATION_MERGE_METHOD:-squash}"
  remote_deletion_allowed="${INTEGRATION_DELETE_BRANCH_AFTER_MERGE:-true}"
  [[ "$remote_deletion_allowed" == "1" ]] && remote_deletion_allowed="true"
  [[ "$remote_deletion_allowed" == "0" ]] && remote_deletion_allowed="false"
  [[ "$remote_deletion_allowed" == "true" ]] || remote_deletion_allowed="false"
  run_epoch="${WAVEMILL_RUN_EPOCH:-${RUN_EPOCH:-}}"

  if ! state_mutate "$STATE_FILE" \
     "$(task_lifecycle_jq_filter '(.tasks[$issue] // {}) as $existing |
      ((($existing.status // "") | IN("merged","complete","completed","completed-external","closed","done","aborted","error"))
       or (($existing.phase // "") | IN("done","closed","aborted","error"))) as $existingTerminal |
      (if $statusArg != "" then $statusArg elif $existingTerminal then ($existing.status // "active") else "active" end) as $effectiveStatus |
      .tasks[$issue] = ($existing + {
        slug: $slug,
        branch: $branch,
        worktree: $worktree,
        pr: $pr,
        status: $effectiveStatus,
        linearIssueId: (if $linearIssue != "" then $linearIssue else ($existing.linearIssueId // $issue) end),
        updated: (now | todate)
      })
      | if $agent != "" then .tasks[$issue].agent = $agent else . end
      | if $challenge != "" then .tasks[$issue].challenge = ($challenge == "true") else . end
      | if $challengePair != "" then .tasks[$issue].challengePairId = $challengePair else . end
      | if $challengeRole != "" then .tasks[$issue].challengeRole = $challengeRole else . end
      | if $challengeModel != "" then .tasks[$issue].challengeModel = $challengeModel else . end
      | if $challengeStage != "" then .tasks[$issue].challengeStage = $challengeStage else . end
      | if $plannerModel != "" then .tasks[$issue].plannerModel = $plannerModel else . end
      | if $coderModel != "" then .tasks[$issue].coderModel = $coderModel else . end
      | if $reviewerModel != "" then .tasks[$issue].reviewerModel = $reviewerModel else . end
      | if $planDepth != "" then .tasks[$issue].planDepth = $planDepth else . end
      | if $codeDepth != "" then .tasks[$issue].codeDepth = $codeDepth else . end
      | if $reviewMode != "" then .tasks[$issue].reviewMode = $reviewMode else . end
      | if $phase != "" then .tasks[$issue].phase = $phase else . end
      | if $windowId != "" then .tasks[$issue].windowId = $windowId else . end
      | if $traceId != "" then .tasks[$issue].traceId = $traceId else . end
      | .tasks[$issue].lifecycle = (.tasks[$issue] | wm_normalized_lifecycle($baseBranch; $baseSha; $integrationMode; $mergeMethod; $remoteDeletionAllowed; $challengeRole; $challengePair; $session; $runEpoch; (.windowId // ""); "save_task_state"))
      | if $pr != "" then .tasks[$issue].lifecycle.deliveryEvidence.prNumber = $pr else . end')" \
     --arg issue "$issue" --arg slug "$slug" --arg branch "$branch" \
     --arg worktree "$worktree" --arg pr "$pr" --arg statusArg "$status_arg" --arg agent "$agent" \
     --arg linearIssue "$linear_issue" --arg challenge "$challenge" --arg challengePair "$challenge_pair" \
     --arg challengeRole "$challenge_role" --arg challengeModel "$challenge_model" \
     --arg challengeStage "$challenge_stage" \
     --arg plannerModel "$planner_model" --arg coderModel "$coder_model" --arg reviewerModel "$reviewer_model" \
     --arg planDepth "$plan_depth" --arg codeDepth "$code_depth" --arg reviewMode "$review_mode" \
     --arg phase "$phase" --arg windowId "$window_id" \
     --arg traceId "$_trace_id_for_state" \
     --arg baseBranch "$effective_base_branch" --arg baseSha "$effective_base_sha" \
     --arg integrationMode "$integration_mode" --arg mergeMethod "$merge_method" \
     --arg remoteDeletionAllowed "$remote_deletion_allowed" --arg session "${SESSION:-}" \
     --arg runEpoch "$run_epoch"; then
    # log_warn is caller-provided (the mill and monitor define it; the startup
    # runner intentionally surfaces the failure through wavemill_lock_run).
    if declare -F log_warn >/dev/null 2>&1; then
      log_warn "save_task_state: failed to save $issue"
    fi
  fi
}

# Canonical task-state remover (HOK-2903). Before canonicalization three
# private copies had drifted: the parent mill's jq body only deleted the task
# (leaving the top-level .updated timestamp stale after a removal), while the
# monitor and startup-runner copies also stamped .updated; the startup-runner
# copy additionally skipped log_warn and propagated state_mutate's exit code
# (though all four of its call sites discarded it via `|| true`). Canonical
# semantics adopt the monitor's live behavior:
#   - Atomic state_mutate on $STATE_FILE.
#   - Always refresh the top-level .updated timestamp so observers and
#     dashboards see the state churn, whether or not the task existed.
#   - Idempotent when the task is absent: del(.tasks["missing"]) is a jq
#     no-op that succeeds and still refreshes .updated.
#   - On state_mutate failure, warn via log_warn when the caller defines it
#     (the mill and monitor do; common-sourced test harnesses may not) and
#     always return 0 so cleanup paths under set -e never abort.
# Deliberately untouched bookkeeping: .migrationReservations[$issue] is
# preserved — reservation numbers are intentionally sticky so they can be
# re-associated with retry worktrees; changing that is a lifecycle decision
# outside this helper's contract.
remove_task_state() {
  local issue="$1"
  if ! state_mutate "$STATE_FILE" \
     'del(.tasks[$issue]) | .updated = (now | todate)' \
     --arg issue "$issue"; then
    if declare -F log_warn >/dev/null 2>&1; then
      log_warn "remove_task_state: failed to remove $issue"
    fi
  fi
}

# ============================================================================
# CANONICAL PR STATE AND MERGE VALIDATION HELPERS (HOK-2904)
# ============================================================================
# Before canonicalization, the parent mill queried GitHub without a timeout and
# returned an empty string on failure, while the monitor bounded the state read
# with API_TIMEOUT but used the same implicit empty-string uncertainty sentinel.
# The canonical PR state vocabulary is explicit: MERGED, CLOSED, OPEN, UNKNOWN.
# UNKNOWN covers GitHub errors, API_TIMEOUT expiry, empty output, and unexpected
# state values. Callers compare against confirmed states, so unavailable GitHub
# data never reads as a successful merge.
pr_state() {
  local pr="$1"
  local state

  if ! state=$(_with_timeout "$API_TIMEOUT" gh pr view "$pr" --json state --jq .state 2>/dev/null); then
    printf 'UNKNOWN\n'
    return 0
  fi

  case "$state" in
    MERGED|CLOSED|OPEN)
      printf '%s\n' "$state"
      ;;
    *)
      printf 'UNKNOWN\n'
      ;;
  esac
}

# Check if PR is merged and ready for cleanup.
# Returns 0 only for a confirmed merge to BASE_BRANCH; every unreadable,
# unknown, open, closed-unmerged, or wrong-base state fails closed.
# Note: Once PR is merged, CI status is irrelevant for cleanup decisions.
validate_pr_merge() {
  local pr="$1"
  [[ -z "$pr" ]] && return 1

  local details
  if ! details=$(_with_timeout "$API_TIMEOUT" gh pr view "$pr" --json state,baseRefName 2>/dev/null); then
    if declare -F log_error >/dev/null 2>&1; then
      log_error "Failed to fetch PR #$pr details"
    fi
    return 1
  fi

  if [[ -z "$details" ]]; then
    if declare -F log_error >/dev/null 2>&1; then
      log_error "Failed to fetch PR #$pr details"
    fi
    return 1
  fi

  local state base_branch
  if ! state=$(printf '%s\n' "$details" | jq -r '.state' 2>/dev/null); then
    if declare -F log_warn >/dev/null 2>&1; then
      log_warn "Failed to parse PR #$pr state"
    fi
    return 1
  fi
  if ! base_branch=$(printf '%s\n' "$details" | jq -r '.baseRefName' 2>/dev/null); then
    if declare -F log_warn >/dev/null 2>&1; then
      log_warn "Failed to parse PR #$pr base branch"
    fi
    return 1
  fi

  # Check 1: Must be MERGED (not CLOSED or OPEN).
  if [[ "$state" != "MERGED" ]]; then
    if declare -F log_warn >/dev/null 2>&1; then
      log_warn "PR #$pr state is $state (not MERGED)"
    fi
    return 1
  fi

  # Check 2: Must be merged to correct base branch.
  if [[ "$base_branch" != "${BASE_BRANCH:-}" ]]; then
    if declare -F log_error >/dev/null 2>&1; then
      log_error "PR #$pr merged to wrong base: $base_branch (expected: ${BASE_BRANCH:-})"
    fi
    return 1
  fi

  # Once PR is merged, proceed with cleanup regardless of CI status.
  # The merge has already happened; CI validation is for pre-merge safety.
  return 0
}

# ============================================================================
# CANONICAL LINEAR STATE HELPERS (HOK-2901)
# ============================================================================
# Single wall-clock cap for Linear-facing helpers. The monitor already defined
# this knob (an API call that hangs blocks the monitor loop and the operator
# cannot type 'q' or select tasks); the mill previously had no equivalent and
# relied on the generic retry ladder. One default here means one knob controls
# Linear latency in every scope that sources this file.
API_TIMEOUT="${API_TIMEOUT:-30}"

# Canonical Linear state writer. Before canonicalization the mill copy went
# through the generic `retry` helper (up to MAX_RETRIES × RETRY_TIMEOUT plus
# backoff sleeps — roughly 90 s of blocking work with stderr discarded), while
# the monitor copy made a single API_TIMEOUT-bounded call and logged the exit
# code and last stderr line on failure. The canonical helper keeps the monitor
# semantics: one attempt, hard wall-clock cap, diagnostics retained. Queued
# retry for transient Linear write failures lives in linear-retry-drain, not
# here.
#
# Contract:
# - Always non-fatal: returns 0 even when the tool fails (safe under set -e).
# - Respects DRY_RUN: logs the intended transition and skips the tool call.
# - Wall-clock: bounded by API_TIMEOUT (default 30 s) via the caller scope's
#   _with_timeout.
# - Diagnostics: on failure log_warn carries issue, target state, exit code,
#   and the last stderr line the tool produced.
linear_set_state() {
  local issue="$1" state="$2"
  if [[ "${DRY_RUN:-false}" == "true" ]]; then
    declare -F log >/dev/null 2>&1 && log "[DRY-RUN] Would set $issue → $state"
    return 0
  fi

  local stderr_file rc=0
  stderr_file=$(mktemp) || {
    declare -F log_warn >/dev/null 2>&1 && log_warn "Failed to update Linear state for $issue to $state (mktemp failed)"
    return 0
  }

  _with_timeout "$API_TIMEOUT" npx tsx "$TOOLS_DIR/set-issue-state.ts" "$issue" "$state" >/dev/null 2>"$stderr_file" || rc=$?
  if (( rc == 0 )); then
    rm -f "$stderr_file"
    return 0
  fi

  if declare -F log_warn >/dev/null 2>&1; then
    if [[ -s "$stderr_file" ]]; then
      local err_line
      err_line=$(tail -n 1 "$stderr_file")
      log_warn "Failed to update Linear state for $issue to $state (exit $rc): $err_line"
    else
      log_warn "Failed to update Linear state for $issue to $state (exit $rc)"
    fi
  fi
  rm -f "$stderr_file"
  return 0
}

# Canonical Linear completion check. Before canonicalization the mill copy
# asked get-issue-state.ts, which reports `completed` from Linear's
# completedAt/canceledAt timestamps, while the monitor copy asked
# get-issue.ts --json and matched the display name against a literal list
# (Done, Completed, Canceled) — silently misclassifying workspaces with
# renamed workflow states or non-US spellings such as "Cancelled". The
# canonical helper uses get-issue-state.ts.
#
# Uncertainty policy: any lookup failure (Linear error, network failure,
# API_TIMEOUT expiry, unexpected output) returns non-zero, i.e. "not
# completed". Callers gate destructive worktree cleanup on this answer and
# re-check on their next tick, so a transient outage delays cleanup instead of
# ever wiping an operator's work on a false positive.
linear_is_completed() {
  local issue="$1"
  local state
  state=$(_with_timeout "$API_TIMEOUT" npx tsx "$TOOLS_DIR/get-issue-state.ts" "$issue" 2>/dev/null || echo "active")
  [[ "$state" == "completed" ]] && return 0
  return 1
}

cleanup_background_jobs_startup() {
  # Keep only jobs created by the current session; older or pre-session jobs
  # are stale once a new session starts.
  [[ -n "${SESSION:-}" ]] || return 0
  [[ -r "${STATE_FILE:-}" && -s "${STATE_FILE:-}" ]] || return 0
  state_mutate "$STATE_FILE" \
    '.jobs = ((.jobs // {}) | with_entries(select(.value.session? == $session)))' \
    --arg session "${SESSION:-}"
}

cleanup_background_jobs_shutdown() {
  # Drop completed+settled current-session jobs on exit so the next session
  # starts from a clean slate. Running or unsettled jobs are preserved so
  # detached background processes (eval, comparison) can still be reaped.
  [[ -n "${SESSION:-}" ]] || return 0
  [[ -r "${STATE_FILE:-}" && -s "${STATE_FILE:-}" ]] || return 0
  state_mutate "$STATE_FILE" \
    '.jobs = ((.jobs // {}) | with_entries(select(
      .value.session? != $session
      or .value.status? == "running"
      or (.value.settled? != true)
    )))' \
    --arg session "${SESSION:-}"
}

get_file_size_bytes() {
  local path="$1"
  if stat -f%z "$path" 2>/dev/null; then
    return 0
  fi
  if stat -c%s "$path" 2>/dev/null; then
    return 0
  fi
  return 1
}

portable_file_mtime_epoch() {
  local path="$1"
  [[ -n "$path" && -e "$path" ]] || return 1

  # Try GNU stat (Linux) first; stat -f on Linux returns mount point, not mtime
  if stat -c %Y "$path" 2>/dev/null; then
    return 0
  fi
  # Fall back to BSD stat (macOS)
  if stat -f %m "$path" 2>/dev/null; then
    return 0
  fi
  return 1
}

blocked_completion_artifact_path() {
  local feature_dir="$1"
  printf '%s\n' "$feature_dir/.coding-blocked-completion.json"
}

coding_uncommitted_output_artifact_path() {
  local feature_dir="$1"
  printf '%s\n' "$feature_dir/.coding-uncommitted-output.json"
}

# Append-only log of resolved operator-handoff episodes (HOK-2894). Each line
# preserves a .coding-uncommitted-output.json snapshot after the guard
# clears, so eval-time manual-edit attribution can still see the interval
# during which an operator committed the agent's uncommitted output.
coding_uncommitted_output_resolved_log_path() {
  local feature_dir="$1"
  printf '%s\n' "$feature_dir/.coding-uncommitted-output.resolved.jsonl"
}

blocked_completion_default_summary() {
  printf 'coding done; verification blocked\n'
}

coding_uncommitted_output_default_summary() {
  printf 'coding completed marker detected, but review cannot start until the coding output is committed\n'
}

sanitize_blocked_completion_text() {
  local raw="${1-}"
  printf '%s' "$raw" \
    | tr '\r\n' '  ' \
    | LC_ALL=C tr -d '\000-\010\013\014\016-\037\177' \
    | sed -E 's/[[:space:]]+/ /g; s/^ //; s/ $//'
}

read_blocked_completion() {
  local feature_dir="$1"
  local artifact mtime summary reason summary_raw reason_raw
  local separator=$'\001'

  artifact="$(blocked_completion_artifact_path "$feature_dir")"
  [[ -f "$artifact" ]] || return 0

  mtime="$(portable_file_mtime_epoch "$artifact" 2>/dev/null || echo "")"
  summary="$(blocked_completion_default_summary)"
  summary="$(sanitize_blocked_completion_text "$summary")"
  reason=""

  if [[ ! -s "$artifact" ]] || ! command -v jq >/dev/null 2>&1 || ! jq empty "$artifact" >/dev/null 2>&1; then
    printf '%s%s%s%s%s\n' "$summary" "$separator" "$reason" "$separator" "$mtime"
    return 0
  fi

  summary_raw="$(jq -r '.summary // empty' "$artifact" 2>/dev/null || true)"
  reason_raw="$(jq -r '.reason // empty' "$artifact" 2>/dev/null || true)"
  summary_raw="$(sanitize_blocked_completion_text "$summary_raw")"
  reason_raw="$(sanitize_blocked_completion_text "$reason_raw")"

  if [[ -z "$summary_raw" ]]; then
    printf '%s%s%s%s%s\n' "$summary" "$separator" "$reason_raw" "$separator" "$mtime"
    return 0
  fi

  printf '%s%s%s%s%s\n' "$summary_raw" "$separator" "$reason_raw" "$separator" "$mtime"
}

read_coding_uncommitted_output() {
  local feature_dir="$1"
  local artifact mtime summary reason action summary_raw reason_raw action_raw
  local separator=$'\001'

  artifact="$(coding_uncommitted_output_artifact_path "$feature_dir")"
  [[ -f "$artifact" ]] || return 0

  mtime="$(portable_file_mtime_epoch "$artifact" 2>/dev/null || echo "")"
  summary="$(coding_uncommitted_output_default_summary)"
  summary="$(sanitize_blocked_completion_text "$summary")"
  reason=""
  action="Commit the coding output, then retry review."

  if [[ ! -s "$artifact" ]] || ! command -v jq >/dev/null 2>&1 || ! jq empty "$artifact" >/dev/null 2>&1; then
    printf '%s%s%s%s%s%s%s\n' "$summary" "$separator" "$reason" "$separator" "$action" "$separator" "$mtime"
    return 0
  fi

  summary_raw="$(jq -r '.summary // empty' "$artifact" 2>/dev/null || true)"
  reason_raw="$(jq -r '.reason // empty' "$artifact" 2>/dev/null || true)"
  action_raw="$(jq -r '.action // empty' "$artifact" 2>/dev/null || true)"
  summary_raw="$(sanitize_blocked_completion_text "$summary_raw")"
  reason_raw="$(sanitize_blocked_completion_text "$reason_raw")"
  action_raw="$(sanitize_blocked_completion_text "$action_raw")"

  [[ -n "$summary_raw" ]] && summary="$summary_raw"
  [[ -n "$reason_raw" ]] && reason="$reason_raw"
  [[ -n "$action_raw" ]] && action="$action_raw"

  printf '%s%s%s%s%s%s%s\n' "$summary" "$separator" "$reason" "$separator" "$action" "$separator" "$mtime"
}

project_context_suggestion_set() {
  local size_bytes="$1"
  local threshold_bytes="$2"
  local mtime=""

  [[ -n "${STATE_FILE:-}" && -f "$STATE_FILE" ]] || return 1
  [[ -n "${REPO_DIR:-}" ]] || return 1

  local context_file="$REPO_DIR/.wavemill/project-context.md"
  local epoch
  if epoch=$(stat -c '%Y' "$context_file" 2>/dev/null) && mtime=$(date -u -d "@$epoch" '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null); then
    :
  elif mtime=$(date -r "$context_file" -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null); then
    :
  else
    mtime=""
  fi

  state_mutate "$STATE_FILE" '
    .project_context_suggestion = {
      sizeBytes: ($sizeBytes | tonumber),
      thresholdBytes: ($thresholdBytes | tonumber),
      mtime: $mtime,
      suggestedAction: "wavemill context compact",
      recordedAt: (now | todateiso8601)
    }
  ' --arg sizeBytes "$size_bytes" --arg thresholdBytes "$threshold_bytes" --arg mtime "$mtime" >/dev/null
}

project_context_suggestion_clear() {
  [[ -n "${STATE_FILE:-}" && -f "$STATE_FILE" ]] || return 0
  state_mutate "$STATE_FILE" 'del(.project_context_suggestion)' >/dev/null
}

queue_add_task() {
  local issue_id="${1:-}" blocker_issue_id="${2:-}" blocker_pr_number="${3:-}" desired_base_branch="${4:-}" linear_issue_url="${5:-}"
  local slug="${6:-}" title="${7:-}"
  if [[ -z "$issue_id" || -z "$blocker_issue_id" || -z "$blocker_pr_number" || -z "$desired_base_branch" || -z "$linear_issue_url" ]]; then
    echo "Usage: queue_add_task <issue_id> <blocker_issue_id> <blocker_pr_number> <desired_base_branch> <linear_url> [slug] [title]" >&2
    return 1
  fi

  state_mutate "$STATE_FILE" \
    '.queued_tasks = ((.queued_tasks // []) | map(select(.issue_id != $issue_id))) + [{
      issue_id: $issue_id,
      blocker_issue_id: $blocker_issue_id,
      blocker_pr_number: (if $blocker_pr_number == "null" then null else ($blocker_pr_number | tonumber) end),
      desired_base_branch: $desired_base_branch,
      linear_issue_url: $linear_issue_url,
      slug: $slug,
      title: $title,
      queued_at: (now | todate)
    }]' \
    --arg issue_id "$issue_id" \
    --arg blocker_issue_id "$blocker_issue_id" \
    --arg blocker_pr_number "$blocker_pr_number" \
    --arg desired_base_branch "$desired_base_branch" \
    --arg linear_issue_url "$linear_issue_url" \
    --arg slug "$slug" \
    --arg title "$title"
}

queue_remove_task() {
  local issue_id="${1:-}"
  if [[ -z "$issue_id" ]]; then
    echo "Usage: queue_remove_task <issue_id>" >&2
    return 1
  fi

  state_mutate "$STATE_FILE" \
    '.queued_tasks = ((.queued_tasks // []) | map(select(.issue_id != $issue_id)))' \
    --arg issue_id "$issue_id"
}

queue_list_tasks() {
  [[ -f "$STATE_FILE" ]] || {
    printf '[]\n'
    return 0
  }
  jq -r '.queued_tasks // []' "$STATE_FILE"
}

find_queued_children_for_parent() {
  local parent_issue="${1:-}"
  if [[ -z "$parent_issue" ]]; then
    echo "Usage: find_queued_children_for_parent <parent_issue>" >&2
    return 1
  fi

  [[ -f "$STATE_FILE" ]] || {
    printf '[]\n'
    return 0
  }

  jq -c --arg parent_issue "$parent_issue" \
    '[.queued_tasks[]? | select(.blocker_issue_id == $parent_issue and ((.waiting_reason // "") == ""))]' \
    "$STATE_FILE"
}

resolve_parent_pr_branch() {
  local pr_number="${1:-}"
  if [[ -z "$pr_number" ]]; then
    echo "Usage: resolve_parent_pr_branch <pr_number>" >&2
    return 1
  fi

  local pr_json
  if ! pr_json=$(gh pr view "$pr_number" --json headRefName,url,number 2>&1); then
    printf '%s\n' "$pr_json" >&2
    return 1
  fi

  local branch url resolved_number
  branch=$(printf '%s' "$pr_json" | jq -r '.headRefName // ""' 2>/dev/null || echo "")
  url=$(printf '%s' "$pr_json" | jq -r '.url // ""' 2>/dev/null || echo "")
  resolved_number=$(printf '%s' "$pr_json" | jq -r '.number // empty' 2>/dev/null || echo "")
  if [[ -z "$branch" || "$branch" == "null" ]]; then
    echo "parent PR #$pr_number is missing headRefName" >&2
    return 1
  fi

  printf '%s|%s|%s\n' "$branch" "${resolved_number:-$pr_number}" "$url"
}

record_depends_on_metadata() {
  local child_issue="${1:-}" pr_number="${2:-}" pr_url="${3:-}" pr_branch="${4:-}" parent_issue="${5:-}"
  if [[ -z "$child_issue" || -z "$pr_number" || -z "$pr_url" || -z "$pr_branch" || -z "$parent_issue" ]]; then
    echo "Usage: record_depends_on_metadata <child_issue> <pr_number> <pr_url> <pr_branch> <parent_issue>" >&2
    return 1
  fi

  state_mutate "$STATE_FILE" \
    '.tasks[$issue] = ((.tasks[$issue] // {}) + {
      dependsOnPr: {
        number: ($pr_number | tonumber),
        url: $pr_url,
        branch: $pr_branch,
        parent_issue: $parent_issue
      }
    })' \
    --arg issue "$child_issue" \
    --arg pr_number "$pr_number" \
    --arg pr_url "$pr_url" \
    --arg pr_branch "$pr_branch" \
    --arg parent_issue "$parent_issue"
}

queue_mark_waiting() {
  local child_issue="${1:-}" reason="${2:-}"
  if [[ -z "$child_issue" || -z "$reason" ]]; then
    echo "Usage: queue_mark_waiting <child_issue> <reason>" >&2
    return 1
  fi

  state_mutate "$STATE_FILE" \
    '.queued_tasks = ((.queued_tasks // []) | map(if .issue_id == $issue then (.waiting_reason = $reason) else . end))' \
    --arg issue "$child_issue" \
    --arg reason "$reason"
}

wavemill_pane_repaint() {
  local content="${1-}" line frame_bytes="" current_lines=0

  # Count lines in the new frame so we can detect shrink vs grow.
  while IFS= read -r line || [[ -n "$line" ]]; do
    current_lines=$((current_lines + 1))
  done <<< "$content"

  local prev_lines="${WAVEMILL_PANE_REPAINT_LAST_LINES:-0}"

  # When the new frame is shorter than the previous one, stale rows would
  # remain visible below the new content even after ESC[J.  Pre-clear by
  # saving the cursor at the anchor (caller has already restored it there),
  # moving down through every row of the old frame with ESC[K, emitting
  # ESC[J to clear the rest, then restoring the cursor to the anchor so
  # the new content overwrites from the top.
  if (( prev_lines > current_lines )); then
    frame_bytes=$'\033[s'
    local _i
    for (( _i = 0; _i < prev_lines; _i++ )); do
      frame_bytes+=$'\033[K'
      (( _i < prev_lines - 1 )) && frame_bytes+=$'\n'
    done
    frame_bytes+=$'\033[J'
    frame_bytes+=$'\033[u'
  fi

  # Paint new content, clearing to EOL on each line.
  while IFS= read -r line || [[ -n "$line" ]]; do
    frame_bytes+="${line}"$'\033[K\n'
  done <<< "$content"
  frame_bytes+=$'\033[J'

  printf '%s' "$frame_bytes"
  WAVEMILL_PANE_REPAINT_LAST_LINES=$current_lines
}


# ============================================================================
# PANE MESSAGE DELIVERY (HOK-2765)
# ============================================================================
# Helper to send a message to a tmux pane and confirm it was submitted by the
# agent TUI, with retries. This avoids "fire-and-forget" sends that can
# leave messages stranded in the input buffer if the TUI is unresponsive.

WAVEMILL_PANE_MESSAGE_ATTEMPTS="${WAVEMILL_PANE_MESSAGE_ATTEMPTS:-3}"
WAVEMILL_PANE_MESSAGE_CONFIRM_WAIT="${WAVEMILL_PANE_MESSAGE_CONFIRM_WAIT:-3}"
WAVEMILL_PANE_MESSAGE_POLL="${WAVEMILL_PANE_MESSAGE_POLL:-0.3}"
WAVEMILL_PANE_MESSAGE_ENTER_DELAY="${WAVEMILL_PANE_MESSAGE_ENTER_DELAY:-0.3}"
WAVEMILL_PANE_MESSAGE_RETRY_DELAY="${WAVEMILL_PANE_MESSAGE_RETRY_DELAY:-1}"
WAVEMILL_PANE_MESSAGE_CAPTURE_LINES="${WAVEMILL_PANE_MESSAGE_CAPTURE_LINES:-60}"

# Captures the tail of a pane, joining wrapped lines so that long inputs
# that wrap in the TUI can still be detected on a single logical line.
# Args: <target-pane>
wavemill_pane_capture_tail() {
  local target="$1"
  local lines="${WAVEMILL_PANE_MESSAGE_CAPTURE_LINES:-60}"
  # -J joins wrapped lines. -S gives history from the bottom up.
  # -N prevents capturing output that has scrolled off screen.
  tmux capture-pane -p -J -t "$target" -S -"$lines" -N 2>/dev/null || true
}

# Produces a stable, whitespace-trimmed prefix of a message to use as a marker
# for detecting if the message is present in the pane's input buffer.
# Args: <message>
wavemill_pane_message_marker() {
  local message="$1"
  # Take the first 32 chars, strip leading/trailing whitespace.
  printf '%s' "${message:0:32}" | sed -E 's/^[[:space:]]+|[[:space:]]+$//g'
}

# Inspects a captured pane tail to determine the state of the input line.
# Args: <tail-text> <marker-text>
# Output: pending | submitted | cleared | unknown
wavemill_pane_tail_input_state() {
  local tail="$1" marker="$2"
  local last_prompt_line="" prompt_line_count=0 has_marker_elsewhere=false

  # Find the last input prompt line (❯, ›, >) in the tail.
  # The `case` statement is a portable, locale-safe way to match these specific
  # UTF-8 glyphs, avoiding `grep '[...]'` which can have surprising behavior
  # with multibyte characters under some locales (e.g., LC_ALL=C).
  while IFS= read -r line; do
    # Strip leading whitespace for prompt check
    local stripped_line
    stripped_line="${line#*"${line%%[![:space:]]*}"}"

    case "$stripped_line" in
      # Note: space after glyph is optional for some TUIs.
      "❯ "*|"❯"*|"› "*|"›"*|"> "*|">"*)
        last_prompt_line="$line"
        prompt_line_count=$((prompt_line_count + 1))
        ;;
      *)
        # If a line that is NOT the last prompt line contains the marker, it's an echo.
        if [[ "$last_prompt_line" != "" && "$line" == *"$marker"* ]]; then
          has_marker_elsewhere=true
        fi
        ;;
    esac
  done <<< "$tail"

  if [[ -z "$last_prompt_line" ]]; then
    # No prompt line found at all (e.g., TUI showing a modal dialog).
    if [[ "$tail" == *"$marker"* ]]; then
      # Marker is visible, but we can't determine if it is in an input box.
      # This can happen if the prompt line scrolled off the captured tail.
      # Treat as pending to be safe.
      printf 'pending\n'
    else
      printf 'unknown\n'
    fi
    return
  fi

  if [[ "$last_prompt_line" == *"$marker"* ]]; then
    # The last prompt line itself contains the marker text. It's pending.
    printf 'pending\n'
  elif [[ "$has_marker_elsewhere" == true || "$prompt_line_count" -gt 1 && "$tail" == *"$marker"* ]]; then
    # The last prompt is clear, but the marker exists elsewhere in the tail
    # (likely an echo of the submitted command). It's submitted.
    printf 'submitted\n'
  else
    # The last prompt line is clear, and the marker is not found elsewhere. Cleared.
    printf 'cleared\n'
  fi
}

# Checks if a wavemill status hook file confirms a recent submission.
# Args: <hook_file> <send_timestamp_epoch> <baseline_hook_state>
# Returns 0 if confirmed, 1 otherwise.
wavemill_pane_hook_confirms_submit() {
  local hook_file="$1" send_ts="$2" baseline_state="$3"
  local state event timestamp hook_ts

  [[ -f "$hook_file" ]] || return 1
  command -v jq >/dev/null 2>&1 || return 1

  # Read the latest hook state.
  local hook_json
  hook_json=$(jq -c . "$hook_file" 2>/dev/null) || return 1
  state=$(printf '%s' "$hook_json" | jq -r '.state // empty')
  event=$(printf '%s' "$hook_json" | jq -r '.event // empty')
  timestamp=$(printf '%s' "$hook_json" | jq -r '.timestamp // 0')
  hook_ts="${timestamp%.*}" # truncate fractional seconds

  # Confirm the hook event is fresh (happened at or after our send).
  (( hook_ts < send_ts )) && return 1

  # Signal 1: Explicit submission event from the TUI.
  if [[ "$event" == "UserPromptSubmit" ]]; then
    return 0
  fi

  # Signal 2: State transitioned from something else to 'working'. This covers
  # cases where a `PreToolUse` event might overwrite the `UserPromptSubmit` event
  # within our polling window.
  if [[ "$state" == "working" && "$baseline_state" != "working" ]]; then
    return 0
  fi

  return 1
}

# Send a message to a tmux pane and confirm its submission, with retries.
# Sets global variables with the outcome:
#   WAVEMILL_PANE_MESSAGE_LAST_STATUS: delivered|stranded|unconfirmed|unavailable
#   WAVEMILL_PANE_MESSAGE_LAST_SIGNAL: hook|pane|none
#   WAVEMILL_PANE_MESSAGE_LAST_ATTEMPTS: <number>
#   WAVEMILL_PANE_MESSAGE_LAST_DETAIL: <string>
#
# Args: <target-pane> <message> [issue_id] [session_name]
# Returns 0 on successful (confirmed) delivery, 1 otherwise.
wavemill_pane_send_message() {
  local target="$1" message="$2" issue="${3:-}" session="${4:-}"

  # Reset output globals
  WAVEMILL_PANE_MESSAGE_LAST_STATUS="unconfirmed"
  WAVEMILL_PANE_MESSAGE_LAST_SIGNAL="none"
  WAVEMILL_PANE_MESSAGE_LAST_ATTEMPTS=0
  WAVEMILL_PANE_MESSAGE_LAST_DETAIL=""

  # 1. Precondition: Check if pane exists and is alive.
  if ! tmux list-panes -t "$target" -F '#{pane_dead}' 2>/dev/null | grep -q '^0$'; then
    WAVEMILL_PANE_MESSAGE_LAST_STATUS="unavailable"
    WAVEMILL_PANE_MESSAGE_LAST_DETAIL="Pane $target not found or is dead."
    return 1
  fi

  local marker
  marker="$(wavemill_pane_message_marker "$message")"
  [[ -z "$marker" ]] && {
    WAVEMILL_PANE_MESSAGE_LAST_STATUS="unconfirmed"
    WAVEMILL_PANE_MESSAGE_LAST_DETAIL="Message is empty or whitespace-only; cannot track."
    return 1 # Cannot track an empty message
  }

  # 2. Baseline: Capture initial hook state if available.
  local hook_file="" baseline_hook_state="" baseline_hook_ts=0
  if [[ -n "$session" && -n "$issue" ]]; then
    hook_file="/tmp/wavemill-${session}-${issue}.hook"
    if [[ -f "$hook_file" ]] && command -v jq >/dev/null 2>&1; then
      local hook_json
      hook_json=$(jq -c . "$hook_file" 2>/dev/null || echo '{}')
      baseline_hook_state=$(printf '%s' "$hook_json" | jq -r '.state // empty')
      baseline_hook_ts=$(printf '%s' "$hook_json" | jq -r '.timestamp // 0' | sed 's/\..*//')
    fi
  fi

  local attempt last_pane_state="unknown" text_needs_sending=true
  for attempt in $(seq 1 "$WAVEMILL_PANE_MESSAGE_ATTEMPTS"); do
    WAVEMILL_PANE_MESSAGE_LAST_ATTEMPTS=$attempt
    local send_ts
    send_ts="$(date +%s)"

    # 3. Send keys. If the last attempt left the text in the input box,
    #    only send Enter this time. Otherwise, send the full literal text.
    if [[ "$text_needs_sending" == "true" ]]; then
      # The -l flag sends the message literally, avoiding shell interpretation.
      # A small delay between typing and Enter can help reliability in some TUIs.
      tmux send-keys -t "$target" -l -- "$message"
      sleep "$WAVEMILL_PANE_MESSAGE_ENTER_DELAY"
    fi
    tmux send-keys -t "$target" C-m

    # 4. Poll for confirmation.
    local poll_end_ts
    poll_end_ts=$(( $(date +%s) + WAVEMILL_PANE_MESSAGE_CONFIRM_WAIT ))
    while [[ $(date +%s) -lt "$poll_end_ts" ]]; do
      # a. Check hook first (most reliable signal for supported agents).
      if [[ -n "$hook_file" ]]; then
        if wavemill_pane_hook_confirms_submit "$hook_file" "$send_ts" "$baseline_hook_state"; then
          WAVEMILL_PANE_MESSAGE_LAST_STATUS="delivered"
          WAVEMILL_PANE_MESSAGE_LAST_SIGNAL="hook"
          WAVEMILL_PANE_MESSAGE_LAST_DETAIL="Confirmed by agent hook."
          return 0
        fi
      fi

      # b. Check pane content as a fallback.
      local tail
      tail="$(wavemill_pane_capture_tail "$target")"
      last_pane_state="$(wavemill_pane_tail_input_state "$tail" "$marker")"

      if [[ "$last_pane_state" == "submitted" || "$last_pane_state" == "cleared" ]]; then
        WAVEMILL_PANE_MESSAGE_LAST_STATUS="delivered"
        WAVEMILL_PANE_MESSAGE_LAST_SIGNAL="pane"
        WAVEMILL_PANE_MESSAGE_LAST_DETAIL="Confirmed by pane content analysis (state: $last_pane_state)."
        return 0
      fi

      sleep "$WAVEMILL_PANE_MESSAGE_POLL"
    done

    # 5. End of attempt: Decide whether to re-type or just press Enter next time.
    local tail
    tail="$(wavemill_pane_capture_tail "$target")"
    last_pane_state="$(wavemill_pane_tail_input_state "$tail" "$marker")"

    if [[ "$last_pane_state" == "pending" ]]; then
      # Text is sitting in the input box. Next attempt should just send Enter.
      text_needs_sending=false
      WAVEMILL_PANE_MESSAGE_LAST_STATUS="stranded"
      WAVEMILL_PANE_MESSAGE_LAST_DETAIL="Message text remained in the pane input line."
    else
      # Text is not in the input box. Maybe it was cleared, maybe it never arrived.
      # Re-send the full text on the next attempt to be safe.
      text_needs_sending=true
      WAVEMILL_PANE_MESSAGE_LAST_STATUS="unconfirmed"
      WAVEMILL_PANE_MESSAGE_LAST_DETAIL="Submission not confirmed by hook or pane content (last state: $last_pane_state)."
    fi

    # If not the last attempt, wait before retrying.
    if (( attempt < WAVEMILL_PANE_MESSAGE_ATTEMPTS )); then
      sleep "$WAVEMILL_PANE_MESSAGE_RETRY_DELAY"
    fi
  done

  # 6. Retries exhausted.
  return 1
}

# ============================================================================
# TRACE CORRELATION HELPERS (HOK-2259)
# ============================================================================

# Best-effort task lifecycle event stream written to features/<slug>/trace.jsonl.
# All functions are no-ops on error and never fail the calling workflow.

# Generate a trace ID: trc_<8-hex-unix-seconds>_<16-hex-random>
_trace_generate_id() {
  local ts rnd
  ts=$(printf '%08x' "$(date +%s)" 2>/dev/null || printf '%08x' 0)
  rnd=$(od -vAn -N8 -tx1 /dev/urandom 2>/dev/null | tr -d ' \n' | head -c 16 || printf '%016x' 0)
  printf 'trc_%s_%s\n' "$ts" "$rnd"
}

# Get or create a stable trace ID for a task feature directory.
# Usage: trace_get_or_create <feature_dir> <issue_id> <slug>
# Output: the traceId on stdout
# Never fails — returns a transient ID if persistence is unavailable.
trace_get_or_create() {
  local feature_dir="$1" issue_id="$2" slug="$3"
  local ctx_file="$feature_dir/.trace-context.json"

  if [[ -f "$ctx_file" ]]; then
    local existing
    existing=$(jq -r '.traceId // empty' "$ctx_file" 2>/dev/null || true)
    if [[ -n "$existing" ]]; then
      printf '%s\n' "$existing"
      return 0
    fi
  fi

  local new_id
  new_id=$(_trace_generate_id)
  mkdir -p "$feature_dir" 2>/dev/null || true

  local tmp
  tmp=$(mktemp "$feature_dir/.tmp-trace-ctx-XXXXXX" 2>/dev/null) || tmp=""
  if [[ -n "$tmp" ]]; then
    jq -cn \
      --arg sv "1.0" \
      --arg tid "$new_id" \
      --arg iid "$issue_id" \
      --arg sl "$slug" \
      --arg createdAt "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo '')" \
      '{schemaVersion:$sv,traceId:$tid,issueId:$iid,slug:$sl,createdAt:$createdAt}' > "$tmp" 2>/dev/null || true
    mv "$tmp" "$ctx_file" 2>/dev/null || rm -f "$tmp" 2>/dev/null || true
  fi

  printf '%s\n' "$new_id"
}

# Read the existing trace ID from a feature directory without creating one.
# Output: traceId or empty string if not found.
trace_read_id() {
  local feature_dir="$1"
  local ctx_file="$feature_dir/.trace-context.json"
  [[ -f "$ctx_file" ]] || return 0
  jq -r '.traceId // empty' "$ctx_file" 2>/dev/null || true
}

# Append a trace event to features/<slug>/trace.jsonl.
# Usage: trace_append_event <feature_dir> <trace_id> <issue_id> <slug> <phase> <event> [status] [model] [agent] [extra_json]
# Best-effort — never fails or prints errors.
trace_append_event() {
  local feature_dir="$1" trace_id="$2" issue_id="$3" slug="$4"
  local phase="$5" event="$6"
  local status="${7:-}" model="${8:-}" agent="${9:-}"
  local extra_json="${10:-}"

  [[ -n "$feature_dir" && -d "$feature_dir" && -n "$trace_id" ]] || return 0
  command -v jq >/dev/null 2>&1 || return 0

  local now
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "")

  local base_line
  base_line=$(jq -cn \
    --arg sv "1.0" \
    --arg tid "$trace_id" \
    --arg iid "$issue_id" \
    --arg sl "$slug" \
    --arg ts "$now" \
    --arg ph "$phase" \
    --arg ev "$event" \
    --arg st "$status" \
    --arg mo "$model" \
    --arg ag "$agent" \
    '{schemaVersion:$sv,traceId:$tid,issueId:$iid,slug:$sl,timestamp:$ts,phase:$ph,event:$ev}
     | if $st != "" then .status=$st else . end
     | if $mo != "" then .model=$mo else . end
     | if $ag != "" then .agent=$ag else . end' 2>/dev/null) || return 0

  local line="$base_line"
  if [[ -n "$extra_json" ]]; then
    line=$(jq -n --argjson base "$base_line" --argjson extra "$extra_json" \
      '$base + $extra' 2>/dev/null) || line="$base_line"
  fi

  [[ -n "$line" ]] || return 0
  printf '%s\n' "$line" >> "$feature_dir/trace.jsonl" 2>/dev/null || true
}
