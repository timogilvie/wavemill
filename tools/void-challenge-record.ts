#!/usr/bin/env -S npx tsx

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runTool } from '../shared/lib/tool-runner.ts';
import { readChallengeComparisons } from '../shared/lib/challenge-comparison.ts';
import { appendChallengeRecordVoid } from '../shared/lib/challenge-record-void.ts';
import { mutateWorkflowState } from '../shared/lib/workflow-state.ts';

runTool({
  name: 'void-challenge-record',
  description: 'Append a tombstone for a bad challenge comparison record and reopen its pair gates.',
  options: {
    'pair-id': { type: 'string', description: 'Challenge pair identifier' },
    reason: { type: 'string', description: 'Why this record is being voided' },
    'repo-dir': { type: 'string', description: 'Repository directory' },
  },
  async run({ args }) {
    const pairId = args['pair-id'] as string | undefined;
    if (!pairId) {
      throw new Error('--pair-id is required');
    }
    const repoDir = resolve((args['repo-dir'] as string | undefined) || process.cwd());
    const reason = (args.reason as string | undefined)?.trim() || 'operator voided stale/non-decisive challenge record';
    const evalsDir = join(repoDir, '.wavemill', 'evals');
    const records = readChallengeComparisons(evalsDir).filter((record) => record.challengePairId === pairId);
    if (records.length === 0) {
      throw new Error(`No challenge record found for ${pairId}`);
    }
    const record = records[records.length - 1];
    const voidRecord = {
      challengePairId: pairId,
      voidedAt: new Date().toISOString(),
      reason,
      recordTimestamp: record.timestamp,
    };
    appendChallengeRecordVoid(voidRecord, evalsDir);

    const statePath = join(repoDir, '.wavemill', 'workflow-state.json');
    if (existsSync(statePath)) {
      await mutateWorkflowState(statePath, (state) => {
        for (const task of Object.values(state.tasks ?? {})) {
          if (task.challengePairId === pairId) {
            task.challengeCompared = false;
            delete task.challengeComparedSource;
            task.updated = new Date().toISOString();
          }
        }
        return state;
      });
    }

    console.log(JSON.stringify({ status: 'voided', void: voidRecord, record }, null, 2));
  },
});
