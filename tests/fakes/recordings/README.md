# Recorded gh response shapes

Key/type shapes (no values) captured from the real `gh` CLI against
timogilvie/wavemill on 2026-10-14, used by `tests/fakes/fakes-contract.test.sh`
to keep `tests/fakes/gh.mjs` from drifting away from what GitHub returns.

- `pr-view.shape.json` — `gh pr view <n> --json <WAVEMILL_PR_CACHE_FIELDS>,author,isDraft,mergeCommit,closedAt,baseRefOid`
- `pr-checks.shape.json` — `gh pr checks <n> --json name,state,bucket,startedAt,completedAt,link,workflow`

Re-record when production code starts reading a new field:

    gh pr view <n> --json <fields> | jq 'def shape: if type=="object" then with_entries(.value|=shape) elif type=="array" then (if length>0 then [.[0]|shape] else [] end) else type end; shape'
