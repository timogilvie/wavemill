// HOK-3151 Phase 4: challenger-baseline-history.ts
// Read-only aggregate of production challenger coding transcripts.
// Filters for challenger IDs using isChallengerTaskId, extracts first-turn
// input/cacheRead, computes per-model cacheRead ratio.

import { readdir, readFile } from 'node:fs/promises';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';

// Import task-identity helper (avoiding HOK-3100 violation)
import { isChallengerTaskId } from '../../../shared/lib/task-identity.js';

interface TranscriptEntry {
  type: string;
  timestamp?: number;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    cost?: number;
  };
  message?: {
    model?: string;
  };
}

interface ChallengerRecord {
  taskId: string;
  model: string;
  firstTurnInput: number;
  firstTurnCacheRead: number;
  totalInput: number;
  totalCacheRead: number;
  turns: number;
}

async function main() {
  const args = process.argv.slice(2);
  const repoDir = args[0];

  if (!repoDir) {
    console.error('Usage: challenger-baseline-history.ts <repoDir>');
    process.exit(1);
  }

  const runsDir = path.join(repoDir, '.wavemill', 'runs');
  if (!existsSync(runsDir)) {
    console.error(`Runs directory not found: ${runsDir}`);
    process.exit(1);
  }

  const records: ChallengerRecord[] = [];

  // Scan all run directories
  const runDirs = await readdir(runsDir, { withFileTypes: true });
  for (const entry of runDirs) {
    if (!entry.isDirectory()) continue;

    const sessionsDir = path.join(runsDir, entry.name, 'native-sessions');
    if (!existsSync(sessionsDir)) continue;

    const sessionFiles = await readdir(sessionsDir);
    for (const file of sessionFiles) {
      if (!file.startsWith('coding-') || !file.endsWith('.jsonl')) continue;

      // Extract task ID from filename: coding-<taskId>.jsonl
      const taskId = file.slice('coding-'.length, -'.jsonl'.length);
      if (!isChallengerTaskId(taskId)) continue;

      // Read transcript
      const filePath = path.join(sessionsDir, file);
      const content = await readFile(filePath, 'utf8');
      const lines = content.trim().split('\n').filter((l) => l);
      const entries: TranscriptEntry[] = lines.map((l) => JSON.parse(l));

      // Find first assistant_message with usage
      let firstTurnInput = 0;
      let firstTurnCacheRead = 0;
      let model = 'unknown';
      let totalInput = 0;
      let totalCacheRead = 0;
      let turns = 0;

      for (const e of entries) {
        if (e.type === 'assistant_message' && e.usage) {
          turns++;
          const input = e.usage.input ?? 0;
          const cacheRead = e.usage.cacheRead ?? 0;
          totalInput += input;
          totalCacheRead += cacheRead;

          if (turns === 1) {
            firstTurnInput = input;
            firstTurnCacheRead = cacheRead;
            model = e.message?.model ?? 'unknown';
          }
        }
      }

      if (turns > 0) {
        records.push({
          taskId,
          model,
          firstTurnInput,
          firstTurnCacheRead,
          totalInput,
          totalCacheRead,
          turns,
        });
      }
    }
  }

  // Aggregate stats
  const totalRecords = records.length;
  const avgFirstTurnInput =
    totalRecords > 0
      ? records.reduce((s, r) => s + r.firstTurnInput, 0) / totalRecords
      : 0;
  const avgFirstTurnCacheRead =
    totalRecords > 0
      ? records.reduce((s, r) => s + r.firstTurnCacheRead, 0) / totalRecords
      : 0;

  // Per-model cacheRead ratio
  const perModel: Record<
    string,
    { count: number; avgCacheReadRatio: number; totalInput: number; totalCacheRead: number }
  > = {};

  for (const r of records) {
    if (!perModel[r.model]) {
      perModel[r.model] = { count: 0, avgCacheReadRatio: 0, totalInput: 0, totalCacheRead: 0 };
    }
    perModel[r.model].count++;
    perModel[r.model].totalInput += r.totalInput;
    perModel[r.model].totalCacheRead += r.totalCacheRead;
  }

  for (const model of Object.keys(perModel)) {
    const { totalInput, totalCacheRead } = perModel[model];
    perModel[model].avgCacheReadRatio =
      totalInput + totalCacheRead > 0 ? totalCacheRead / (totalInput + totalCacheRead) : 0;
  }

  const summary = {
    totalRecords,
    avgFirstTurnInput: Math.round(avgFirstTurnInput),
    avgFirstTurnCacheRead: Math.round(avgFirstTurnCacheRead),
    perModel,
    records: records.slice(0, 100), // Limit to 100 for file size
  };

  // Write results
  const resultsDir = path.join(import.meta.dirname, '..', 'results');
  await mkdir(resultsDir, { recursive: true });
  const resultsPath = path.join(resultsDir, 'fork-baseline-history.json');
  await writeFile(resultsPath, JSON.stringify(summary, null, 2), 'utf8');

  console.log(`Baseline history aggregated: ${totalRecords} challenger coding runs`);
  console.log(`Average first-turn input: ${summary.avgFirstTurnInput} tokens`);
  console.log(`Average first-turn cacheRead: ${summary.avgFirstTurnCacheRead} tokens`);
  console.log(`Per-model cache ratios:`);
  for (const [model, stats] of Object.entries(perModel)) {
    console.log(`  ${model}: ${(stats.avgCacheReadRatio * 100).toFixed(1)}% (n=${stats.count})`);
  }
  console.log(`\nResults written to ${resultsPath}`);
}

main();
