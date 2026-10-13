#!/usr/bin/env bash
# Deterministic `gh` stand-in for the HOK-3206 tests. Install by copying or
# symlinking as `gh` on PATH. Every invocation appends its argv to
# $MOCK_GH_LOG (one line), so tests can count GitHub calls per pass.
#
#   gh pr list ... --search 'head:a head:b'  -> rows of $MOCK_GH_PRS whose
#                                               headRefName is searched
#   gh pr list ... (no search)               -> OPEN rows of $MOCK_GH_PRS
#   gh pr list --head <b> ...                -> rows for <b>
#   gh pr view <n> ...                       -> row <n> (exit 1 if absent)
#   gh repo view ...                         -> {"nameWithOwner": $MOCK_GH_NWO}
#   gh api .../protection/required_status_checks -> $MOCK_GH_REQUIRED (JSON array)
#
# $MOCK_GH_FAIL_SEARCH=1 makes the --search form fail (fallback path).

set -euo pipefail
printf '%s\n' "$*" >> "${MOCK_GH_LOG:?MOCK_GH_LOG must be set}"
rows="${MOCK_GH_PRS:?MOCK_GH_PRS must be set}"

flag_value() {
  local name="$1"; shift
  while (( $# > 0 )); do
    if [[ "$1" == "$name" ]]; then printf '%s' "${2:-}"; return 0; fi
    shift
  done
}

case "${1:-} ${2:-}" in
  "pr list")
    search="$(flag_value --search "$@")"
    head="$(flag_value --head "$@")"
    if [[ -n "$search" ]]; then
      [[ "${MOCK_GH_FAIL_SEARCH:-0}" == "1" ]] && { echo "search unavailable" >&2; exit 1; }
      jq -c --arg s " $search " 'map(select(.headRefName as $h | $s | contains(" head:" + $h + " ")))' "$rows"
    elif [[ -n "$head" ]]; then
      jq -c --arg b "$head" 'map(select(.headRefName == $b))' "$rows"
    else
      jq -c 'map(select(.state == "OPEN"))' "$rows"
    fi
    ;;
  "pr view")
    row="$(jq -c --argjson n "$3" 'map(select(.number == $n)) | .[0] // empty' "$rows")"
    [[ -n "$row" ]] || { echo "no pull requests found" >&2; exit 1; }
    jq_expr="$(flag_value --jq "$@")"
    if [[ -n "$jq_expr" ]]; then jq -r "$jq_expr" <<<"$row"; else printf '%s\n' "$row"; fi
    ;;
  "repo view")
    jq_expr="$(flag_value --jq "$@")"
    payload="$(jq -cn --arg n "${MOCK_GH_NWO:-acme/widgets}" '{nameWithOwner: $n, defaultBranchRef: {name: "main"}}')"
    if [[ -n "$jq_expr" ]]; then jq -r "$jq_expr" <<<"$payload"; else printf '%s\n' "$payload"; fi
    ;;
  api\ *)
    printf '%s\n' "${MOCK_GH_REQUIRED:-[]}"
    ;;
  *)
    echo "mock gh: unsupported: $*" >&2
    exit 1
    ;;
esac
