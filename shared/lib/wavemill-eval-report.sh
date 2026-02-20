#!/usr/bin/env bash
set -euo pipefail

# Wavemill Eval Report - Aggregate statistics from persisted eval records
#
# Reads JSONL eval records and outputs:
#   - Overall average score
#   - Per-model average scores
#   - Score distribution histogram
#   - Worst-performing tasks
#   - Trend over time (weekly averages)
#
# Usage: wavemill-eval-report.sh [options]
#   --from YYYY-MM-DD   Filter records after this date (inclusive)
#   --to YYYY-MM-DD     Filter records before this date (inclusive)
#   --model MODEL       Filter to a specific model
#   --min-records N     Suppress models with fewer than N records (default: 1)
#   --limit N           Number of worst-performing tasks to show (default: 5)
#   --json              Output all computed data as JSON

# ============================================================================
# CONFIGURATION
# ============================================================================

REPO_DIR="${REPO_DIR:-$PWD}"

# Colors
CYAN=$'\033[0;36m'
GREEN=$'\033[0;32m'
YELLOW=$'\033[1;33m'
RED=$'\033[0;31m'
BOLD=$'\033[1m'
DIM=$'\033[2m'
NC=$'\033[0m'

SEPARATOR="$(printf '%.0s═' {1..59})"
LINE="$(printf '%.0s─' {1..55})"

# Defaults
FROM_DATE=""
TO_DATE=""
MODEL_FILTER=""
MIN_RECORDS=1
LIMIT=5
JSON_OUTPUT=false

# ============================================================================
# ARGUMENT PARSING
# ============================================================================

show_report_help() {
  cat <<EOF
${CYAN}Wavemill Eval Report${NC} - Aggregate eval statistics

${GREEN}Usage:${NC}
  wavemill eval report [options]

${GREEN}Options:${NC}
  ${CYAN}--from YYYY-MM-DD${NC}    Include records from this date (inclusive)
  ${CYAN}--to YYYY-MM-DD${NC}      Include records up to this date (inclusive)
  ${CYAN}--model MODEL${NC}        Filter to a specific model identifier
  ${CYAN}--min-records N${NC}      Min records for per-model display (default: 1)
  ${CYAN}--limit N${NC}            Worst-performing tasks to show (default: 5)
  ${CYAN}--json${NC}               Output all computed data as a JSON object
  ${CYAN}--help, -h${NC}           Show this help message

${GREEN}Examples:${NC}
  wavemill eval report
  wavemill eval report --model claude-opus-4-6
  wavemill eval report --from 2026-01-01 --to 2026-02-15
  wavemill eval report --json | jq .overall_average

EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --from)
      FROM_DATE="$2"
      shift 2
      ;;
    --to)
      TO_DATE="$2"
      shift 2
      ;;
    --model)
      MODEL_FILTER="$2"
      shift 2
      ;;
    --min-records)
      MIN_RECORDS="$2"
      shift 2
      ;;
    --limit)
      LIMIT="$2"
      shift 2
      ;;
    --json)
      JSON_OUTPUT=true
      shift
      ;;
    --help|-h)
      show_report_help
      exit 0
      ;;
    *)
      echo "${RED}Error:${NC} Unknown option: $1" >&2
      echo ""
      show_report_help >&2
      exit 1
      ;;
  esac
done

# ============================================================================
# RESOLVE EVALS FILE
# ============================================================================

