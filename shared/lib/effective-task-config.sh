#!/usr/bin/env bash

effective_task_state_file() {
  printf '%s\n' "${STATE_FILE:-${WAVEMILL_STATE_FILE:-${REPO_DIR:-$PWD}/.wavemill/workflow-state.json}}"
}

effective_task_repo_dir() {
  printf '%s\n' "${REPO_DIR:-$PWD}"
}

effective_task_runtime_snapshot_file() {
  local issue="$1"
  printf '%s/.wavemill/runtime-env/%s.json\n' "$(effective_task_repo_dir)" "$issue"
}

effective_task_repo_config_file() {
  printf '%s/.wavemill-config.json\n' "$(effective_task_repo_dir)"
}

effective_task_user_config_file() {
  printf '%s/.wavemill/config.json\n' "${HOME:-}"
}

effective_task_config_json() {
  local issue="$1"
  local state_file repo_config user_config runtime_file
  state_file="$(effective_task_state_file)"
  repo_config="$(effective_task_repo_config_file)"
  user_config="$(effective_task_user_config_file)"
  runtime_file="$(effective_task_runtime_snapshot_file "$issue")"
  [[ -f "$state_file" ]] || state_file="/dev/null"
  [[ -f "$repo_config" ]] || repo_config="/dev/null"
  [[ -f "$user_config" ]] || user_config="/dev/null"
  [[ -f "$runtime_file" ]] || runtime_file="/dev/null"

  jq -n -c \
    --arg issue "$issue" \
    --arg envBase "${BASE_BRANCH:-}" \
    --arg envConfirm "${REQUIRE_CONFIRM:-}" \
    --arg legacy "${WAVEMILL_EFFECTIVE_CONFIG_LEGACY:-}" \
    --slurpfile state "$state_file" \
    --slurpfile repo "$repo_config" \
    --slurpfile user "$user_config" \
    --slurpfile runtime "$runtime_file" '
      def obj($x): if ($x | type) == "object" then $x else {} end;
      def first_obj($x): if ($x | length) > 0 then obj($x[0]) else {} end;
      def bool_env($x): if $x == "true" then true elif $x == "false" then false else null end;
      (first_obj($state).tasks[$issue] // {}) as $task
      | (if $legacy == "1" then {} else ($task.lifecycle.launchContract // {}) end) as $contract
      | first_obj($runtime) as $runtime
      | first_obj($repo) as $repoConfig
      | ($repoConfig.mill // {}) as $repoMill
      | (($repoMill.baseBranch // $repoConfig.integration.integrationBranch) // null) as $repoBaseBranch
      | (first_obj($user).mill // {}) as $userMill
      | {
          issue: $issue,
          baseBranch: (
            if ($contract.baseBranch // "") != "" then {value: $contract.baseBranch, source: ($contract.provenance.baseBranch // "launch-contract")}
            elif ($runtime.baseBranch // "") != "" then {value: $runtime.baseBranch, source: ($runtime.baseBranchSource // "runtime-env")}
            elif ($envBase // "") != "" then {value: $envBase, source: "runtime-env"}
            elif ($userMill.baseBranch // "") != "" then {value: $userMill.baseBranch, source: "user-config"}
            elif ($repoBaseBranch // "") != "" then {value: $repoBaseBranch, source: "repo-config"}
            else {value: "main", source: "default"} end
          ),
          requireConfirm: (
            if ($contract.requireConfirm | type) == "boolean" then {value: $contract.requireConfirm, source: ($contract.provenance.requireConfirm // "launch-contract")}
            elif ($runtime.requireConfirm | type) == "boolean" then {value: $runtime.requireConfirm, source: ($runtime.requireConfirmSource // "runtime-env")}
            elif bool_env($envConfirm) != null then {value: bool_env($envConfirm), source: "runtime-env"}
            elif ($userMill.requireConfirm | type) == "boolean" then {value: $userMill.requireConfirm, source: "user-config"}
            elif ($repoMill.requireConfirm | type) == "boolean" then {value: $repoMill.requireConfirm, source: "repo-config"}
            else {value: true, source: "default"} end
          ),
          repoConfig: {
            baseBranch: $repoBaseBranch,
            requireConfirm: (if ($repoMill.requireConfirm | type) == "boolean" then $repoMill.requireConfirm else null end)
          }
        }
      | if (.baseBranch.source != "repo-config" and .repoConfig.baseBranch != null and .repoConfig.baseBranch != .baseBranch.value)
        then .baseBranch.driftFromRepoConfig = .repoConfig.baseBranch else . end
      | if (.requireConfirm.source != "repo-config" and .repoConfig.requireConfirm != null and .repoConfig.requireConfirm != .requireConfirm.value)
        then .requireConfirm.driftFromRepoConfig = .repoConfig.requireConfirm else . end
    ' 2>/dev/null || printf '{"issue":"%s","baseBranch":{"value":"%s","source":"runtime-env"},"requireConfirm":{"value":%s,"source":"runtime-env"}}\n' \
      "$issue" "${BASE_BRANCH:-main}" "$(if [[ "${REQUIRE_CONFIRM:-true}" == "false" ]]; then printf false; else printf true; fi)"
}

effective_task_base_branch() {
  local issue="$1"
  effective_task_config_json "$issue" | jq -r '.baseBranch.value // "main"'
}

effective_task_require_confirm() {
  local issue="$1"
  effective_task_config_json "$issue" | jq -r 'if .requireConfirm.value == false then "false" else "true" end'
}

effective_task_config_source() {
  local issue="$1" field="$2"
  effective_task_config_json "$issue" | jq -r --arg field "$field" '.[$field].source // "default"'
}
