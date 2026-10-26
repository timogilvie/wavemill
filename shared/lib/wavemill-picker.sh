# shellcheck shell=bash
# HOK-3305: Shared launch-set picker renderer. Both wavemill-monitor.sh and
# wavemill-mill.sh source this file so startup and monitor display identical
# "Launch next" / "Held" sections for identical input. Rendering is pure: no
# state writers, no state readers.
#
# Public contract (render_launch_set_picker):
#   $1 queue_plan_json  - fetch_queue_plan / build_queue_plan_once output.
#                         Expects availableNow, queuedAfterDependencies,
#                         sharedSurfaceConflicts, needsTriage.
#   $2 available        - 6-field pipe-delimited candidate rows:
#                         id|slug|title|area|score|blocked_by_count
#   $3 free_slots       - non-negative integer, default 1
#   $4 in_flight_json   - JSON array [{id, prNumber?, files?}], default "[]"
#   $5 budget           - integer line budget, default 999
#   $6 expanded         - "true"|"false", default "false" (m-toggle state)
#   $7 deps_expanded    - "true"|"false", default "false" (d-toggle state)
#   $8 active_issue_ids - newline list for on-deck classification
#   $9 include_header   - "true"|"false", default "true" - whether the output's
#                         first non-empty line is "Next tasks:" (or
#                         "Next tasks (slots full):" when free_slots == 0)
# Writes:
#   GROUPED_DISPLAY     - complete frame body
#   GROUPED_SELECT_FROM - newline-joined candidate records in display order
# Exit:
#   0 on success, 1 when nothing is rendered or queue_plan_json is invalid.

# Shared state carried over from the previous render_grouped_task_list site so
# the monitor's "backlog tier changed" log still fires once per tier change.
: "${BACKLOG_LAST_TIER:=}"
: "${BACKLOG_DEFAULT_AVAILABLE_CAP:=12}"

_picker_select_wave() {
  local queue_plan="$1" candidates="$2" free_slots="$3" in_flight_json="$4"
  local tasks_json input_json
  tasks_json=$(awk -F'|' 'NF >= 5 && $1 != "" {
    id = $1
    gsub(/"/, "\\\"", id)
    printf "{\"id\":\"%s\",\"score\":%s}\n", id, ($5 + 0)
  }' <<<"$candidates" | jq -s '.') || return 1
  input_json=$(jq -n \
    --argjson p "$queue_plan" \
    --argjson t "$tasks_json" \
    --argjson s "$free_slots" \
    --argjson f "$in_flight_json" \
    '{"mode": "launch-set", "plan": $p, "tasks": $t, "freeSlots": ($s | tonumber), "inFlight": $f}') || return 1
  printf '%s\n' "$input_json" | _with_timeout 10 wavemill_run_tool "select-wave.ts" 2>/dev/null
}

_picker_render_shared_file_reason() {
  # $1 = detail JSON object (conflicts_with_selected or conflicts_with_in_flight)
  # Prints the "holds: ..." reason line (without leading indentation).
  local detail_json="$1"
  local kind peer prnum first_file file_count extra
  kind=$(jq -r '.kind // ""' <<<"$detail_json" 2>/dev/null || echo "")
  peer=$(jq -r '.taskId // ""' <<<"$detail_json" 2>/dev/null || echo "")
  prnum=$(jq -r '.prNumber // empty' <<<"$detail_json" 2>/dev/null || echo "")
  file_count=$(jq -r '(.files // []) | length' <<<"$detail_json" 2>/dev/null || echo "0")
  first_file=""
  extra=""
  if (( file_count > 0 )); then
    first_file=$(jq -r '(.files // []) | sort | .[0]' <<<"$detail_json" 2>/dev/null || echo "")
    if (( file_count > 1 )); then
      extra=" (+$((file_count - 1)) more)"
    fi
  fi

  if [[ "$kind" == "conflicts_with_in_flight" ]]; then
    local suffix=""
    if [[ -n "$prnum" ]]; then
      suffix=" (PR #${prnum}, in flight)"
    else
      suffix=" (in flight)"
    fi
    if [[ -n "$first_file" ]]; then
      printf 'holds: shares %s%s with %s%s' "$first_file" "$extra" "$peer" "$suffix"
    else
      printf 'holds: conflicts with %s%s' "$peer" "$suffix"
    fi
    return 0
  fi

  # conflicts_with_selected (default)
  if [[ -n "$first_file" ]]; then
    printf 'holds: shares %s%s with %s' "$first_file" "$extra" "$peer"
  else
    printf 'holds: conflicts with %s' "$peer"
  fi
}

