#!/usr/bin/env -S npx tsx
import { runTool, resolveRepoDir } from '../shared/lib/tool-runner.ts';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  INTEGRATION_DEFAULTS,
  loadWavemillConfig,
  getIntegrationConfig,
  getReviewMergeConfig,
} from '../shared/lib/config.ts';
import {
  detectCrossPrReverts,
  filterUnacknowledgedReverts,
  parseRevertAcknowledgements,
} from '../shared/lib/cross-pr-revert-detector.ts';
import { escapeShellArg, execShellCommand } from '../shared/lib/shell-utils.ts';
import { resolveDefaultBaseRef, resolveOriginFirstRef } from '../shared/lib/git-base-resolver.ts';

export const crossPrRevertCheckDeps = {
  detectCrossPrReverts,
  execShellCommand,
  resolveDefaultBaseRef,
  resolveOriginFirstRef,
};

// Exit-code contract:
// 0: pass, 1: unacknowledged cross-PR revert, 2: tool/config/infrastructure failure.
const EXIT_OK = 0;
const EXIT_POLICY = 1;
const EXIT_TOOL = 2;
const STDERR_TRUNCATE_MAX = 2048;

export interface ToolFailureDiagnostic {
  commandClass: string;
  command: string;
  ref: string;
  stderr: string;
}

export interface CrossPrRevertCheckResult {
  blocked: boolean;
  disabled?: boolean;
  reverts: ReturnType<typeof detectCrossPrReverts>;
  acknowledged: ReturnType<typeof detectCrossPrReverts>;
  unacknowledged: ReturnType<typeof detectCrossPrReverts>;
  toolError?: ToolFailureDiagnostic;
}

