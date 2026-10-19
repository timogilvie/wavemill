#!/usr/bin/env bash

# HOK-3254: load the stale node_modules primitive. The worktree helpers (and
# _detect_worktree_pm in wavemill-startup-runner.sh) consult it before the
# "node_modules exists → skip install" shortcut, so a stale install triggers
# a reinstall instead of silently running the next phase against drifted deps.
if [[ -z "${__WAVEMILL_DEPS_DRIFT_LOADED:-}" ]]; then
  _wd_deps_drift_src="${BASH_SOURCE[0]%/*}/deps-drift.sh"
  if [[ -f "$_wd_deps_drift_src" ]]; then
    # shellcheck source=./deps-drift.sh
    . "$_wd_deps_drift_src"
    __WAVEMILL_DEPS_DRIFT_LOADED=1
  fi
  unset _wd_deps_drift_src
fi

# Reasons the drift primitive returns that still represent a safe-to-reuse
# tree (hidden lockfile matches, no lockfile at all, pre-existing legacy
# install with no visible drift). Everything else — including `unknown` — must
# not win over a lockfile-hash mismatch below.
_wd_drift_reason_is_ok() {
  case "$1" in
    hidden-lockfile-match|no-lockfile|hidden-lockfile-missing-direct-deps-match|no-dir)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

_wd_detect_package_manager() {
  local dir="$1"
  if [[ -f "$dir/pnpm-lock.yaml" ]]; then
    printf 'pnpm pnpm-lock.yaml\n'
    return 0
  fi
  if [[ -f "$dir/yarn.lock" ]]; then
    printf 'yarn yarn.lock\n'
    return 0
  fi
  if [[ -f "$dir/package-lock.json" ]]; then
    printf 'npm package-lock.json\n'
    return 0
  fi
  return 1
}

_wd_install_command() {
  case "$1" in
    pnpm) printf 'pnpm install --frozen-lockfile --prefer-offline\n' ;;
    yarn) printf 'yarn install --frozen-lockfile --prefer-offline\n' ;;
    npm) printf 'npm ci --prefer-offline\n' ;;
    *) return 1 ;;
  esac
}

