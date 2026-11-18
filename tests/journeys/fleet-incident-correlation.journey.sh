#!/usr/bin/env bash
# Golden journey (HOK-3509): the incident cycle is the sole cross-task
# correlator. Five failure sources on one endpoint yield one task-less fleet
# incident; a single independent failure remains a normal task incident.
set -euo pipefail
source "$(dirname "$0")/harness.sh"

reason="$(journey_skip_reason)"
if [[ -n "$reason" ]]; then echo "SKIP fleet-incident-correlation journey: $reason"; exit 0; fi
journey_init fleet-incident-correlation
journey_set_tick_budget 1

RESULT="$JOURNEY_TMP/fleet-result.json"
(cd "$JOURNEY_INSTALL_DIR" && node --import tsx --input-type=module -e '
  import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
  import { join } from "node:path";
  import { tmpdir } from "node:os";
  import { IncidentStore } from "./shared/lib/wavemill-incident-store.ts";
  import { reconcileIncidentCycle } from "./shared/lib/incident-reconcile-cycle.ts";
  import { createIncidentDraft } from "./shared/lib/wavemill-incident-model.ts";
  const root = mkdtempSync(join(tmpdir(), "fleet-journey-")); const now = new Date("2026-11-10T17:00:00Z"); const sources=[];
  for (let i=1;i<=5;i++) { const featureDir=join(root, `features/t${i}`); mkdirSync(featureDir,{recursive:true}); writeFileSync(join(featureDir,".coding-result.json"),JSON.stringify({status:"failed",startedAt:"2026-11-10T16:50:00Z",finishedAt:`2026-11-10T16:5${i}:00Z`,executedModel:"deepseek-v4-flash",executionEvidence:{status:"direct"},notes:"coding agent settled without a result",runId:`r${i}`})); sources.push({taskId:`HOK-${i}`,featureDir}); }
  const store = new IncidentStore(join(root,".wavemill/incidents"),{escalationThreshold:3,maxEvidencePerRecord:50,resolutionAfterCycles:5});
  const single = createIncidentDraft({taskId:"HOK-alone",session:null,category:"stale_orphaned_state",severity:"medium",confidence:"high",lifecycle:"observed",rootCauseClass:"active_unpublished_work_stalled",summary:"alone",operatorAction:"retry",evidence:[],metadata:{}});
  const out=await reconcileIncidentCycle({store,candidates:[single],cycleComplete:true,repoDir:root,failureSources:sources,correlation:{windowMs:600000,threshold:3,now}});
  console.log(JSON.stringify({fleet:out.incidents.filter(x=>x.taskId===null).length,single:out.incidents.filter(x=>x.taskId==="HOK-alone").length,rows:out.incidents.find(x=>x.taskId===null)?.metadata?.fleet?.attempts.length}));
' > "$RESULT")
journey_assert "five shared failures produce exactly one fleet incident" jq -e '.fleet == 1 and .rows == 5' "$RESULT"
journey_assert "a lone task remains a normal task incident" jq -e '.single == 1' "$RESULT"
journey_finish
