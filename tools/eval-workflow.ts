#!/usr/bin/env -S npx tsx
// @ts-nocheck

/**
 * Eval Workflow Tool
 *
 * Evaluates LLM performance on a completed workflow by gathering context
 * and calling the shared evaluateTask() judge function.
 *
 * Usage:
 *   npx tsx tools/eval-workflow.ts
 *   npx tsx tools/eval-workflow.ts --issue HOK-123 --pr 456
 */

import dotenv from 'dotenv';
import { execSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { evaluateTask } from '../shared/lib/eval.js';
import { getScoreBand } from '../shared/lib/eval-schema.ts';
import { appendEvalRecord } from '../shared/lib/eval-persistence.ts';
import {
  detectAllInterventions,
  toInterventionMeta,
  formatForJudge,
  loadPenalties,
} from '../shared/lib/intervention-detector.ts';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Argument Parsing ─────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--issue' && argv[i + 1]) {
      args.issue = argv[++i];
    } else if (argv[i] === '--pr' && argv[i + 1]) {
      args.pr = argv[++i];
    } else if (argv[i] === '--model' && argv[i + 1]) {
      args.model = argv[++i];
    } else if (argv[i] === '--repo-dir' && argv[i + 1]) {
      args.repoDir = argv[++i];
    } else if (argv[i] === '--help' || argv[i] === '-h') {
      args.help = true;
    }
  }
  return args;
}

function showHelp() {
  console.log(`
Eval Workflow Tool — Evaluate LLM performance on a completed workflow

Usage:
  npx tsx tools/eval-workflow.ts [options]

Options:
  --issue ID      Linear issue identifier (e.g., HOK-123)
  --pr NUMBER     GitHub PR number
  --model ID      Override the eval model (default: EVAL_MODEL env or claude-sonnet-4-5-20250929)
  --repo-dir DIR  Repository directory (default: current directory)
  --help, -h      Show this help message

Examples:
  # Auto-detect from most recent wavemill workflow
  npx tsx tools/eval-workflow.ts

  # Evaluate a specific issue and PR
  npx tsx tools/eval-workflow.ts --issue HOK-699 --pr 42

Context Resolution:
  1. Explicit arguments (--issue, --pr) take priority
  2. Falls back to .wavemill/workflow-state.json (most recent task with PR)
  3. Falls back to current branch's open PR

Environment Variables:
  EVAL_MODEL         Override judge model (default: claude-sonnet-4-5-20250929)
  LINEAR_API_KEY     Required for fetching issue details from Linear

Requires:
  claude CLI installed and authenticated (uses your subscription)
`);
}

// ── Context Gathering ────────────────────────────────────────────────────────

