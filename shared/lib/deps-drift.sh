#!/usr/bin/env bash
# HOK-3254 — stale node_modules detector.
#
# One stateless primitive, shared across the worktree helpers (startup), the
# monitor tick (REPO_DIR), and the observer repo detector (TS twin). Compares
# a repo's lockfile against npm's hidden `node_modules/.package-lock.json`
# that `npm ci` / `npm install` writes on each run. On mismatch the install is
# stale and the next consumer will crash at module load, as HOK-3075's
# `aggregateTaskCost` incident did on 2026-10-19.
#
# Exit codes:
#   0 — no drift (either matching hidden lockfile, or no lockfile at all)
#   1 — drift detected (reason + packages printed as JSON on stdout)
#   2 — unknown (pnpm / yarn, or hash tool missing). Never claim `ok`.
#
# Fallback for pre-npm-7 installs (no hidden lockfile) or missing
# `node_modules/.package-lock.json`: when `node_modules/` is present, scan the
# direct dependencies declared in `package.json` and compare each against the
# installed `node_modules/<name>/package.json`. Any mismatch is drift.
#
# Output on drift (status=drift) is a single JSON line:
#   {"status":"drift","reason":"...","packages":[{...}]}
# `packages` is best-effort — missing or unparseable lockfiles still emit a
# reason, with an empty list.

_deps_drift_hash_file() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
    return 0
  fi
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
    return 0
  fi
  return 1
}

# Emit a short JSON doc for a drift verdict. Packages come in as a
# jq-compatible JSON array string; empty when unavailable.
_deps_drift_emit() {
  local st="$1" reason="$2" packages_json="${3:-[]}"
  jq -cn \
    --arg status "$st" \
    --arg reason "$reason" \
    --argjson packages "$packages_json" \
    '{status: $status, reason: $reason, packages: $packages}' 2>/dev/null \
    || printf '{"status":"%s","reason":"%s","packages":[]}\n' "$st" "$reason"
}