resolve_evals_file() {
  local evals_dir=".wavemill/evals"

  # Check per-repo config for custom evals dir
  if [[ -f "$REPO_DIR/.wavemill-config.json" ]]; then
    local custom_dir
    custom_dir=$(jq -r '.eval.evalsDir // empty' "$REPO_DIR/.wavemill-config.json" 2>/dev/null || true)
    if [[ -n "$custom_dir" ]]; then
      evals_dir="$custom_dir"
    fi
  fi

  # Resolve relative to repo dir
  if [[ "$evals_dir" != /* ]]; then
    evals_dir="$REPO_DIR/$evals_dir"
  fi

  echo "$evals_dir/evals.jsonl"
}

EVALS_FILE="$(resolve_evals_file)"

# ============================================================================
# LOAD AND FILTER RECORDS
# ============================================================================

load_filtered_records() {
  if [[ ! -f "$EVALS_FILE" ]]; then
    echo "[]"
    return
  fi

  # Build jq filter for date range and model
  local jq_filter='.'

  if [[ -n "$MODEL_FILTER" ]]; then
    jq_filter="${jq_filter} | select((.agentType // .modelId) == \$model_f)"
  fi

  if [[ -n "$FROM_DATE" ]]; then
    jq_filter="${jq_filter} | select(.timestamp >= \$from_d)"
  fi

  if [[ -n "$TO_DATE" ]]; then
    jq_filter="${jq_filter} | select(.timestamp <= \$to_d)"
  fi

  # Read JSONL, filter, collect into array
  jq -s \
    --arg model_f "$MODEL_FILTER" \
    --arg from_d "${FROM_DATE}T00:00:00" \
    --arg to_d "${TO_DATE}T23:59:59" \
    "[.[] | ${jq_filter}]" "$EVALS_FILE" 2>/dev/null || echo "[]"
}

RECORDS_JSON="$(load_filtered_records)"
RECORD_COUNT=$(echo "$RECORDS_JSON" | jq 'length')

# ============================================================================
# HANDLE EMPTY RESULTS
# ============================================================================

if [[ "$RECORD_COUNT" -eq 0 ]]; then
  if [[ "$JSON_OUTPUT" == "true" ]]; then
    jq -n \
      --arg from "$FROM_DATE" \
      --arg to "$TO_DATE" \
      --arg model "$MODEL_FILTER" \
      '{
        record_count: 0,
        overall_average: null,
        total_cost: null,
        avg_cost: null,
        per_model: [],
        distribution: {},
        worst_tasks: [],
        trends: [],
        filters: {
          from: (if $from == "" then null else $from end),
          to: (if $to == "" then null else $to end),
          model: (if $model == "" then null else $model end)
        }
      }'
    exit 0
  fi

  echo ""
  echo "${YELLOW}No eval records found.${NC}"
  if [[ -n "$MODEL_FILTER" || -n "$FROM_DATE" || -n "$TO_DATE" ]]; then
    echo "${DIM}  Filters applied:${NC}"
    [[ -n "$MODEL_FILTER" ]] && echo "${DIM}    --model $MODEL_FILTER${NC}"
    [[ -n "$FROM_DATE" ]] && echo "${DIM}    --from $FROM_DATE${NC}"
    [[ -n "$TO_DATE" ]] && echo "${DIM}    --to $TO_DATE${NC}"
  fi
  if [[ ! -f "$EVALS_FILE" ]]; then
    echo "${DIM}  Evals file not found: $EVALS_FILE${NC}"
    echo "${DIM}  Run 'wavemill eval' to generate eval records.${NC}"
  fi
  echo ""
  exit 0
fi

# ============================================================================
# COMPUTE AGGREGATIONS (single jq call)
# ============================================================================

REPORT_JSON=$(echo "$RECORDS_JSON" | jq \
  --argjson min_records "$MIN_RECORDS" \
  --argjson limit "$LIMIT" \
'
  (map(.score) | add / length) as $overall_avg |

  # Overall cost stats (prefer workflowCost, fall back to estimatedCost)
  ([.[] | select(.workflowCost != null) | .workflowCost] +
   [.[] | select(.workflowCost == null and .estimatedCost != null) | .estimatedCost]) as $costs |
  (if ($costs | length) > 0 then ($costs | add) else null end) as $total_cost |
  (if ($costs | length) > 0 then ($costs | add / length) else null end) as $avg_cost |

  # Per-agent averages (use agentType when set, fall back to modelId)
  (group_by(.agentType // .modelId)
   | map({
       model: (.[0].agentType // .[0].modelId),
       count: length,
       avg: (map(.score) | add / length),
       min: (map(.score) | min),
       max: (map(.score) | max),
       avg_cost: (
         ([.[] | select(.workflowCost != null) | .workflowCost] +
          [.[] | select(.workflowCost == null and .estimatedCost != null) | .estimatedCost]) |
         if length > 0 then (add / length) else null end
       ),
       cost_per_score_point: (
         (([.[] | select(.workflowCost != null) | .workflowCost] +
           [.[] | select(.workflowCost == null and .estimatedCost != null) | .estimatedCost]) | if length > 0 then (add / length) else null end) as $ac |
         (map(.score) | add / length) as $as |
         if $ac != null and $as > 0 then ($ac / $as) else null end
       )
     })
   | sort_by(-.avg)
  ) as $per_model |

  # Filtered per-model (respecting --min-records)
  ($per_model | map(select(.count >= $min_records))) as $per_model_filtered |

  # Score distribution (5 buckets matching scoreBand ranges)
  {
    "Failure (0.0-0.1)": [.[] | select(.score <= 0.1)] | length,
    "Partial (0.2-0.4)": [.[] | select(.score > 0.1 and .score <= 0.4)] | length,
    "Assisted (0.5-0.7)": [.[] | select(.score > 0.4 and .score <= 0.7)] | length,
    "Minor FB (0.8-0.9)": [.[] | select(.score > 0.7 and .score < 1.0)] | length,
    "Full Success (1.0)": [.[] | select(.score == 1.0)] | length
  } as $distribution |

  # Worst-performing tasks
  (sort_by(.score)
   | .[0:$limit]
   | map({
       issueId: (.issueId // "n/a"),
       model: (.agentType // .modelId),
       score: .score,
       scoreBand: .scoreBand,
       date: (.timestamp | split("T")[0]),
       rationale: (.rationale | if length > 72 then .[0:69] + "..." else . end)
     })
  ) as $worst |

  # Trend over time (weekly averages using ISO week)
  (group_by(
      .timestamp | split("T")[0] |
      strptime("%Y-%m-%d") | mktime | strftime("%G-W%V")
    )
   | map({
       period: (.[0].timestamp | split("T")[0] |
         strptime("%Y-%m-%d") | mktime | strftime("%G-W%V")),
       count: length,
       avg: (map(.score) | add / length)
     })
   | sort_by(.period)
  ) as $trends |

  {
    record_count: length,
    overall_average: ($overall_avg * 100 | round / 100),
    total_cost: $total_cost,
    avg_cost: (if $avg_cost != null then ($avg_cost * 10000 | round / 10000) else null end),
    per_model: $per_model_filtered,
    per_model_all: $per_model,
    distribution: $distribution,
    worst_tasks: $worst,
    trends: $trends
  }
')

# ============================================================================
# JSON OUTPUT MODE
# ============================================================================

if [[ "$JSON_OUTPUT" == "true" ]]; then
  echo "$REPORT_JSON" | jq \
    --arg from "$FROM_DATE" \
    --arg to "$TO_DATE" \
    --arg model "$MODEL_FILTER" \
    '. + {
      filters: {
        from: (if $from == "" then null else $from end),
        to: (if $to == "" then null else $to end),
        model: (if $model == "" then null else $model end)
      }
    } | del(.per_model_all)'
  exit 0
fi

# ============================================================================
# TERMINAL OUTPUT HELPERS
# ============================================================================

score_color() {
  local score="$1"
  if awk "BEGIN {exit !($score >= 0.8)}" 2>/dev/null; then
    printf '%s' "$GREEN"
  elif awk "BEGIN {exit !($score >= 0.5)}" 2>/dev/null; then
    printf '%s' "$YELLOW"
  else
    printf '%s' "$RED"
  fi
}

make_bar() {
  local filled="$1"
  local total="$2"
  local bar=""
  local i
  for ((i = 0; i < filled; i++)); do bar+=$'\xe2\x96\x88'; done
  for ((i = filled; i < total; i++)); do bar+=$'\xe2\x96\x91'; done
  echo "$bar"
}

# ============================================================================
# TERMINAL OUTPUT
# ============================================================================

OVERALL_AVG=$(echo "$REPORT_JSON" | jq -r '.overall_average')
TOTAL_COST=$(echo "$REPORT_JSON" | jq -r '.total_cost // "null"')
AVG_COST=$(echo "$REPORT_JSON" | jq -r '.avg_cost // "null"')

echo ""
echo "${BOLD}${CYAN}${SEPARATOR}${NC}"
echo "${BOLD}${CYAN}  EVAL REPORT${NC}"
echo "${BOLD}${CYAN}${SEPARATOR}${NC}"
echo ""

# Filters
if [[ -n "$MODEL_FILTER" || -n "$FROM_DATE" || -n "$TO_DATE" ]]; then
  printf '  %sFilters:%s' "$DIM" "$NC"
  [[ -n "$MODEL_FILTER" ]] && printf ' model=%s' "$MODEL_FILTER"
  [[ -n "$FROM_DATE" ]] && printf ' from=%s' "$FROM_DATE"
  [[ -n "$TO_DATE" ]] && printf ' to=%s' "$TO_DATE"
  echo ""
fi

# Record count and overall average
SC_COLOR=$(score_color "$OVERALL_AVG")
echo "  ${DIM}Records:${NC} ${RECORD_COUNT}"
echo "  ${BOLD}Overall Average:${NC} ${SC_COLOR}${OVERALL_AVG}${NC}"
if [[ "$TOTAL_COST" != "null" ]]; then
  TOTAL_COST_FMT=$(printf "%.4f" "$TOTAL_COST")
  AVG_COST_FMT=$(printf "%.4f" "$AVG_COST")
  echo "  ${DIM}Total Workflow Cost:${NC} \$${TOTAL_COST_FMT}  ${DIM}Avg Cost/Eval:${NC} \$${AVG_COST_FMT}"
fi
echo ""

# ── Per-Model Averages ─────────────────────────────────────────────────────

echo "  ${BOLD}Per-Agent Averages${NC}"
echo "  ${DIM}${LINE}${NC}"

echo "$REPORT_JSON" | jq -r '
  .per_model[] |
  "\(.model)|\(.avg)|\(.count)|\(.min)|\(.max)|\(.avg_cost // "null")|\(.cost_per_score_point // "null")"
' | \
while IFS='|' read -r model avg count min_s max_s avg_cost cost_per_sp; do
  avg_fmt=$(printf "%.2f" "$avg")
  min_fmt=$(printf "%.2f" "$min_s")
  max_fmt=$(printf "%.2f" "$max_s")
  color=$(score_color "$avg")
  filled=$(awk "BEGIN {printf \"%d\", $avg * 10}")
  bar=$(make_bar "$filled" 10)

  cost_str=""
  if [[ "$avg_cost" != "null" ]]; then
    cost_fmt=$(printf "%.4f" "$avg_cost")
    cpsp_fmt=$(printf "%.4f" "$cost_per_sp")
    cost_str="  ${DIM}\$${cost_fmt}/eval, \$${cpsp_fmt}/score-pt${NC}"
  fi

  printf "  %-28s %s%s%s %s %s(n=%s, %s-%s)%s%s\n" \
    "$model" "$color" "$avg_fmt" "$NC" "$bar" \
    "$DIM" "$count" "$min_fmt" "$max_fmt" "$NC" "$cost_str"
done
echo ""

# ── Score Distribution ─────────────────────────────────────────────────────

echo "  ${BOLD}Score Distribution${NC}"
echo "  ${DIM}${LINE}${NC}"

MAX_BUCKET=$(echo "$REPORT_JSON" | jq '[.distribution[]] | max')

echo "$REPORT_JSON" | jq -r '
  .distribution | to_entries[] | "\(.key)|\(.value)"
' | \
while IFS='|' read -r bucket count; do
  if [[ "$MAX_BUCKET" -gt 0 ]]; then
    bar_len=$(awk "BEGIN {printf \"%d\", ($count / $MAX_BUCKET) * 25}")
  else
    bar_len=0
  fi

  bar=""
  local_i=0
  while [[ $local_i -lt $bar_len ]]; do
    bar+=$'\xe2\x96\x88'
    local_i=$((local_i + 1))
  done

  case "$bucket" in
    Failure*)   color="$RED" ;;
    Partial*)   color="$RED" ;;
    Assisted*)  color="$YELLOW" ;;
    Minor*)     color="$GREEN" ;;
    Full*)      color="$GREEN" ;;
    *)          color="$NC" ;;
  esac

  printf "  %-22s %3d %s%s%s\n" "$bucket" "$count" "$color" "$bar" "$NC"
done
echo ""

# ── Worst-Performing Tasks ─────────────────────────────────────────────────

echo "  ${BOLD}Worst-Performing Tasks${NC} (bottom ${LIMIT})"
echo "  ${DIM}${LINE}${NC}"

echo "$REPORT_JSON" | jq -r '
  .worst_tasks[] |
  "\(.issueId)|\(.model)|\(.score)|\(.date)|\(.rationale)"
' | \
while IFS='|' read -r issue model score date rationale; do
  score_fmt=$(printf "%.2f" "$score")
  color=$(score_color "$score")

  model_short="$model"
  if [[ ${#model_short} -gt 20 ]]; then
    model_short="${model_short:0:17}..."
  fi

  printf "  %s%s%s  %-8s  %-20s  %s\n" \
    "$color" "$score_fmt" "$NC" "$issue" "$model_short" "$date"
  if [[ -n "$rationale" ]]; then
    printf "  %s  %s%s\n" "$DIM" "$rationale" "$NC"
  fi
done
echo ""

# ── Trend Over Time ────────────────────────────────────────────────────────

TREND_COUNT=$(echo "$REPORT_JSON" | jq '.trends | length')

if [[ "$TREND_COUNT" -gt 0 ]]; then
  echo "  ${BOLD}Trend Over Time${NC} (weekly)"
  echo "  ${DIM}${LINE}${NC}"

  echo "$REPORT_JSON" | jq -r '
    .trends[] | "\(.period)|\(.avg)|\(.count)"
  ' | \
  while IFS='|' read -r period avg count; do
    avg_fmt=$(printf "%.2f" "$avg")
    color=$(score_color "$avg")
    filled=$(awk "BEGIN {printf \"%d\", $avg * 20}")
    bar=$(make_bar "$filled" 20)

    printf "  %-10s %s%s%s %s %s(n=%s)%s\n" \
      "$period" "$color" "$avg_fmt" "$NC" "$bar" \
      "$DIM" "$count" "$NC"
  done
  echo ""
fi

echo "${BOLD}${CYAN}${SEPARATOR}${NC}"
echo ""