function gatherContext(args) {
  const repoDir = args.repoDir || process.cwd();
  const stateFile = path.join(repoDir, '.wavemill', 'workflow-state.json');

  let issueId = args.issue || '';
  let prNumber = args.pr || '';
  let branch = '';
  let prUrl = '';

  // Try auto-detect from wavemill state file (only when neither was explicitly provided)
  if (!issueId && !prNumber && existsSync(stateFile)) {
    const state = JSON.parse(readFileSync(stateFile, 'utf-8'));
    const tasks = state.tasks || {};

    // Find most recently updated task that has a PR
    let mostRecent = null;
    let mostRecentTime = '';
    for (const [id, task] of Object.entries(tasks)) {
      if (task.pr && (!mostRecentTime || task.updated > mostRecentTime)) {
        mostRecent = { id, ...task };
        mostRecentTime = task.updated;
      }
    }

    if (mostRecent) {
      if (!issueId) issueId = mostRecent.id;
      if (!prNumber) prNumber = String(mostRecent.pr);
      branch = mostRecent.branch || '';
    }
  }

  // Try auto-detect from current branch PR
  if (!prNumber) {
    try {
      branch = execSync('git branch --show-current', {
        encoding: 'utf-8', cwd: repoDir,
      }).trim();
      const prJson = execSync('gh pr view --json number,url 2>/dev/null || echo "{}"', {
        encoding: 'utf-8', cwd: repoDir, shell: '/bin/bash',
      }).trim();
      const prData = JSON.parse(prJson);
      if (prData.number) {
        prNumber = String(prData.number);
        prUrl = prData.url || '';
      }
    } catch {
      // Best-effort
    }
  }

  if (!issueId && !prNumber) {
    throw new Error(
      'No workflow context found. Provide explicit arguments:\n' +
      '  npx tsx tools/eval-workflow.ts --issue HOK-123 --pr 456\n\n' +
      'Or run after a completed wavemill workflow (requires .wavemill/workflow-state.json)'
    );
  }

  // Fetch issue details from Linear
  let taskPrompt = '';
  if (issueId) {
    try {
      const toolPath = path.resolve(__dirname, 'get-issue-json.ts');
      const raw = execSync(
        `npx tsx "${toolPath}" "${issueId}" 2>/dev/null | sed '/^\\[dotenv/d'`,
        { encoding: 'utf-8', cwd: repoDir, shell: '/bin/bash' }
      ).trim();
      const issue = JSON.parse(raw);
      taskPrompt = `# ${issue.identifier}: ${issue.title}\n\n${issue.description || ''}`;
    } catch {
      taskPrompt = `Issue: ${issueId} (details unavailable)`;
    }
  }

  // Fetch PR diff as review output
  let prReviewOutput = '';
  if (prNumber) {
    if (!prUrl) {
      try {
        prUrl = execSync(`gh pr view ${prNumber} --json url --jq .url 2>/dev/null`, {
          encoding: 'utf-8', cwd: repoDir, shell: '/bin/bash',
        }).trim();
      } catch { /* best-effort */ }
    }

    try {
      const diff = execSync(`gh pr diff ${prNumber}`, {
        encoding: 'utf-8', cwd: repoDir, maxBuffer: 10 * 1024 * 1024,
      });
      prReviewOutput = diff;
    } catch {
      prReviewOutput = '(PR diff unavailable)';
    }

    // Append review comments if any
    try {
      const comments = execSync(
        `gh api repos/{owner}/{repo}/pulls/${prNumber}/comments --jq '.[].body' 2>/dev/null || echo ''`,
        { encoding: 'utf-8', cwd: repoDir, shell: '/bin/bash' }
      ).trim();
      if (comments) {
        prReviewOutput += `\n\n## Review Comments\n\n${comments}`;
      }
    } catch { /* best-effort */ }
  }

  // Ensure we have the branch name for intervention detection
  if (!branch) {
    try {
      branch = execSync('git branch --show-current', {
        encoding: 'utf-8', cwd: repoDir,
      }).trim();
    } catch { /* best-effort */ }
  }

  return { issueId, prNumber, prUrl, branch, taskPrompt, prReviewOutput, repoDir };
}

// ── Output Formatting ────────────────────────────────────────────────────────

