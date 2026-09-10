#!/bin/bash
# Tests for transient marker helpers

set -euo pipefail

# Source the marker helpers
source shared/lib/transient-marker.sh

# Test helpers
pass_count=0
fail_count=0

test_case() {
  local name="$1"
  local func="$2"

  echo -n "Testing: $name ... "
  if $func; then
    echo "PASS"
    pass_count=$((pass_count + 1))
  else
    echo "FAIL"
    fail_count=$((fail_count + 1))
  fi
}

assert_equal() {
  local expected="$1"
  local actual="$2"
  local msg="${3:-}"

  if [[ "$expected" != "$actual" ]]; then
    echo "Assertion failed: expected '$expected', got '$actual'" >&2
    if [[ -n "$msg" ]]; then
      echo "  $msg" >&2
    fi
    return 1
  fi
}

assert_file_exists() {
  local path="$1"
  if [[ ! -f "$path" ]]; then
    echo "Assertion failed: file does not exist: $path" >&2
    return 1
  fi
}

assert_file_not_exists() {
  local path="$1"
  if [[ -f "$path" ]]; then
    echo "Assertion failed: file exists but shouldn't: $path" >&2
    return 1
  fi
}

assert_exit_code() {
  local expected="$1"
  local actual="$2"
  local msg="${3:-}"

  if [[ "$expected" != "$actual" ]]; then
    echo "Assertion failed: expected exit code $expected, got $actual" >&2
    if [[ -n "$msg" ]]; then
      echo "  $msg" >&2
    fi
    return 1
  fi
}

# Create temp dir for tests
TMPDIR=$(mktemp -d)
cleanup_tmp() {
  rm -rf "$TMPDIR"
}
trap cleanup_tmp EXIT

# Test 1: marker_write and marker_read round-trip
test_write_read_roundtrip() {
  local marker_path="$TMPDIR/test-marker-1"

  marker_write "$marker_path" --kind "test" --head "abc123" --reason "test write"

  assert_file_exists "$marker_path" || return 1

  local content
  content=$(marker_read "$marker_path")

  local kind
  kind=$(jq -r '.kind' <<< "$content")
  assert_equal "test" "$kind" "kind should be 'test'" || return 1

  local head
  head=$(jq -r '.headSha' <<< "$content")
  assert_equal "abc123" "$head" "headSha should be 'abc123'" || return 1

  local reason
  reason=$(jq -r '.reason' <<< "$content")
  assert_equal "test write" "$reason" "reason should be 'test write'" || return 1

  return 0
}

# Test 2: marker_write with detail-json
test_write_with_detail() {
  local marker_path="$TMPDIR/test-marker-2"
  local detail_json='{"foo":"bar","count":42}'

  marker_write "$marker_path" --kind "test" --head "abc123" --detail-json "$detail_json"

  local content
  content=$(marker_read "$marker_path")

  local foo
  foo=$(jq -r '.detail.foo' <<< "$content")
  assert_equal "bar" "$foo" "detail.foo should be 'bar'" || return 1

  return 0
}

# Test 3: marker_clear removes file
test_clear_removes_file() {
  local marker_path="$TMPDIR/test-marker-3"

  marker_write "$marker_path" --kind "test" --head "abc123"
  assert_file_exists "$marker_path" || return 1

  marker_clear "$marker_path"
  assert_file_not_exists "$marker_path" || return 1

  return 0
}

# Test 4: marker_head extracts headSha
test_marker_head() {
  local marker_path="$TMPDIR/test-marker-4"

  marker_write "$marker_path" --kind "test" --head "def456"

  local head
  head=$(marker_head "$marker_path")
  assert_equal "def456" "$head" "marker_head should extract headSha" || return 1

  return 0
}

# Test 5: marker_head on nonexistent file
test_marker_head_nonexistent() {
  local marker_path="$TMPDIR/nonexistent-marker"

  local head
  head=$(marker_head "$marker_path" || true)
  assert_equal "" "$head" "marker_head on nonexistent should return empty" || return 1

  return 0
}

# Test 6: marker_is_stale exit codes
test_marker_is_stale_valid() {
  local marker_path="$TMPDIR/test-marker-6a"

  marker_write "$marker_path" --kind "test" --head "abc123"

  marker_is_stale "$marker_path" "abc123"
  local exit_code=$?
  assert_exit_code 1 "$exit_code" "marker_is_stale should return 1 (valid) when SHA matches" || return 1

  return 0
}

