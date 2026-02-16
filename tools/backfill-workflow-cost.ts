#!/usr/bin/env -S npx tsx
// @ts-nocheck

/**
 * Backfill workflow cost data into existing eval records.
 *
 * Scans all Claude Code session directories under ~/.claude/projects/
 * for sessions matching each eval's PR branch, aggregates token usage,
 * computes cache-aware cost, and rewrites the evals JSONL file with
 * workflowCost and workflowTokenUsage populated.
 *
 * Usage:
 *   npx tsx tools/backfill-workflow-cost.ts [--dry-run]
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { computeModelCost, loadPricingTable } from '../shared/lib/workflow-cost.ts';
import type { ModelPricing, ModelTokenUsage } from '../shared/lib/workflow-cost.ts';

const DRY_RUN = process.argv.includes('--dry-run');

// ────────────────────────────────────────────────────────────────
// Locate eval records
// ────────────────────────────────────────────────────────────────

const repoDir = resolve('.');
const configPath = join(repoDir, '.wavemill-config.json');
let evalsDir = join(repoDir, '.wavemill', 'evals');
if (existsSync(configPath)) {
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    if (config.eval?.evalsDir) evalsDir = resolve(repoDir, config.eval.evalsDir);
  } catch {}
}

const evalsFile = join(evalsDir, 'evals.jsonl');
if (!existsSync(evalsFile)) {
  console.error(`Evals file not found: ${evalsFile}`);
  process.exit(1);
}

// ────────────────────────────────────────────────────────────────
// Build branch → PR mapping from eval records
// ────────────────────────────────────────────────────────────────

const content = readFileSync(evalsFile, 'utf-8');
const records = content.split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
console.log(`Found ${records.length} eval records in ${evalsFile}`);

// Get PR branches from GitHub
interface PrBranchInfo {
  branch: string;
  prNumber: string;
}

function getPrBranch(prUrl: string): PrBranchInfo | null {
  const match = prUrl.match(/\/pull\/(\d+)$/);
  if (!match) return null;
  const prNumber = match[1];
  try {
    const branch = execSync(`gh pr view ${prNumber} --json headRefName --jq .headRefName`, {
      encoding: 'utf-8', cwd: repoDir, timeout: 10_000,
    }).trim();
    return { branch, prNumber };
  } catch {
    return null;
  }
}

// ────────────────────────────────────────────────────────────────
// Scan all Claude project directories for session data
// ────────────────────────────────────────────────────────────────

interface SessionScanResult {
  totalCostUsd: number;
  models: Record<string, ModelTokenUsage>;
  sessionCount: number;
  turnCount: number;
}

function scanAllProjectsForBranch(branchName: string): SessionScanResult | null {
  const claudeProjectsRoot = join(homedir(), '.claude', 'projects');
  if (!existsSync(claudeProjectsRoot)) return null;

  // Scan ALL project directories — worktrees may have been at different
  // locations (e.g. ~/Dropbox/worktrees/ or ~/Dropbox/wavemill/worktrees/)
  const projectDirs = readdirSync(claudeProjectsRoot, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => join(claudeProjectsRoot, d.name));

  const models: Record<string, Omit<ModelTokenUsage, 'costUsd'>> = {};
  let turnCount = 0;
  let sessionCount = 0;

  for (const projectDir of projectDirs) {
    let sessionFiles: string[];
    try {
      sessionFiles = readdirSync(projectDir)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => join(projectDir, f));
    } catch { continue; }

    for (const filePath of sessionFiles) {
      let sessionHadTurns = false;

      try {
        const fileContent = readFileSync(filePath, 'utf-8');
        const lines = fileContent.split('\n');

        for (const line of lines) {
          if (!line.trim()) continue;

          let entry;
          try { entry = JSON.parse(line); } catch { continue; }

          if (entry.type !== 'assistant') continue;
          if (entry.gitBranch !== branchName) continue;

          const message = entry.message;
          if (!message?.usage) continue;

          const usage = message.usage;
          const modelId = message.model || 'unknown';
          const inputTokens = usage.input_tokens || 0;
          const cacheCreationTokens = usage.cache_creation_input_tokens || 0;
          const cacheReadTokens = usage.cache_read_input_tokens || 0;
          const outputTokens = usage.output_tokens || 0;

          if (!models[modelId]) {
            models[modelId] = { inputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 0 };
          }

          models[modelId].inputTokens += inputTokens;
          models[modelId].cacheCreationTokens += cacheCreationTokens;
          models[modelId].cacheReadTokens += cacheReadTokens;
          models[modelId].outputTokens += outputTokens;

          turnCount++;
          sessionHadTurns = true;
        }
      } catch { continue; }

      if (sessionHadTurns) sessionCount++;
    }
  }

  if (turnCount === 0) return null;

  // Compute costs
  const pricingTable = loadPricingTable(repoDir);
  let totalCostUsd = 0;
  const modelsWithCost: Record<string, ModelTokenUsage> = {};

  for (const [modelId, usage] of Object.entries(models)) {
    const pricing = pricingTable[modelId];
    let costUsd = 0;
    if (pricing) {
      costUsd = computeModelCost(usage, pricing);
    }
    modelsWithCost[modelId] = { ...usage, costUsd };
    totalCostUsd += costUsd;
  }

  return { totalCostUsd, models: modelsWithCost, sessionCount, turnCount };
}

// ────────────────────────────────────────────────────────────────
// Backfill
// ────────────────────────────────────────────────────────────────

console.log(DRY_RUN ? '\n[DRY RUN] No changes will be written.\n' : '');

let updated = 0;
let skipped = 0;
let noData = 0;

for (let i = 0; i < records.length; i++) {
  const record = records[i];
  const issueId = record.issueId || '(no issue)';
  const prUrl = record.prUrl || '';

  // Skip if already has workflow cost
  if (record.workflowCost !== undefined) {
    console.log(`  ${i + 1}. ${issueId}: already has workflowCost ($${record.workflowCost.toFixed(4)}) — skipped`);
    skipped++;
    continue;
  }

  // Get branch from PR
  const prInfo = prUrl ? getPrBranch(prUrl) : null;
  if (!prInfo) {
    console.log(`  ${i + 1}. ${issueId}: could not determine branch from PR — skipped`);
    noData++;
    continue;
  }

  // Scan sessions
  const costResult = scanAllProjectsForBranch(prInfo.branch);
  if (!costResult) {
    console.log(`  ${i + 1}. ${issueId}: no session data for branch ${prInfo.branch} — skipped`);
    noData++;
    continue;
  }

  // Apply to record
  record.workflowCost = costResult.totalCostUsd;
  record.workflowTokenUsage = costResult.models;

  const modelSummary = Object.entries(costResult.models)
    .map(([m, u]) => `${m}: $${u.costUsd.toFixed(4)}`)
    .join(', ');
  console.log(
    `  ${i + 1}. ${issueId}: $${costResult.totalCostUsd.toFixed(4)} ` +
    `(${costResult.turnCount} turns, ${costResult.sessionCount} sessions) [${modelSummary}]`
  );
  updated++;
}

console.log(`\nSummary: ${updated} updated, ${skipped} already had data, ${noData} no session data`);

// Write back
if (!DRY_RUN && updated > 0) {
  const output = records.map(r => JSON.stringify(r)).join('\n') + '\n';
  writeFileSync(evalsFile, output, 'utf-8');
  console.log(`\nWritten ${records.length} records to ${evalsFile}`);
} else if (DRY_RUN) {
  console.log('\n[DRY RUN] No changes written.');
}