# Diff two npm lockfiles (either package-lock.json or the hidden one). Reads
# `.packages` (lockfileVersion >= 2) or `.dependencies` (v1). Produces a jq
# array of `{name, lockVersion, installedVersion}` entries. Best-effort; a
# missing file or unexpected shape yields `[]`.
_deps_drift_diff_lockfiles() {
  local lock="$1" hidden="$2"
  [[ -f "$lock" && -f "$hidden" ]] || { printf '[]'; return 0; }
  jq -cs '
    def map_versions(doc):
      if (doc.packages // null) != null then
        doc.packages
        | to_entries
        | map(select(.key != "" and (.value.version // null) != null))
        | map({ key: (.key | sub("^node_modules/"; "")), value: .value.version })
        | from_entries
      elif (doc.dependencies // null) != null then
        doc.dependencies
        | to_entries
        | map(select((.value.version // null) != null))
        | map({ key: .key, value: .value.version })
        | from_entries
      else {} end;
    . as $docs
    | (map_versions($docs[0])) as $lock
    | (map_versions($docs[1])) as $installed
    | ([$lock, $installed] | add | keys) as $names
    | [ $names[]
        | . as $name
        | select(($lock[$name] // null) != ($installed[$name] // null))
        | { name: $name,
            lockVersion: ($lock[$name] // null),
            installedVersion: ($installed[$name] // null) } ]
  ' "$lock" "$hidden" 2>/dev/null || printf '[]'
}

# Pure bash scan: for each direct dep, read installed package.json version.
# Prints a JSON array of drifted entries.
_deps_drift_direct_dep_scan() {
  local repo_dir="$1" lock="$2"
  local pkg_json="$repo_dir/package.json"
  local nm="$repo_dir/node_modules"
  [[ -f "$pkg_json" && -d "$nm" ]] || { printf '[]'; return 0; }

  local names
  names="$(jq -r '
    (((.dependencies // {}) | keys)
     + ((.devDependencies // {}) | keys))
    | unique
    | .[]
  ' "$pkg_json" 2>/dev/null)" || { printf '[]'; return 0; }

  local -a drifted=()
  local name expected installed_pkg installed
  while IFS= read -r name; do
    [[ -n "$name" ]] || continue
    expected=""
    if [[ -f "$lock" ]]; then
      expected="$(jq -r --arg name "$name" '
        (.packages["node_modules/" + $name].version)
          // (.dependencies[$name].version)
          // ""
      ' "$lock" 2>/dev/null)"
    fi
    if [[ -z "$expected" ]]; then
      expected="$(jq -r --arg name "$name" '
        (.dependencies[$name])
          // (.devDependencies[$name])
          // ""
      ' "$pkg_json" 2>/dev/null)"
    fi
    [[ -n "$expected" ]] || continue
    installed_pkg="$nm/$name/package.json"
    if [[ ! -f "$installed_pkg" ]]; then
      installed=""
    else
      installed="$(jq -r '.version // ""' "$installed_pkg" 2>/dev/null)" || installed=""
    fi
    if [[ "$installed" != "$expected" ]]; then
      drifted+=("$(jq -cn --arg n "$name" --arg l "$expected" --arg i "$installed" \
        '{name: $n, lockVersion: $l, installedVersion: (if $i == "" then null else $i end)}' 2>/dev/null || printf '{"name":"%s"}' "$name")")
    fi
  done <<< "$names"

  if (( ${#drifted[@]} == 0 )); then
    printf '[]'
  else
    local joined
    joined="$(printf '%s,' "${drifted[@]}")"
    printf '[%s]' "${joined%,}"
  fi
}

# deps_drift_check <dir>
# Prints a one-line JSON doc on stdout and exits with 0/1/2 as above.
deps_drift_check() {
  local dir="${1:-.}"
  [[ -d "$dir" ]] || { _deps_drift_emit ok "no-dir"; return 0; }

  if [[ -f "$dir/pnpm-lock.yaml" ]]; then
    _deps_drift_emit unknown "pnpm-not-supported"
    return 2
  fi
  if [[ -f "$dir/yarn.lock" ]]; then
    _deps_drift_emit unknown "yarn-not-supported"
    return 2
  fi

  local lock="$dir/package-lock.json"
  if [[ ! -f "$lock" ]]; then
    _deps_drift_emit ok "no-lockfile"
    return 0
  fi

  local nm="$dir/node_modules"
  if [[ ! -d "$nm" ]]; then
    _deps_drift_emit drift "node_modules-missing"
    return 1
  fi

  local hidden="$nm/.package-lock.json"
  if [[ -f "$hidden" ]]; then
    local lock_hash hidden_hash
    lock_hash="$(_deps_drift_hash_file "$lock")" || {
      _deps_drift_emit unknown "hash-tool-missing"
      return 2
    }
    hidden_hash="$(_deps_drift_hash_file "$hidden")" || {
      _deps_drift_emit unknown "hash-tool-missing"
      return 2
    }
    if [[ "$lock_hash" == "$hidden_hash" ]]; then
      _deps_drift_emit ok "hidden-lockfile-match"
      return 0
    fi
    local packages
    packages="$(_deps_drift_diff_lockfiles "$lock" "$hidden")"
    [[ -n "$packages" ]] || packages='[]'
    _deps_drift_emit drift "hidden-lockfile-mismatch" "$packages"
    return 1
  fi

  # No hidden lockfile — fall back to a direct-dep scan.
  local packages
  packages="$(_deps_drift_direct_dep_scan "$dir" "$lock")"
  [[ -n "$packages" ]] || packages='[]'
  if [[ "$packages" == "[]" ]]; then
    # package-lock.json is present and every direct dep matches; treat as
    # a legacy install we can't disprove. Prefer ok over a false positive.
    _deps_drift_emit ok "hidden-lockfile-missing-direct-deps-match"
    return 0
  fi
  _deps_drift_emit drift "hidden-lockfile-missing" "$packages"
  return 1
}
