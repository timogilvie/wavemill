# shellcheck shell=bash
# Shared helpers for the HOK-3273 fake agent scripts (sourced by the review and
# coding snippets, which tests/fakes/bin/claude sources in place of its
# defaults).

# hok3273_gh_state <jq program>: edit the fake GitHub state under the same
# directory lock gh.mjs takes, so a concurrent gh call cannot drop the edit.
hok3273_gh_state() {
  local lock="$FAKE_GH_STATE.lock" tmp="$FAKE_GH_STATE.tmp.$$" tries=0
  until mkdir "$lock" 2>/dev/null; do
    tries=$((tries + 1))
    (( tries < 2500 )) || rm -rf "$lock"
    sleep 0.01
  done
  printf '%s' "$$" > "$lock/pid"
  jq "$1" "$FAKE_GH_STATE" > "$tmp" && mv "$tmp" "$FAKE_GH_STATE"
  rm -rf "$lock"
}
