#!/opt/homebrew/bin/bash
# Wavemill Status Dashboard - Real-time task status for tmux control panel
#
# Usage: wavemill-status.sh <session> <worktree_root> [state_file]
#
# Displays a compact per-task summary refreshing every 3 seconds:
#   ISSUE   TASK           TIME   AGENT      PR
#   WAV-42  hero-cta        12m   ● running  —
#   WAV-55  nav-a11y         8m   ● running  #147 ✓

set -euo pipefail

SESSION="${1:?Usage: wavemill-status.sh <session> <worktree_root> [state_file]}"
WORKTREE_ROOT="${2:?Usage: wavemill-status.sh <session> <worktree_root> [state_file]}"
STATE_FILE="${3:-}"

REFRESH=3
PR_CACHE="/tmp/${SESSION}-pr-cache.json"
PR_TTL=15

# Colors
G='\033[32m'; Y='\033[33m'; R='\033[31m'; D='\033[90m'; B='\033[1m'; N='\033[0m'

# Hide cursor during rendering
tput civis 2>/dev/null || true
trap 'tput cnorm 2>/dev/null || true' EXIT

# ── PR cache (refreshed every PR_TTL seconds) ────────────────────────────

refresh_pr_cache() {
  local now
  now=$(date +%s)
  local mtime=0
  [[ -f "$PR_CACHE" ]] && mtime=$(stat -f %m "$PR_CACHE" 2>/dev/null || echo 0)
  if (( now - mtime >= PR_TTL )); then
    gh pr list --json number,headRefName,state,statusCheckRollup --limit 50 \
      2>/dev/null > "${PR_CACHE}.tmp" && mv "${PR_CACHE}.tmp" "$PR_CACHE" || true
  fi
}

pr_for_branch() {
  local branch="$1"
  [[ -f "$PR_CACHE" ]] || return
  jq -r --arg b "$branch" \
    '.[] | select(.headRefName == $b) | "\(.number)|\(.state)"' \
    "$PR_CACHE" 2>/dev/null | head -1
}

pr_checks() {
  local branch="$1"
  [[ -f "$PR_CACHE" ]] || return
  jq -r --arg b "$branch" '
    .[] | select(.headRefName == $b) |
    .statusCheckRollup // [] |
    if length == 0 then "none"
    elif all(.conclusion == "SUCCESS") then "pass"
    elif any(.conclusion == "FAILURE" or .conclusion == "ERROR") then "fail"
    else "pending" end
  ' "$PR_CACHE" 2>/dev/null | head -1
}

# ── Elapsed time from directory birth ─────────────────────────────────────

elapsed() {
  local dir="$1"
  [[ -d "$dir" ]] || { echo "—"; return; }
  local birth
  birth=$(stat -f %B "$dir" 2>/dev/null || echo 0)
  (( birth > 0 )) || { echo "—"; return; }
  local mins=$(( ($(date +%s) - birth) / 60 ))
  if (( mins < 60 )); then
    printf "%dm" "$mins"
  else
    printf "%dh%dm" $((mins / 60)) $((mins % 60))
  fi
}

# ── Agent status via tmux pane liveness ───────────────────────────────────

agent_status() {
  local win="$1"
  local dead
  dead=$(tmux list-panes -t "$SESSION:$win" -F '#{pane_dead}' 2>/dev/null | head -1) || {
    echo "done"; return
  }
  if [[ "$dead" == "1" ]]; then echo "exited"; else echo "running"; fi
}

# ── Task discovery ────────────────────────────────────────────────────────
# Prefer state file (from mill), fall back to worktree directories.
# Output: issue|slug|branch|worktree  per line