render_launch_set_picker() {
  local queue_plan="$1" available="$2"
  local free_slots="${3:-1}" in_flight_json="${4:-[]}" budget="${5:-999}"
  local expanded="${6:-false}" deps_expanded="${7:-false}"
  local active_issue_ids="${8:-}" include_header="${9:-true}"
  local counter=0 output="" select_lines="" line rec task_id title task_key
  local backlog_cap="${BACKLOG_DEFAULT_AVAILABLE_CAP:-12}"
  local tier=0 hidden_count=0 config_max=""
  local -a launch_entries=() launch_lines=() held_files_lines=() held_files_select=()
  local -a held_waiting_entries=() off_deck_queued=() unknown_lines=() unknown_select=()
  local -a triage_lines=() triage_select=()
  declare -A id_to_record=()
  declare -A rendered_ids=()
  declare -A on_deck_set=()
  declare -A held_reason_by_id=()
  declare -A held_detail_by_id=()
  declare -A operator_hold_note=()

  jq -e . >/dev/null 2>&1 <<<"$queue_plan" || return 1
  if ! [[ "$free_slots" =~ ^[0-9]+$ ]]; then
    free_slots=1
  fi
  if ! [[ "$budget" =~ ^[0-9]+$ ]]; then
    budget=999
  fi

  # Degraded-queue banner stays at the top of the body (HOK-3179).
  local _qh_banner
  _qh_banner="$(queue_inference_degraded_banner 2>/dev/null || true)"
  if [[ -n "$_qh_banner" ]]; then
    output+="${_qh_banner}"$'\n\n'
  fi

  if [[ -n "${REPO_DIR:-}" ]] && declare -F wavemill_load_config >/dev/null 2>&1; then
    backlog_cap="$(wavemill_load_config "$REPO_DIR" | jq -r '.backlog.defaultAvailableNowCap // 12' 2>/dev/null || printf '12')"
    config_max="$(wavemill_load_config "$REPO_DIR" | jq -r '.backlog.maxLines // empty' 2>/dev/null || true)"
  fi
  if ! [[ "$backlog_cap" =~ ^[0-9]+$ ]] || (( backlog_cap < 1 )); then
    backlog_cap=12
  fi

  # Index candidate records by id (and uppercase alias) for fast lookup.
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    task_id=${line%%|*}
    if [[ -n "$task_id" ]]; then
      id_to_record["$task_id"]="$line"
      task_key="$(printf '%s' "$task_id" | tr '[:lower:]' '[:upper:]')"
      id_to_record["$task_key"]="$line"
    fi
  done <<<"$available"

  # Invoke the launch-set selector. On failure, return 1 so the caller may
  # fall back to the legacy flat list.
  local launch_set_json=""
  launch_set_json="$(_picker_select_wave "$queue_plan" "$available" "$free_slots" "$in_flight_json" 2>/dev/null || true)"
  if [[ -z "$launch_set_json" ]] || ! jq -e . >/dev/null 2>&1 <<<"$launch_set_json"; then
    return 1
  fi

  # ── Section 1: Launch next ────────────────────────────────────────
  while IFS= read -r task_id; do
    [[ -n "$task_id" ]] || continue
    task_key="$(printf '%s' "$task_id" | tr '[:lower:]' '[:upper:]')"
    [[ -n "${rendered_ids[$task_key]:-}" ]] && continue
    rec="${id_to_record[$task_id]:-${id_to_record[$task_key]:-}}"
    [[ -n "$rec" ]] || continue
    launch_entries+=("$rec")
    rendered_ids["$task_key"]=1
  done < <(jq -r '.launchNext[]?' <<<"$launch_set_json" 2>/dev/null)

  # ── Section 2 inputs: Held entries ────────────────────────────────
  local held_json
  held_json="$(jq -c '.held // []' <<<"$launch_set_json" 2>/dev/null || echo '[]')"
  while IFS=$'\t' read -r hid hreason hdetail; do
    [[ -n "$hid" ]] || continue
    task_key="$(printf '%s' "$hid" | tr '[:lower:]' '[:upper:]')"
    held_reason_by_id["$task_key"]="$hreason"
    held_detail_by_id["$task_key"]="$hdetail"
  done < <(jq -r '.[] | [.id, .reason, (.detail | tojson)] | @tsv' <<<"$held_json" 2>/dev/null)

  # ── Section 3: Held: waiting on (depends_on from plan + held depends_on + operator_hold)
  # Build the dependency queue list, matching the behaviour of the legacy
  # on-deck / off-deck split keyed by active_issue_ids and the d toggle.
  local -a queued_entries=()
  while IFS=$'\t' read -r qid blockers; do
    [[ -n "$qid" ]] || continue
    task_key="$(printf '%s' "$qid" | tr '[:lower:]' '[:upper:]')"
    [[ -n "${rendered_ids[$task_key]:-}" ]] && continue
    rec="${id_to_record[$qid]:-${id_to_record[$task_key]:-}}"
    [[ -n "$rec" ]] || continue
    queued_entries+=("${rec}"$'\t'"${blockers}")
    rendered_ids["$task_key"]=1
  done < <(jq -r '.queuedAfterDependencies[]? | [.taskId, (.ancestors | join(", "))] | @tsv' <<<"$queue_plan" 2>/dev/null)

  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    local avail_id="${line%%|*}"
    [[ -n "$avail_id" ]] && on_deck_set["$(printf '%s' "$avail_id" | tr '[:lower:]' '[:upper:]')"]=1
  done <<<"$available"
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    on_deck_set["$(printf '%s' "$line" | tr '[:lower:]' '[:upper:]')"]=1
  done <<<"$active_issue_ids"

  local -a on_deck_queued=()
  for line in "${queued_entries[@]+"${queued_entries[@]}"}"; do
    IFS=$'\t' read -r rec blockers <<<"$line"
    local is_on_deck=true blocker bkey
    if [[ -z "$blockers" ]]; then
      is_on_deck=true
    else
      while IFS= read -r blocker; do
        [[ -n "$blocker" ]] || continue
        bkey="$(printf '%s' "${blocker// /}" | tr '[:lower:]' '[:upper:]')"
        if [[ -z "${on_deck_set[$bkey]:-}" ]]; then
          is_on_deck=false
          break
        fi
      done < <(printf '%s\n' "$blockers" | tr ',' '\n')
    fi
    if [[ "$is_on_deck" == "true" ]]; then
      on_deck_queued+=("$line")
    else
      off_deck_queued+=("$line")
    fi
  done
  local deps_hidden_count=${#off_deck_queued[@]}
  if [[ "$deps_expanded" == "true" ]]; then
    queued_entries=("${on_deck_queued[@]+"${on_deck_queued[@]}"}" "${off_deck_queued[@]+"${off_deck_queued[@]}"}")
  else
    queued_entries=("${on_deck_queued[@]+"${on_deck_queued[@]}"}")
  fi

  # Sort Launch next by score desc (score is field 5).
  if (( ${#launch_entries[@]} > 1 )); then
    local -a sorted_launch=()
    while IFS= read -r rec; do
      [[ -n "$rec" ]] && sorted_launch+=("$rec")
    done < <(printf '%s\n' "${launch_entries[@]}" | sort -t'|' -k5,5nr -k1,1)
    launch_entries=("${sorted_launch[@]}")
  fi
  if (( ${#queued_entries[@]} > 1 )); then
    local -a sorted_queued=()
    while IFS= read -r rec; do
      [[ -n "$rec" ]] && sorted_queued+=("$rec")
    done < <(printf '%s\n' "${queued_entries[@]}" | sort -t'|' -k5,5nr -k1,1)
    queued_entries=("${sorted_queued[@]}")
  fi

  # ── Section 2: Held: shares files (conflicts_with_selected + conflicts_with_in_flight)
  local -a shares_order=()
  while IFS= read -r hid; do
    [[ -n "$hid" ]] || continue
    task_key="$(printf '%s' "$hid" | tr '[:lower:]' '[:upper:]')"
    [[ -n "${rendered_ids[$task_key]:-}" ]] && continue
    local reason="${held_reason_by_id[$task_key]:-}"
    if [[ "$reason" == "conflicts_with_selected" || "$reason" == "conflicts_with_in_flight" ]]; then
      rec="${id_to_record[$hid]:-${id_to_record[$task_key]:-}}"
      [[ -n "$rec" ]] || continue
      shares_order+=("$rec")
      rendered_ids["$task_key"]=1
    fi
  done < <(jq -r '.[] | .id' <<<"$held_json" 2>/dev/null)

  # ── Section 4: Not yet analysed (touch_set_unknown)
  local -a unknown_entries=()
  while IFS= read -r hid; do
    [[ -n "$hid" ]] || continue
    task_key="$(printf '%s' "$hid" | tr '[:lower:]' '[:upper:]')"
    [[ -n "${rendered_ids[$task_key]:-}" ]] && continue
    local reason="${held_reason_by_id[$task_key]:-}"
    if [[ "$reason" == "touch_set_unknown" ]]; then
      rec="${id_to_record[$hid]:-${id_to_record[$task_key]:-}}"
      [[ -n "$rec" ]] || continue
      unknown_entries+=("$rec")
      rendered_ids["$task_key"]=1
    fi
  done < <(jq -r '.[] | .id' <<<"$held_json" 2>/dev/null)

  # ── Section 3 extras: operator_hold entries from held list (appended to queued) ──
  local -a operator_entries=()
  while IFS=$'\t' read -r hid hdetail; do
    [[ -n "$hid" ]] || continue
    task_key="$(printf '%s' "$hid" | tr '[:lower:]' '[:upper:]')"
    [[ -n "${rendered_ids[$task_key]:-}" ]] && continue
    rec="${id_to_record[$hid]:-${id_to_record[$task_key]:-}}"
    [[ -n "$rec" ]] || continue
    operator_entries+=("${rec}"$'\t'"${hdetail}")
    rendered_ids["$task_key"]=1
  done < <(jq -r '.[] | select(.reason == "operator_hold") | [.id, (.detail | tojson)] | @tsv' <<<"$held_json" 2>/dev/null)

  # ── Precompute section line counts for the height-budget tiering ──
  local launch_section_lines=0 shares_section_lines=0 waiting_section_lines=0 unknown_section_lines=0
  if (( ${#launch_entries[@]} > 0 )); then
    launch_section_lines=$((1 + ${#launch_entries[@]}))
  fi
  if (( ${#shares_order[@]} > 0 )); then
    shares_section_lines=$((1 + ${#shares_order[@]} * 2))
  fi
  if (( ${#queued_entries[@]} > 0 || ${#operator_entries[@]} > 0 )); then
    waiting_section_lines=$((1 + (${#queued_entries[@]} + ${#operator_entries[@]}) * 2))
  fi
  if (( ${#unknown_entries[@]} > 0 )); then
    unknown_section_lines=$((1 + ${#unknown_entries[@]} * 2))
  fi
  local total_lines=$((launch_section_lines + shares_section_lines + waiting_section_lines + unknown_section_lines))

  # ── Height-budget tiers: drop Not-yet-analysed, then Held:waiting, then
  #    Held:shares files, then truncate Launch next.
  if [[ "$expanded" != "true" ]] && (( total_lines > budget )); then
    if (( unknown_section_lines > 0 )); then
      hidden_count=$((hidden_count + ${#unknown_entries[@]}))
      unknown_entries=()
      unknown_section_lines=0
      tier=1
      total_lines=$((launch_section_lines + shares_section_lines + waiting_section_lines))
    fi
    if (( total_lines > budget )) && (( waiting_section_lines > 0 )); then
      local waiting_budget=$((budget - launch_section_lines - shares_section_lines - 1))
      local max_waiting=0
      if (( waiting_budget > 0 )); then
        max_waiting=$((waiting_budget / 2))
      fi
      local current_waiting=$(( ${#queued_entries[@]} + ${#operator_entries[@]} ))
      if (( max_waiting <= 0 )); then
        hidden_count=$((hidden_count + current_waiting))
        queued_entries=()
        operator_entries=()
        waiting_section_lines=0
        tier=2
      elif (( max_waiting < current_waiting )); then
        hidden_count=$((hidden_count + current_waiting - max_waiting))
        # Keep queued entries first; truncate operator_entries if the budget
        # still has room, otherwise truncate queued.
        local kept_queued=${#queued_entries[@]}
        local kept_operator=${#operator_entries[@]}
        if (( max_waiting <= kept_queued )); then
          kept_operator=0
          kept_queued=$max_waiting
        else
          kept_operator=$((max_waiting - kept_queued))
        fi
        queued_entries=("${queued_entries[@]:0:kept_queued}")
        operator_entries=("${operator_entries[@]:0:kept_operator}")
        waiting_section_lines=$((1 + max_waiting * 2))
        tier=2
      fi
      total_lines=$((launch_section_lines + shares_section_lines + waiting_section_lines))
    fi
    if (( total_lines > budget )) && (( shares_section_lines > 0 )); then
      local shares_budget=$((budget - launch_section_lines - 1))
      local max_shares=0
      if (( shares_budget > 0 )); then
        max_shares=$((shares_budget / 2))
      fi
      if (( max_shares <= 0 )); then
        hidden_count=$((hidden_count + ${#shares_order[@]}))
        shares_order=()
        shares_section_lines=0
        tier=3
      elif (( max_shares < ${#shares_order[@]} )); then
        hidden_count=$((hidden_count + ${#shares_order[@]} - max_shares))
        shares_order=("${shares_order[@]:0:max_shares}")
        shares_section_lines=$((1 + max_shares * 2))
        tier=3
      fi
      total_lines=$((launch_section_lines + shares_section_lines))
    fi
    if (( launch_section_lines > budget )); then
      tier=4
      local min_visible=$((budget - 1))
      (( min_visible < 10 )) && min_visible=10
      local available_limit=$min_visible
      if (( backlog_cap < available_limit )); then
        available_limit=$backlog_cap
      fi
      if (( available_limit > budget - 1 )); then
        available_limit=$((budget - 1))
      fi
      if (( ${#launch_entries[@]} > available_limit )); then
        hidden_count=$((hidden_count + ${#launch_entries[@]} - available_limit))
        launch_entries=("${launch_entries[@]:0:available_limit}")
      fi
    fi
  fi

  # ── Emit sections ─────────────────────────────────────────────────
  if [[ "$include_header" == "true" ]]; then
    if (( free_slots == 0 )); then
      output+="Next tasks (slots full):"$'\n'
    else
      output+="Next tasks:"$'\n'
    fi
  fi

  if (( ${#launch_entries[@]} > 0 )); then
    output+="Launch next (safe together, ${free_slots} slots free)"$'\n'
    for rec in "${launch_entries[@]}"; do
      IFS='|' read -r task_id _slug title _area _score _blocked <<<"$rec"
      counter=$((counter + 1))
      output+="$(printf '  %s. %s - %s' "$counter" "$task_id" "$title")"$'\n'
      select_lines+="${rec}"$'\n'
    done
  fi

  if (( ${#shares_order[@]} > 0 )); then
    [[ -n "$output" ]] && output+=$'\n'
    output+="Held: shares files"$'\n'
    for rec in "${shares_order[@]}"; do
      IFS='|' read -r task_id _slug title _area _score _blocked <<<"$rec"
      task_key="$(printf '%s' "$task_id" | tr '[:lower:]' '[:upper:]')"
      local detail="${held_detail_by_id[$task_key]:-}"
      counter=$((counter + 1))
      output+="$(printf '  %s. %s - %s' "$counter" "$task_id" "$title")"$'\n'
      local reason_line
      reason_line="$(_picker_render_shared_file_reason "$detail")"
      output+="     $reason_line"$'\n'
      select_lines+="${rec}"$'\n'
    done
  fi

  if (( ${#queued_entries[@]} > 0 || ${#operator_entries[@]} > 0 )); then
    [[ -n "$output" ]] && output+=$'\n'
    output+="Held: waiting on"$'\n'
    for line in "${queued_entries[@]+"${queued_entries[@]}"}"; do
      IFS=$'\t' read -r rec blockers <<<"$line"
      IFS='|' read -r task_id _slug title _area _score _blocked <<<"$rec"
      counter=$((counter + 1))
      output+="$(printf '  %s. %s - %s' "$counter" "$task_id" "$title")"$'\n'
      output+="$(printf '     blocked by: %s' "$blockers")"$'\n'
      select_lines+="${rec}"$'\n'
    done
    for line in "${operator_entries[@]+"${operator_entries[@]}"}"; do
      IFS=$'\t' read -r rec detail <<<"$line"
      IFS='|' read -r task_id _slug title _area _score _blocked <<<"$rec"
      counter=$((counter + 1))
      output+="$(printf '  %s. %s - %s' "$counter" "$task_id" "$title")"$'\n'
      local note
      note=$(jq -r '.note // ""' <<<"$detail" 2>/dev/null || echo "")
      if [[ -n "$note" ]]; then
        output+="     holds: operator — $note"$'\n'
      else
        output+="     holds: operator"$'\n'
      fi
      select_lines+="${rec}"$'\n'
    done
    if [[ "$deps_expanded" != "true" ]] && (( deps_hidden_count > 0 )); then
      output+="$(printf '  +%s hidden - d to expand' "$deps_hidden_count")"$'\n'
    elif [[ "$deps_expanded" == "true" ]] && (( deps_hidden_count > 0 )); then
      output+="  (d to collapse)"$'\n'
    fi
  fi

  if (( ${#unknown_entries[@]} > 0 )); then
    [[ -n "$output" ]] && output+=$'\n'
    output+="Not yet analysed"$'\n'
    for rec in "${unknown_entries[@]}"; do
      IFS='|' read -r task_id _slug title _area _score _blocked <<<"$rec"
      counter=$((counter + 1))
      output+="$(printf '  %s. %s - %s' "$counter" "$task_id" "$title")"$'\n'
      output+="     holds: scoring not yet available"$'\n'
      select_lines+="${rec}"$'\n'
    done
  fi

  # Needs Triage section (unchanged behaviour, numbered after Not yet analysed).
  local triage_body="" triage_id
  while IFS= read -r triage_id; do
    [[ -n "$triage_id" ]] || continue
    task_key="$(printf '%s' "$triage_id" | tr '[:lower:]' '[:upper:]')"
    [[ -n "${rendered_ids[$task_key]:-}" ]] && continue
    rec="${id_to_record[$triage_id]:-${id_to_record[$task_key]:-}}"
    [[ -n "$rec" ]] || continue
    IFS='|' read -r task_id _slug title _area _score _blocked <<<"$rec"
    counter=$((counter + 1))
    triage_body+="$(printf '  %s. %s - %s [triage]' "$counter" "$task_id" "$title")"$'\n'
    select_lines+="${rec}"$'\n'
    rendered_ids["$task_key"]=1
  done < <(jq -r '.needsTriage[]? | .edge.to' <<<"$queue_plan" 2>/dev/null)
  if [[ -n "$triage_body" ]]; then
    [[ -n "$output" ]] && output+=$'\n'
    output+="Needs Triage"$'\n'
    output+="${triage_body}"
  fi

  if [[ "$expanded" != "true" ]] && (( tier > 0 )) && (( hidden_count > 0 )); then
    output+="$(printf '... %s tasks hidden (m to expand)' "$hidden_count")"$'\n'
  elif [[ "$expanded" == "true" ]] && (( total_lines > budget )); then
    output+="(m to collapse)"$'\n'
  fi

  (( counter > 0 )) || return 1

  if [[ "$tier" != "${BACKLOG_LAST_TIER:-}" ]] && declare -F log >/dev/null 2>&1; then
    local backlog_annotation=" (backlog.maxLines=${config_max:-auto})"
    if declare -F wavemill_config_annotation >/dev/null 2>&1; then
      backlog_annotation="$(wavemill_config_annotation "backlog.maxLines" "${config_max:-auto}")"
    fi
    log "info" "[backlog] tier=$tier budget=$budget${backlog_annotation}"
    BACKLOG_LAST_TIER="$tier"
  fi

  GROUPED_SELECT_FROM="${select_lines%$'\n'}"
  GROUPED_DISPLAY="${output%$'\n'}"
}