function truncateOutput(text: string, max = STDERR_TRUNCATE_MAX): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(-max)}…[truncated]`;
}

export function runCrossPrRevertCheck(input: {
  repoDir: string;
  baseRef?: string;
  headRef?: string;
  integrationRef?: string;
  acknowledgementText?: string;
  maxRecentMerges?: number;
}): CrossPrRevertCheckResult {
  const reviewMergeConfig = getReviewMergeConfig(input.repoDir);
  if (!reviewMergeConfig.crossPrRevertCheck.enabled) {
    return {
      blocked: false,
      disabled: true,
      reverts: [],
      acknowledged: [],
      unacknowledged: [],
    };
  }

  const rawConfig = loadWavemillConfig(input.repoDir);
  const integrationConfig = getIntegrationConfig(input.repoDir);
  const hasLocalConfigFile = existsSync(path.join(input.repoDir, '.wavemill-config.json'))
    || existsSync(path.join(input.repoDir, '.wavemill-config.local.json'));
  let integrationRef = input.integrationRef || integrationConfig.integrationBranch;
  if (!input.integrationRef
    && integrationRef === INTEGRATION_DEFAULTS.integrationBranch
    && !rawConfig.integration?.integrationBranch
    && !hasLocalConfigFile) {
    integrationRef = crossPrRevertCheckDeps.resolveDefaultBaseRef(input.repoDir) ?? integrationRef;
  }
  integrationRef = crossPrRevertCheckDeps.resolveOriginFirstRef(input.repoDir, integrationRef).ref;
  const headRef = input.headRef || 'HEAD';
  let baseRef: string;
  let reverts: ReturnType<typeof detectCrossPrReverts>;

  try {
    const providedBaseRef = input.baseRef
      ? crossPrRevertCheckDeps.resolveOriginFirstRef(input.repoDir, input.baseRef).ref
      : undefined;
    baseRef = providedBaseRef || String(crossPrRevertCheckDeps.execShellCommand(
      `git merge-base ${escapeShellArg(integrationRef)} ${escapeShellArg(headRef)}`,
      { cwd: input.repoDir, encoding: 'utf-8' },
    )).trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      blocked: false,
      reverts: [],
      acknowledged: [],
      unacknowledged: [],
      toolError: {
        commandClass: 'git-merge-base',
        command: `git merge-base ${integrationRef} ${headRef}`,
        ref: integrationRef,
        stderr: truncateOutput(message),
      },
    };
  }

  reverts = crossPrRevertCheckDeps.detectCrossPrReverts({
    repoDir: input.repoDir,
    baseRef,
    headRef,
    integrationRef,
    maxRecentMerges: input.maxRecentMerges ?? reviewMergeConfig.crossPrRevertCheck.maxRecentMerges,
  });

  const acknowledgements = parseRevertAcknowledgements(
    input.acknowledgementText ?? loadAcknowledgementText(input.repoDir),
  );
  const unacknowledged = filterUnacknowledgedReverts(reverts, acknowledgements);
  const acknowledged = reverts.filter((finding) => acknowledgements.has(finding.prNumber));

  return {
    blocked: unacknowledged.length > 0,
    reverts,
    acknowledged,
    unacknowledged,
  };
}

function loadAcknowledgementText(repoDir: string): string {
  try {
    return String(crossPrRevertCheckDeps.execShellCommand(
      'gh pr view --json body,title --jq \'.title + "\\n" + (.body // "")\'',
      { cwd: repoDir, encoding: 'utf-8' },
    ));
  } catch {
    try {
      return String(crossPrRevertCheckDeps.execShellCommand(
        'git log --format=%B -n 20 HEAD',
        { cwd: repoDir, encoding: 'utf-8' },
      ));
    } catch {
      return '';
    }
  }
}

function printResultAndExit(result: CrossPrRevertCheckResult): never {
  console.log(JSON.stringify(result, null, 2));
  if (result.toolError) {
    process.exit(EXIT_TOOL);
  }
  process.exit(result.blocked ? EXIT_POLICY : EXIT_OK);
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);

if (isMainModule) {
  runTool({
    name: 'check-cross-pr-reverts',
    description: 'Detect unacknowledged deletions of files introduced by other recent integration PRs',
    options: {
      'repo-dir': { type: 'string', description: 'Repository directory' },
      'base-ref': { type: 'string', description: 'Explicit base ref for diffing the candidate branch' },
      'head-ref': { type: 'string', description: 'Head ref to inspect (default: HEAD)' },
      'integration-ref': { type: 'string', description: 'Integration branch/ref (default from config)' },
      ack: { type: 'string', description: 'Explicit acknowledgement text to parse instead of PR metadata' },
      'max-recent-merges': { type: 'string', description: 'Override scan depth for recent integration commits' },
    },
    examples: [
      'npx tsx tools/check-cross-pr-reverts.ts --repo-dir .',
      'npx tsx tools/check-cross-pr-reverts.ts --repo-dir . --head-ref HEAD --base-ref abc123',
    ],
    async run({ args }) {
      try {
        const repoDir = resolveRepoDir(args['repo-dir'] as string | undefined);
        const maxRecentMerges = args['max-recent-merges']
          ? Number.parseInt(String(args['max-recent-merges']), 10)
          : undefined;
        if (args['max-recent-merges'] && (!Number.isInteger(maxRecentMerges) || maxRecentMerges <= 0)) {
          throw new Error('--max-recent-merges must be a positive integer');
        }

        const result = runCrossPrRevertCheck({
          repoDir,
          baseRef: args['base-ref'] as string | undefined,
          headRef: args['head-ref'] as string | undefined,
          integrationRef: args['integration-ref'] as string | undefined,
          acknowledgementText: args.ack as string | undefined,
          maxRecentMerges,
        });

        printResultAndExit(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const errorResult: CrossPrRevertCheckResult = {
          blocked: false,
          reverts: [],
          acknowledged: [],
          unacknowledged: [],
          toolError: {
            commandClass: 'internal',
            command: 'check-cross-pr-reverts',
            ref: String(args['integration-ref'] ?? ''),
            stderr: truncateOutput(message),
          },
        };
        console.log(JSON.stringify(errorResult, null, 2));
        process.exit(EXIT_TOOL);
      }
    },
  });
}