gather_tasks() {
  if [[ -n "$STATE_FILE" && -f "$STATE_FILE" ]]; then
    jq -r '.tasks | to_entries[] | "\(.key)|\(.value.slug)|\(.value.branch)|\(.value.worktree)"' \
      "$STATE_FILE" 2>/dev/null
  else
    for dir in "$WORKTREE_ROOT"/*/; do
      [[ -d "$dir" ]] || continue
      local slug
      slug=$(basename "$dir")
      local branch
      branch=$(git -C "$dir" branch --show-current 2>/dev/null || echo "?")
      echo "—|$slug|$branch|$dir"
    done
  fi
}

# ── Check if a task is still active ──────────────────────────────────────
# A task is active if its worktree exists OR its tmux window exists.

is_active() {
  local worktree="$1"
  local win="$2"
  [[ -d "$worktree" ]] && return 0
  tmux list-panes -t "$SESSION:$win" 2>/dev/null >/dev/null && return 0
  return 1
}

# ── Main render loop ─────────────────────────────────────────────────────

# Clear screen once at startup
clear
FRAME=$(mktemp)
trap 'tput cnorm 2>/dev/null || true; rm -f "$FRAME"' EXIT

while true; do
  refresh_pr_cache

  # Build entire frame into a temp file (avoids $() stripping newlines)
  : > "$FRAME"
  printf "${B}Wavemill Dashboard${N}  ${D}%s${N}\n\n" "$(date '+%H:%M:%S')" >> "$FRAME"

  tasks=$(gather_tasks)

  if [[ -z "$tasks" ]]; then
    printf "${D}No active tasks${N}\n" >> "$FRAME"
  else
    # Header
    printf "${D}%-10s  %-22s  %6s  %-11s  %s${N}\n" "ISSUE" "TASK" "TIME" "AGENT" "PR" >> "$FRAME"
    printf "${D}%s${N}\n" "─────────────────────────────────────────────────────────────" >> "$FRAME"

    count=0
    while IFS= read -r line; do
      [[ -z "$line" ]] && continue
      IFS='|' read -r issue slug branch worktree <<<"$line"

      # Window name
      win="${issue}-${slug}"
      [[ "$issue" == "—" ]] && win="$slug"

      # Skip stale/completed tasks
      is_active "$worktree" "$win" || continue

      count=$((count + 1))

      # Time
      t=$(elapsed "$worktree")

      # Agent
      st=$(agent_status "$win")
      case "$st" in
        running) st_str="${G}● running${N}" ;;
        exited)  st_str="${Y}○ exited${N}" ;;
        *)       st_str="${D}  done${N}"   ;;
      esac

      # PR
      pr_str="${D}—${N}"
      pr_info=$(pr_for_branch "$branch")
      if [[ -n "$pr_info" ]]; then
        IFS='|' read -r pr_num pr_state <<<"$pr_info"
        case "$pr_state" in
          MERGED) pr_str="${G}#${pr_num} MERGED${N}" ;;
          CLOSED) pr_str="${R}#${pr_num} CLOSED${N}" ;;
          OPEN)
            checks=$(pr_checks "$branch")
            case "$checks" in
              pass)    pr_str="${G}#${pr_num} ✓${N}" ;;
              fail)    pr_str="${R}#${pr_num} ✗${N}" ;;
              pending) pr_str="${Y}#${pr_num} …${N}" ;;
              *)       pr_str="#${pr_num}" ;;
            esac ;;
        esac
      fi

      # Truncate slug
      ds="$slug"
      (( ${#ds} > 22 )) && ds="${ds:0:19}..."

      printf "%-10s  %-22s  %6s  %-11b  %b\n" "$issue" "$ds" "$t" "$st_str" "$pr_str" >> "$FRAME"
    done <<<"$tasks"

    if (( count == 0 )); then
      printf "${D}No active tasks${N}\n" >> "$FRAME"
    fi
  fi

  printf "\n${D}Refreshes every ${REFRESH}s │ Ctrl+B W: switch windows${N}\n" >> "$FRAME"

  # Atomic redraw: cursor to top-left, print frame, clear remaining lines
  tput cup 0 0 2>/dev/null || printf '\033[H'
  cat "$FRAME"
  tput ed 2>/dev/null || printf '\033[J'

  sleep "$REFRESH"
done
