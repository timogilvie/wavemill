#!/usr/bin/env -S npx tsx
import { runTool, resolveRepoDir } from '../shared/lib/tool-runner.ts';
import {
  REVIEW_SCOPE_GUARD_EXIT_NO_PR,
  REVIEW_SCOPE_GUARD_EXIT_OK,
  REVIEW_SCOPE_GUARD_EXIT_POLICY,
  REVIEW_SCOPE_GUARD_EXIT_TOOL,
  REVIEW_SCOPE_GUARD_UNVERIFIED_MESSAGE,
  formatReviewScopeGuardResult,
  validateReviewScope,
  resolveTaskFeatureDir,
  type ReviewScopeGuardResult,
} from '../shared/lib/review-scope-guard.ts';
import { writeMarker } from '../shared/lib/transient-marker.ts';
import type { ReviewGateFinding } from '../shared/lib/review-gate-remediation.ts';
import { join } from 'node:path';
import { execShellCommand } from '../shared/lib/shell-utils.ts';

function exitCodeForResult(result: ReviewScopeGuardResult): number {
  if (result.status === 'pass') {
    // "No PR yet" is a distinct informational outcome (HOK-2913), never a
    // policy violation: callers treat it exactly like a pass.
    return result.prLookup === 'none' ? REVIEW_SCOPE_GUARD_EXIT_NO_PR : REVIEW_SCOPE_GUARD_EXIT_OK;
  }
  if (result.status === 'fail') {
    return REVIEW_SCOPE_GUARD_EXIT_POLICY;
  }
  return REVIEW_SCOPE_GUARD_EXIT_TOOL;
}

runTool({
  name: 'check-review-scope',
  description:
    'Block out-of-scope staged files before review-fix commits. With no arguments beyond '
    + '--repo-dir, scope is derived from git (merge base against the integration branch) '
    + 'and the staged index plus working tree are fully evaluated. '
    + 'Exit codes: 0 in scope, 1 policy violation, 2 tool/git failure (scope unverified), '
    + '3 in scope but no PR exists for the branch yet (normal pre-PR state — proceed as for 0).',
  options: {
    'repo-dir': { type: 'string', description: 'Repository directory' },
    'feature-dir': { type: 'string', description: 'Task feature directory (optional narrowing signal)' },
    'since-commit': { type: 'string', description: 'Review base commit recorded before coding' },
    'base-ref': { type: 'string', description: 'Explicit base ref for committed diff inspection' },
    'head-ref': { type: 'string', description: 'Head ref to inspect (default: HEAD)' },
    'integration-ref': { type: 'string', description: 'Integration ref for merge-base scope derivation (default: configured integration branch)' },
    'no-working-tree': { type: 'boolean', description: 'Do not include staged/working-tree changes' },
    'state-dir': { type: 'string', description: 'State directory for writing marker (overrides feature dir resolution)' },
    json: { type: 'boolean', description: 'Emit machine-readable JSON' },
  },
  examples: [
    'npx tsx tools/check-review-scope.ts --repo-dir .',
    'npx tsx tools/check-review-scope.ts --repo-dir . --since-commit abc123',
    'npx tsx tools/check-review-scope.ts --repo-dir . --integration-ref auto/integration',
  ],
  async run({ args }) {
    try {
      const repoDir = resolveRepoDir(args['repo-dir'] as string | undefined);
      const result = validateReviewScope({
        repoDir,
        featureDir: args['feature-dir'] as string | undefined,
        sinceCommit: args['since-commit'] as string | undefined,
        baseRef: args['base-ref'] as string | undefined,
        headRef: (args['head-ref'] as string | undefined) ?? 'HEAD',
        integrationRef: args['integration-ref'] as string | undefined,
        includeWorkingTree: !args['no-working-tree'],
        writeBaseline: true,
      });

      // Write the typed stop record if this is a scope violation. Failing to
      // record it would silently reproduce the HOK-3358 stall (the mill reads
      // this marker to return the task to coding), so a resolve/write failure
      // is a hard tool-infrastructure error (exit 2), not a soft warning.
      if (result.status === 'fail' && exitCodeForResult(result) === REVIEW_SCOPE_GUARD_EXIT_POLICY) {
        const stateDir = args['state-dir'] as string | undefined;
        const featureDir = stateDir ?? resolveTaskFeatureDir(repoDir);

        if (!featureDir) {
          throw new Error(
            'Review scope guard refused the diff but could not resolve the task feature directory '
            + 'for the scope-stop marker; pass --state-dir or --feature-dir so the mill can route '
            + 'the task back to coding.',
          );
        }

        const head = (execShellCommand('git rev-parse HEAD', { cwd: repoDir, encoding: 'utf-8' }) as string).trim();
        const findings: ReviewGateFinding[] = result.findings
          .filter(f => f.severity === 'blocker' && f.kind === 'violation' && f.category === 'review-scope')
          .map(finding => ({
            category: 'scope-violation',
            offendingPath: finding.path,
            message: finding.message,
          }));

        if (findings.length > 0) {
          writeMarker(
            { path: join(featureDir, '.review-scope-stop.json'), kind: 'review-scope-stop' },
            {
              headSha: head,
              reason: 'review scope guard refused staged/committed paths',
              detail: { findings, offendingPaths: result.outOfScopePaths },
              condition: {
                head,
                expiresOn: ['head', 'operator-event'],
              },
            },
          );
        }
      }

      if (args.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(formatReviewScopeGuardResult(result));
      }
      process.exit(exitCodeForResult(result));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (args.json) {
        console.log(JSON.stringify({ ok: false, status: 'error', error: message }, null, 2));
      } else {
        console.error(`Review scope guard error (scope unverified): ${message}\n${REVIEW_SCOPE_GUARD_UNVERIFIED_MESSAGE}`);
      }
      process.exit(REVIEW_SCOPE_GUARD_EXIT_TOOL);
    }
  },
});
