#!/usr/bin/env -S npx tsx

import { execFile as execFileCb } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { getMillConfig } from '../shared/lib/config.ts';
import { errorMessage } from '../shared/lib/error-utils.ts';
import { runTool } from '../shared/lib/tool-runner.ts';
import { tickReadyWatchdog } from '../shared/lib/ready-watchdog.ts';
import { readWorkflowState } from '../shared/lib/workflow-state.ts';

const execFile = promisify(execFileCb);
const READY_WATCHDOG_TOOL_PATH = fileURLToPath(import.meta.url);
const WAVEMILL_TOOLS_DIR = path.dirname(READY_WATCHDOG_TOOL_PATH);
const WAVEMILL_ROOT = path.dirname(WAVEMILL_TOOLS_DIR);
const WAVEMILL_LIB_DIR = path.join(WAVEMILL_ROOT, 'shared', 'lib');

async function launchRemediation(args: {
  repoDir: string;
  stateFile: string;
  issueId: string;
  failedCheckSummary: string;
  failedCheckNamesJson: string;
  attemptNumber: number;
  maxAttempts: number;
}) {
  const task = readWorkflowState(args.stateFile)?.tasks?.[args.issueId];
  if (!task) {
    return {
      status: 'failed',
      detail: `Ready watchdog could not find workflow task ${args.issueId}.`,
      attemptNumber: args.attemptNumber,
    };
  }

  const worktree = String(task.worktree ?? '');
  const slug = String(task.slug ?? '');
  const branch = String(task.branch ?? '');
  const prNumber = Number(task.pr ?? 0);
  const baseBranch = getMillConfig(args.repoDir).baseBranch ?? 'main';
  if (!worktree || !slug || !branch || !Number.isFinite(prNumber) || prNumber <= 0) {
    return {
      status: 'failed',
      detail: `Ready watchdog could not resolve launch metadata for ${args.issueId}.`,
      attemptNumber: args.attemptNumber,
    };
  }

  const session = process.env.SESSION || 'wavemill';
  const scriptPath = `/tmp/${session}-monitor.sh`;
  const monitorEnvPath = `/tmp/${session}-monitor.env`;
  const launchCommand = `
    set -euo pipefail
    source "$WAVEMILL_SCRIPT_PATH" "$WAVEMILL_MONITOR_ENV_PATH"
    launch_ready_watchdog_remediation \
      "$WAVEMILL_ISSUE_ID" \
      "$WAVEMILL_SLUG" \
      "$WAVEMILL_WORKTREE" \
      "$WAVEMILL_BRANCH" \
      "$WAVEMILL_BASE_BRANCH" \
      "$WAVEMILL_PR_NUMBER" \
      "$WAVEMILL_FAILED_CHECK_SUMMARY" \
      "$WAVEMILL_ATTEMPT_NUMBER" \
      "$WAVEMILL_MAX_ATTEMPTS" \
      "$WAVEMILL_FAILED_CHECK_NAMES_JSON"
  `;
  try {
    const childEnv = {
      ...process.env,
      SESSION: session,
      TOOLS_DIR: WAVEMILL_TOOLS_DIR,
      LIB_DIR: WAVEMILL_LIB_DIR,
      WAVEMILL_READY_WATCHDOG_SOURCE_ONLY: '1',
      WAVEMILL_MILL_LIB_DIR: WAVEMILL_LIB_DIR,
      _WAVEMILL_MILL_REEXEC: process.env._WAVEMILL_MILL_REEXEC || '1',
      WAVEMILL_SCRIPT_PATH: scriptPath,
      WAVEMILL_MONITOR_ENV_PATH: monitorEnvPath,
      WAVEMILL_ISSUE_ID: args.issueId,
      WAVEMILL_SLUG: slug,
      WAVEMILL_WORKTREE: worktree,
      WAVEMILL_BRANCH: branch,
      WAVEMILL_BASE_BRANCH: baseBranch,
      WAVEMILL_PR_NUMBER: String(prNumber),
      WAVEMILL_FAILED_CHECK_SUMMARY: args.failedCheckSummary,
      WAVEMILL_ATTEMPT_NUMBER: String(args.attemptNumber),
      WAVEMILL_MAX_ATTEMPTS: String(args.maxAttempts),
      WAVEMILL_FAILED_CHECK_NAMES_JSON: args.failedCheckNamesJson,
    };
    delete childEnv.npm_config_prefix;

    const { stdout } = await execFile('bash', ['-c', launchCommand], {
      cwd: args.repoDir,
      encoding: 'utf-8',
      env: childEnv,
      maxBuffer: 1024 * 1024,
    });
    const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
    return JSON.parse(lines[lines.length - 1] || '{}') as Record<string, unknown>;
  } catch (error) {
    return {
      status: 'failed',
      detail: `Ready watchdog launch failed: ${errorMessage(error)}`,
      attemptNumber: args.attemptNumber,
    };
  }
}

runTool({
  name: 'ready-watchdog',
  description: 'Classify and recover stale ready-stage local state',
  options: {
    'repo-dir': {
      type: 'string',
      description: 'Repository directory (default: current directory)',
    },
    'state-file': {
      type: 'string',
      description: 'Workflow state file path (default: <repo>/.wavemill/workflow-state.json)',
    },
    once: {
      type: 'boolean',
      description: 'Run a single watchdog tick and exit',
      default: true,
    },
    json: {
      type: 'boolean',
      description: 'Emit machine-readable JSON output',
    },
    recover: {
      type: 'string',
      description: 'Force a recovery attempt for one ready-stage issue id',
    },
    'launch-remediation': {
      type: 'string',
      description: 'Launch a ready remediation attempt for one ready-stage issue id',
    },
    'failed-check-summary': {
      type: 'string',
      description: 'Human summary of failing checks for launch mode',
    },
    'failed-check-names-json': {
      type: 'string',
      description: 'JSON array of failing check names for launch mode',
    },
    'attempt-number': {
      type: 'string',
      description: '1-based remediation attempt number for launch mode',
    },
    'max-attempts': {
      type: 'string',
      description: 'Remediation attempt cap for launch mode',
    },
  },
  async run({ args }) {
    const repoDir = path.resolve(args['repo-dir'] || process.cwd());
    const stateFile = path.resolve(args['state-file'] || path.join(repoDir, '.wavemill', 'workflow-state.json'));
    if (args['launch-remediation']) {
      const result = await launchRemediation({
        repoDir,
        stateFile,
        issueId: args['launch-remediation'],
        failedCheckSummary: args['failed-check-summary'] || 'checks failing',
        failedCheckNamesJson: args['failed-check-names-json'] || '[]',
        attemptNumber: Number(args['attempt-number'] || '1'),
        maxAttempts: Number(args['max-attempts'] || '3'),
      });
      console.log(JSON.stringify(result));
      return;
    }

    const result = await tickReadyWatchdog({
      repoDir,
      stateFile,
      issueFilter: args.recover,
      forceRecover: Boolean(args.recover),
      readyWatchdogToolPath: READY_WATCHDOG_TOOL_PATH,
    });

    if (args.json) {
      console.log(JSON.stringify(result));
      return;
    }

    if (result.findings.length === 0) {
      console.log('No stale ready-stage tasks detected.');
      return;
    }

    for (const finding of result.findings) {
      console.log(
        `${finding.issueId} ${finding.displayLabel}: ${finding.detail}`
        + (finding.recoveryCommand ? `\n  recovery: ${finding.recoveryCommand}` : ''),
      );
    }
  },
});