test_marker_is_stale_sha_mismatch() {
  local marker_path="$TMPDIR/test-marker-6b"

  marker_write "$marker_path" --kind "test" --head "abc123"

  marker_is_stale "$marker_path" "def456"
  local exit_code=$?
  assert_exit_code 0 "$exit_code" "marker_is_stale should return 0 (stale) when SHA differs" || return 1

  return 0
}

test_marker_is_stale_absent() {
  local marker_path="$TMPDIR/test-marker-6c"

  marker_is_stale "$marker_path" "abc123"
  local exit_code=$?
  assert_exit_code 0 "$exit_code" "marker_is_stale should return 0 (stale) when absent" || return 1

  return 0
}

# Test 7: marker_validate exit codes
test_marker_validate_valid() {
  local marker_path="$TMPDIR/test-marker-7a"

  marker_write "$marker_path" --kind "test" --head "abc123"

  marker_validate "$marker_path" "abc123" "exit 0"
  local exit_code=$?
  assert_exit_code 0 "$exit_code" "marker_validate should return 0 (valid)" || return 1

  return 0
}

test_marker_validate_stale_sha() {
  local marker_path="$TMPDIR/test-marker-7b"

  marker_write "$marker_path" --kind "test" --head "abc123"

  marker_validate "$marker_path" "def456" "exit 0"
  local exit_code=$?
  assert_exit_code 1 "$exit_code" "marker_validate should return 1 (stale-sha)" || return 1

  return 0
}

test_marker_validate_contradicted() {
  local marker_path="$TMPDIR/test-marker-7c"

  marker_write "$marker_path" --kind "test" --head "abc123"

  marker_validate "$marker_path" "abc123" "exit 1"
  local exit_code=$?
  assert_exit_code 2 "$exit_code" "marker_validate should return 2 (contradicted)" || return 1

  return 0
}

test_marker_validate_absent() {
  local marker_path="$TMPDIR/test-marker-7d"

  marker_validate "$marker_path" "abc123" "exit 0"
  local exit_code=$?
  assert_exit_code 3 "$exit_code" "marker_validate should return 3 (absent)" || return 1

  return 0
}

# Test 8: marker_read on nonexistent file
test_marker_read_nonexistent() {
  local marker_path="$TMPDIR/nonexistent-marker"

  local content
  content=$(marker_read "$marker_path" || true)
  assert_equal "" "$content" "marker_read on nonexistent should return empty" || return 1

  return 0
}

# Test 9: marker_emit_finding appends JSONL
# HOK-2972: findings land in the controller repository's state location
# (REPO_DIR) so they never dirty a task worktree. Pin REPO_DIR to a temp
# root so the test is hermetic even when the caller's shell exports one.
test_marker_emit_finding() {
  local marker_path="$TMPDIR/test-marker-9"
  local findings_root="$TMPDIR/findings-repo"
  local findings_file="$findings_root/.wavemill/observer-findings.jsonl"

  mkdir -p "$findings_root"
  rm -f "$findings_file"

  marker_write "$marker_path" --kind "test-kind" --head "abc123" --reason "test reason"

  REPO_DIR="$findings_root" marker_emit_finding "$marker_path" "test reason" "test-repo"

  if [[ ! -f "$findings_file" ]]; then
    echo "Finding file was not created" >&2
    return 1
  fi

  local line_count
  line_count=$(wc -l < "$findings_file")
  if [[ "$line_count" -lt 1 ]]; then
    echo "No finding was emitted" >&2
    return 1
  fi

  return 0
}

# Run tests
test_case "marker_write and marker_read round-trip" test_write_read_roundtrip
test_case "marker_write with detail-json" test_write_with_detail
test_case "marker_clear removes file" test_clear_removes_file
test_case "marker_head extracts headSha" test_marker_head
test_case "marker_head on nonexistent file" test_marker_head_nonexistent
test_case "marker_is_stale valid SHA" test_marker_is_stale_valid
test_case "marker_is_stale SHA mismatch" test_marker_is_stale_sha_mismatch
test_case "marker_is_stale absent" test_marker_is_stale_absent
test_case "marker_validate valid" test_marker_validate_valid
test_case "marker_validate stale-sha" test_marker_validate_stale_sha
test_case "marker_validate contradicted" test_marker_validate_contradicted
test_case "marker_validate absent" test_marker_validate_absent
test_case "marker_read nonexistent" test_marker_read_nonexistent
test_case "marker_emit_finding appends JSONL" test_marker_emit_finding

# Summary
echo ""
echo "Results: $pass_count passed, $fail_count failed"

if [[ $fail_count -gt 0 ]]; then
  exit 1
fi