function formatEvalRecord(record) {
  const CYAN = '\x1b[36m';
  const GREEN = '\x1b[32m';
  const YELLOW = '\x1b[33m';
  const RED = '\x1b[31m';
  const BOLD = '\x1b[1m';
  const DIM = '\x1b[2m';
  const NC = '\x1b[0m';

  const scoreColor = (score) => {
    if (score >= 0.8) return GREEN;
    if (score >= 0.5) return YELLOW;
    return RED;
  };

  const scoreBar = (score) => {
    const filled = Math.round(score * 10);
    const empty = 10 - filled;
    return '\u2588'.repeat(filled) + '\u2591'.repeat(empty);
  };

  const band = getScoreBand(record.score);
  const lines = [];

  lines.push('');
  lines.push(`${BOLD}${CYAN}${'═'.repeat(63)}${NC}`);
  lines.push(`${BOLD}${CYAN}  WORKFLOW EVALUATION${NC}`);
  lines.push(`${BOLD}${CYAN}${'═'.repeat(63)}${NC}`);
  lines.push('');

  // Metadata
  if (record.issueId) lines.push(`  ${DIM}Issue:${NC}  ${record.issueId}`);
  if (record.prUrl) lines.push(`  ${DIM}PR:${NC}     ${record.prUrl}`);
  lines.push(`  ${DIM}Model:${NC}  ${record.judgeModel || record.modelId}`);
  if (record.judgeProvider) lines.push(`  ${DIM}Provider:${NC} ${record.judgeProvider}`);
  if (record.timeSeconds > 0) lines.push(`  ${DIM}Time:${NC}   ${record.timeSeconds}s`);
  lines.push('');

  // Score
  const sc = record.score;
  lines.push(`  ${BOLD}Score:${NC}  ${scoreColor(sc)}${sc.toFixed(2)}${NC}  ${scoreBar(sc)}  ${BOLD}${band.label}${NC}`);
  lines.push(`          ${DIM}${band.description}${NC}`);
  lines.push('');

  // Rationale
  lines.push(`  ${BOLD}Rationale:${NC}`);
  lines.push(`  ${record.rationale}`);
  lines.push('');

  // Interventions
  if (record.interventionRequired) {
    lines.push(`  ${BOLD}${YELLOW}Interventions:${NC} ${record.interventionCount}`);
    for (const detail of record.interventionDetails) {
      lines.push(`    ${YELLOW}-${NC} ${detail}`);
    }
    lines.push('');
  } else {
    lines.push(`  ${BOLD}${GREEN}Interventions:${NC} None (fully autonomous)`);
    lines.push('');
  }

  // Intervention flags from judge
  const flags = record.metadata?.interventionFlags;
  if (flags && flags.length > 0) {
    lines.push(`  ${BOLD}Judge Flags:${NC}`);
    for (const flag of flags) {
      lines.push(`    ${DIM}-${NC} ${flag}`);
    }
    lines.push('');
  }

  lines.push(`${BOLD}${CYAN}${'═'.repeat(63)}${NC}`);
  lines.push('');

  return lines.join('\n');
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    showHelp();
    process.exit(0);
  }

  try {
    // 1. Gather context
    console.log('Gathering workflow context...');
    const ctx = gatherContext(args);

    if (ctx.issueId) console.log(`  Issue: ${ctx.issueId}`);
    if (ctx.prNumber) console.log(`  PR: #${ctx.prNumber}`);
    if (ctx.prReviewOutput) {
      const lines = ctx.prReviewOutput.split('\n').length;
      console.log(`  Diff: ${lines} lines`);
    }

    // 2. Apply model override if specified
    if (args.model) {
      process.env.EVAL_MODEL = args.model;
    }

    // 3. Detect intervention events
    console.log('\nDetecting intervention events...');
    const interventionSummary = detectAllInterventions({
      prNumber: ctx.prNumber,
      branchName: ctx.branch,
      baseBranch: 'main',
      repoDir: ctx.repoDir,
    });
    const interventionMeta = toInterventionMeta(interventionSummary);
    const penalties = loadPenalties(ctx.repoDir);
    const interventionText = formatForJudge(interventionSummary, penalties);

    const totalInterventions = interventionSummary.interventions.reduce((sum, e) => sum + e.count, 0);
    console.log(`  Detected ${totalInterventions} intervention event(s) (weighted penalty: ${interventionSummary.totalInterventionScore})`);

    // 4. Invoke judge via shared evaluateTask()
    console.log('\nInvoking LLM judge...');
    const record = await evaluateTask({
      taskPrompt: ctx.taskPrompt,
      prReviewOutput: ctx.prReviewOutput,
      interventions: interventionMeta,
      interventionText,
      issueId: ctx.issueId || undefined,
      prUrl: ctx.prUrl || undefined,
      metadata: { interventionSummary },
    });

    // 5. Persist eval record to disk
    try {
      appendEvalRecord(record);
    } catch (err) {
      console.error(`Warning: failed to persist eval record: ${err.message}`);
    }

    // 6. Format and print
    console.log(formatEvalRecord(record));

    // 7. Print raw JSON for piping
    if (process.stdout.isTTY === false) {
      console.log(JSON.stringify(record, null, 2));
    }
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

main();