_wd_hash_file() {
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

_wd_package_manager_field() {
  local dir="$1"
  local pkg_json="$dir/package.json"
  [[ -f "$pkg_json" ]] || {
    printf '\n'
    return 0
  }
  jq -r '.packageManager // ""' "$pkg_json" 2>/dev/null
}

_wd_node_signature() {
  local dir="$1" nvmrc="" engines="" pkg_json=""
  pkg_json="$dir/package.json"
  if [[ -f "$dir/.nvmrc" ]]; then
    nvmrc="$(tr -d '\r' < "$dir/.nvmrc" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  fi
  if [[ -f "$pkg_json" ]]; then
    engines="$(jq -r '.engines.node // ""' "$pkg_json" 2>/dev/null)" || return 1
  fi
  printf '%s|%s\n' "$nvmrc" "$engines"
}

_wd_workspace_signature() {
  local dir="$1" pkg_json=""
  local workspaces="null"
  local pnpm_ws_hash=""
  pkg_json="$dir/package.json"

  if [[ -f "$pkg_json" ]]; then
    workspaces="$(jq -c '.workspaces // null' "$pkg_json" 2>/dev/null)" || return 1
  fi

  if [[ -f "$dir/pnpm-workspace.yaml" ]]; then
    pnpm_ws_hash="$(_wd_hash_file "$dir/pnpm-workspace.yaml")" || return 2
  fi

  printf '%s|%s\n' "$workspaces" "$pnpm_ws_hash"
}

_wd_is_world_writable() {
  local path="$1" perms
  if perms="$(stat -f '%Mp%Lp' "$path" 2>/dev/null)"; then
    [[ $((8#$perms & 2)) -ne 0 ]]
    return
  fi
  if perms="$(stat -c '%a' "$path" 2>/dev/null)"; then
    [[ $((8#$perms & 2)) -ne 0 ]]
    return
  fi
  return 1
}

_wd_parent_is_trusted() {
  local parent="$1" worktree_root="$2"
  local parent_real="" root_anchor="" nm="$parent/node_modules"

  [[ "$parent" = /* ]] || return 1
  [[ -d "$parent" ]] || return 1

  parent_real="$(cd "$parent" && pwd -P 2>/dev/null)" || return 1
  root_anchor="$(cd "${worktree_root%/*}" && pwd -P 2>/dev/null)" || return 1

  case "$parent_real" in
    "$root_anchor"/*) ;;
    *) return 1 ;;
  esac

  if _wd_is_world_writable "$parent_real"; then
    return 1
  fi

  [[ -d "$nm" ]] || return 1
  return 0
}

_wd_cleanup_node_modules_dest() {
  local dest="$1"
  if [[ -L "$dest" ]]; then
    rm -f "$dest"
    return
  fi
  if [[ -d "$dest" ]]; then
    rm -rf "$dest"
  fi
}

_wd_try_cow() {
  local src="$1" dest="$2"
  [[ ! -e "$dest" ]] || return 1

  if [[ "$(uname -s)" == "Darwin" ]]; then
    cp -cR "$src" "$dest" 2>/dev/null || return 1
  else
    cp -a --reflink=auto "$src" "$dest" 2>/dev/null || return 1
  fi

  [[ -d "$dest" ]] || return 1
  return 0
}

_wd_try_symlink() {
  local src="$1" dest="$2"
  [[ ! -e "$dest" ]] || return 1
  ln -s "$src" "$dest" 2>/dev/null || return 1
  [[ -d "$dest" ]] || {
    rm -f "$dest" 2>/dev/null || true
    return 1
  }
  return 0
}

_wd_run_install() {
  local wt_dir="$1" issue="$2" pm="$3" install_cmd="$4"
  local install_stderr

  startup_step "[1.5/7] Installing deps ($pm)..."
  install_stderr="$(mktemp)"
  if ! (cd "$wt_dir" && eval "$install_cmd") >/dev/null 2>"$install_stderr"; then
    startup_log "✗ $issue FAILED at step [1.5/7]: $pm install"
    [[ -s "$install_stderr" ]] && tail -n 40 "$install_stderr" | sed 's/^/  '"$pm"': /' >> "$STATUS_LOG_FILE"
    [[ -s "$install_stderr" && -n "${STARTUP_TASK_LOG_FILE:-}" ]] && tail -n 40 "$install_stderr" | sed 's/^/  '"$pm"': /' >> "$STARTUP_TASK_LOG_FILE"
    rm -f "$install_stderr"
    startup_log "  Task will not be launched. Retry with: wavemill mill"
    return 1
  fi
  rm -f "$install_stderr"
  startup_step "[1.5/7] Installing deps ($pm)... ✓"
  return 0
}

worktree_deps_ensure() {
  local wt_dir="$1" parent_dir="$2" issue="$3"
  local pm="" lockfile="" install_cmd=""
  local parent_pm="" parent_lockfile=""
  local reason=""
  local wt_lock_hash="" parent_lock_hash=""
  local wt_pm_field="" parent_pm_field=""
  local wt_node_sig="" parent_node_sig=""
  local wt_ws_sig="" parent_ws_sig=""
  local parent_nm="$parent_dir/node_modules"
  local wt_nm="$wt_dir/node_modules"

  if ! read -r pm lockfile < <(_wd_detect_package_manager "$wt_dir"); then
    return 0
  fi

  # HOK-3254: a present `node_modules/` is not evidence it is fresh. Consult
  # the drift primitive before the shortcut: on `ok` return 0; on `drift`
  # fall through to the reuse / install path so the parent-hash compare or
  # a fresh install repairs the tree. `unknown` (pnpm, yarn, missing hash
  # tool) preserves the old shortcut rather than reinstalling blindly.
  if [[ -d "$wt_nm" ]]; then
    if declare -F deps_drift_check >/dev/null 2>&1; then
      local _wd_drift_json _wd_drift_rc=0 _wd_drift_status _wd_drift_reason
      _wd_drift_json="$(deps_drift_check "$wt_dir" 2>/dev/null)" || _wd_drift_rc=$?
      _wd_drift_status="$(printf '%s' "$_wd_drift_json" | jq -r '.status // ""' 2>/dev/null)"
      _wd_drift_reason="$(printf '%s' "$_wd_drift_json" | jq -r '.reason // ""' 2>/dev/null)"
      case "$_wd_drift_status" in
        ok)
          return 0
          ;;
        drift)
          reason="node-modules-drift:${_wd_drift_reason:-unknown}"
          _wd_cleanup_node_modules_dest "$wt_nm"
          ;;
        *)
          # unknown — preserve previous behaviour (treat existing tree as ok).
          return 0
          ;;
      esac
    else
      return 0
    fi
  fi

  install_cmd="$(_wd_install_command "$pm")" || return 1

  if ! command -v "$pm" >/dev/null 2>&1; then
    startup_log "  Warning: $lockfile present but '$pm' not on PATH; skipping dep install"
    return 0
  fi

  if [[ "${WAVEMILL_WORKTREE_DEPS_FAST_PATH:-1}" == "0" ]]; then
    startup_log "  [startup] installing deps: opt-out"
    _wd_run_install "$wt_dir" "$issue" "$pm" "$install_cmd"
    return $?
  fi

  if ! _wd_parent_is_trusted "$parent_dir" "${WORKTREE_ROOT:-}"; then
    reason="parent-path-untrusted"
  elif ! read -r parent_pm parent_lockfile < <(_wd_detect_package_manager "$parent_dir"); then
    reason="parent-node-modules-missing"
  elif [[ "$pm" != "$parent_pm" ]]; then
    reason="package-manager-mismatch"
  else
    wt_lock_hash="$(_wd_hash_file "$wt_dir/$lockfile")" || reason="hash-tool-missing"
    if [[ -z "$reason" ]]; then
      parent_lock_hash="$(_wd_hash_file "$parent_dir/$lockfile")" || reason="hash-tool-missing"
    fi
    if [[ -z "$reason" && "$wt_lock_hash" != "$parent_lock_hash" ]]; then
      reason="lockfile-hash-mismatch"
    fi

    if [[ -z "$reason" ]]; then
      wt_pm_field="$(_wd_package_manager_field "$wt_dir")" || reason="package-manager-read-failed"
    fi
    if [[ -z "$reason" ]]; then
      parent_pm_field="$(_wd_package_manager_field "$parent_dir")" || reason="package-manager-read-failed"
    fi
    if [[ -z "$reason" && "$wt_pm_field" != "$parent_pm_field" ]]; then
      reason="package-manager-mismatch"
    fi

    if [[ -z "$reason" ]]; then
      wt_node_sig="$(_wd_node_signature "$wt_dir")" || reason="node-signature-read-failed"
    fi
    if [[ -z "$reason" ]]; then
      parent_node_sig="$(_wd_node_signature "$parent_dir")" || reason="node-signature-read-failed"
    fi
    if [[ -z "$reason" && "$wt_node_sig" != "$parent_node_sig" ]]; then
      reason="node-signature-mismatch"
    fi

    if [[ -z "$reason" ]]; then
      wt_ws_sig="$(_wd_workspace_signature "$wt_dir")"
      case $? in
        0) ;;
        2) reason="hash-tool-missing" ;;
        *) reason="workspaces-read-failed" ;;
      esac
    fi
    if [[ -z "$reason" ]]; then
      parent_ws_sig="$(_wd_workspace_signature "$parent_dir")"
      case $? in
        0) ;;
        2) reason="hash-tool-missing" ;;
        *) reason="workspaces-read-failed" ;;
      esac
    fi
    if [[ -z "$reason" && "$wt_ws_sig" != "$parent_ws_sig" ]]; then
      reason="workspaces-mismatch"
    fi
  fi

  if [[ -z "$reason" ]]; then
    if _wd_try_cow "$parent_nm" "$wt_nm"; then
      startup_log "  [startup] deps: reused (cow)"
      return 0
    fi
    _wd_cleanup_node_modules_dest "$wt_nm"
    if _wd_try_symlink "$parent_nm" "$wt_nm"; then
      startup_log "  [startup] deps: reused (symlink)"
      return 0
    fi
    _wd_cleanup_node_modules_dest "$wt_nm"
    reason="reuse-failed-symlink"
  fi

  startup_log "  [startup] installing deps: $reason"
  _wd_run_install "$wt_dir" "$issue" "$pm" "$install_cmd"
}
