#!/usr/bin/env bash
# HOK-3208: incident records under .wavemill/incidents/{cleanup-decisions,
# preserved-branches}/ must stay writable for long task branches. The atomic
# temp name (".<record>.XXXXXX") used to exceed the 255-byte filename limit
# for long issue-title slugs, so the cleanup authority record never persisted
# and the arm stayed retained forever.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COMMON_SCRIPT="$REPO_ROOT/shared/lib/wavemill-common.sh"

extract_function() {
  local source_file="$1"
  local function_name="$2"
  awk -v name="$function_name" '
    function brace_delta(line, stripped, opens, closes) {
      stripped = line
      gsub(/"([^"\\]|\\.)*"/, "\"\"", stripped)
      gsub(/\047([^\047\\]|\\.)*\047/, "\047\047", stripped)
      opens = gsub(/\{/, "{", stripped)
      closes = gsub(/\}/, "}", stripped)
      return opens - closes
    }
    $0 ~ "^" name "\\(\\)[[:space:]]*\\{" {
      capture = 1
      depth = 0
    }
    capture {
      print
      depth += brace_delta($0)
      if (depth == 0) exit
    }
  ' "$source_file"
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

helper_file="$tmp/record-helper.sh"
{
  extract_function "$COMMON_SCRIPT" "_wavemill_incident_record_name"
  printf '\n'
  extract_function "$COMMON_SCRIPT" "_wavemill_write_preserved_branch_incident"
} > "$helper_file"
# shellcheck source=/dev/null
source "$helper_file"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

byte_len() {
  printf '%s' "$1" | LC_ALL=C wc -c | tr -d ' '
}

# Build a branch of exactly <len> bytes: "task/" + repeated slug text.
branch_of_len() {
  local len="$1" body
  body="$(printf 'challenge-pair-routes-drift-after-sealing-post-expansion-re-routing-%.0s' 1 2 3 4 5)"
  printf 'task/%s' "${body:0:$((len - 5))}"
}

records_in() {
  find "$1" -maxdepth 1 -type f -name '*.json' ! -name '.*' | sort
}

write_record() {
  local branch="$1" subdir="${2:-preserved-branches}"
  _wavemill_write_preserved_branch_incident "test_reason" "$branch" "/tmp/wt" "auto/integration" \
    "0" "" "test" "" "" "" "" '{"classification":"safe_ancestor"}' "$subdir"
}

STATE_FILE=""
unset CLEANUP_EPISODE_CURRENT_FINGERPRINT

# --- name helper -----------------------------------------------------------

# Short branches keep the legacy name byte-for-byte (no migration needed).
[[ "$(_wavemill_incident_record_name "task/short-slug")" == "task__short-slug.json" ]] \
  || fail "short branch did not keep legacy name"

# Boundary: a 200-byte legacy name is kept; 201 bytes switches to the hashed form.
# legacy = branch with "/"→"__" (+1 byte) + ".json" (+5 bytes).
b194="$(branch_of_len 194)"
b195="$(branch_of_len 195)"
name194="$(_wavemill_incident_record_name "$b194")"
name195="$(_wavemill_incident_record_name "$b195")"
[[ "$(byte_len "$name194")" == "200" ]] || fail "boundary fixture: expected 200-byte legacy name, got $(byte_len "$name194")"
[[ "$name194" == "${b194//\//__}.json" ]] || fail "200-byte legacy name was hashed"
[[ "$name195" != "${b195//\//__}.json" ]] || fail "201-byte legacy name was not hashed"
[[ "$name195" =~ ^task__[a-z-]+__[0-9a-f]{12}\.json$ ]] || fail "hashed name has unexpected shape: $name195"

# Hashed names are deterministic, bounded, and disambiguate a shared prefix.
long_a="$(branch_of_len 260)"
long_b="${long_a:0:259}x"
name_a="$(_wavemill_incident_record_name "$long_a")"
[[ "$name_a" == "$(_wavemill_incident_record_name "$long_a")" ]] || fail "hashed name is not deterministic"
[[ "$name_a" != "$(_wavemill_incident_record_name "$long_b")" ]] || fail "branches sharing a 100-byte prefix collided"
(( $(byte_len "$name_a") <= 247 )) || fail "hashed name exceeds 247 bytes: $name_a"
[[ "$name_a" == "${long_a//\//__}"* ]] && fail "hashed name kept the full branch"
[[ "${name_a:0:100}" == "$(printf '%s' "${long_a//\//__}" | cut -c1-100)" ]] || fail "hashed name lost its readable prefix"

# Byte (not code-point) semantics: a multibyte branch must still be bounded.
multibyte="task/$(printf 'é%.0s' $(seq 1 120))"
name_mb="$(LC_ALL=en_US.UTF-8 _wavemill_incident_record_name "$multibyte")"
[[ "$name_mb" =~ ^task__[_]+__[0-9a-f]{12}\.json$ ]] || fail "multibyte hashed prefix not ASCII-sanitized: $name_mb"
(( $(byte_len "$name_mb") <= 247 )) || fail "multibyte branch name exceeds 247 bytes: $(byte_len "$name_mb")"

# Fails closed when no sha1 tool is available.
if (PATH="$tmp/empty-path" _wavemill_incident_record_name "$long_a" >/dev/null 2>&1); then
  fail "name helper succeeded without a sha1 tool"
fi

# --- writer -----------------------------------------------------------------

REPO_DIR="$tmp/repo"
mkdir -p "$REPO_DIR/.wavemill/incidents"

# The HOK-3156_c branch shape: long slug plus the challenger suffix.
hok3156="task/$(printf 'challenge-pair-routes-drift-after-sealing-post-expansion-re-routing-%.0s' 1 2 3 4)"
hok3156="${hok3156:0:239}-challenger"
[[ "$(byte_len "$hok3156")" == "250" ]] || fail "fixture: expected 250-byte branch"

for subdir in cleanup-decisions preserved-branches; do
  dir="$REPO_DIR/.wavemill/incidents/$subdir"
  write_record "$hok3156" "$subdir" || fail "$subdir: writer failed for a 250-byte branch"
  mapfile -t files < <(records_in "$dir")
  (( ${#files[@]} == 1 )) || fail "$subdir: expected 1 record, got ${#files[@]}"
  (( $(byte_len "$(basename "${files[0]}")") <= 247 )) || fail "$subdir: record name too long"
  [[ "$(jq -r '.branch' "${files[0]}")" == "$hok3156" ]] || fail "$subdir: full branch not kept in body"
  [[ "$(jq -r '.classification' "${files[0]}")" == "safe_ancestor" ]] || fail "$subdir: extras not merged"

  # Idempotent re-write lands on the same file and leaves no temp files.
  write_record "$hok3156" "$subdir" || fail "$subdir: re-write failed"
  mapfile -t files < <(records_in "$dir")
  (( ${#files[@]} == 1 )) || fail "$subdir: re-write produced ${#files[@]} records"
  compgen -G "$dir/.*.json.*" >/dev/null && fail "$subdir: temp file left behind"
done

# Short branches still produce (and overwrite) the legacy record path.
write_record "task/short-slug" || fail "writer failed for a short branch"
[[ -f "$REPO_DIR/.wavemill/incidents/preserved-branches/task__short-slug.json" ]] \
  || fail "short branch record not at legacy path"
[[ "$(jq -r '.branch' "$REPO_DIR/.wavemill/incidents/preserved-branches/task__short-slug.json")" == "task/short-slug" ]] \
  || fail "short branch record body mismatch"

echo "preserved-branch-record-long-slug test passed"
