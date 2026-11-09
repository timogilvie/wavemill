#!/usr/bin/env node

import { recoverSupersededPr } from '../shared/lib/challenge-recovery.ts';
import { runTool } from '../shared/lib/tool-runner.ts';

runTool({
  name: 'challenge-recover',
  description: 'Recover PRs erroneously closed with wm:superseded label due to invalid challenge comparison.',
  options: {
    pr: { type: 'string', multiple: true, description: 'PR number(s); repeat the flag or pass a comma-separated list' },
    'dry-run': { type: 'boolean', description: 'Print the planned actions without changing GitHub or workflow state' },
    'repo-dir': { type: 'string', description: 'Repository root (default: cwd)' },
  },
  examples: [
    'npx tsx tools/challenge-recover.ts --pr 1234 --dry-run',
    'npx tsx tools/challenge-recover.ts --pr 1234,1235',
  ],
  async run({ args }) {
    const prArgs = args.pr ?? [];
    const dryRun = args['dry-run'] === true;
    const repoDir = args['repo-dir'] ?? process.cwd();

    if (prArgs.length === 0) {
      console.error('Error: At least one PR number required via --pr');
      process.exit(1);
    }

    // Parse PR numbers from comma-separated or repeated --pr flags
    const prNumbers = new Set<number>();
    for (const arg of prArgs) {
      const parts = String(arg).split(',');
      for (const part of parts) {
        const trimmed = part.trim();
        if (trimmed) {
          const prNum = Number(trimmed);
          if (Number.isInteger(prNum) && prNum > 0) {
            prNumbers.add(prNum);
          } else {
            console.error(`Warning: Invalid PR number: ${trimmed}`);
          }
        }
      }
    }

    if (prNumbers.size === 0) {
      console.error('Error: No valid PR numbers provided');
      process.exit(1);
    }

    const mode = dryRun ? '[DRY RUN]' : '';
    console.log(`${mode} Recovering ${prNumbers.size} PR(s)...`);

    let successCount = 0;
    let errorCount = 0;

    for (const prNumber of Array.from(prNumbers).sort((a, b) => a - b)) {
      const result = await recoverSupersededPr({
        prNumber,
        repoDir,
        dryRun,
      });

      if (result.status === 'recovered') {
        console.log(`✓ PR #${prNumber}: ${result.message}`);
        successCount++;
      } else if (result.status === 'already_recovered') {
        console.log(`~ PR #${prNumber}: Already recovered`);
        successCount++;
      } else if (result.status === 'not_superseded') {
        console.log(`- PR #${prNumber}: Not superseded`);
      } else if (result.status === 'not_found') {
        console.log(`✗ PR #${prNumber}: Not found`);
        errorCount++;
      } else if (result.status === 'error') {
        console.error(`✗ PR #${prNumber}: ${result.message}`);
        errorCount++;
      }
    }

    console.log(`\nSummary: ${successCount} recovered, ${errorCount} errors`);

    if (errorCount > 0) {
      process.exit(1);
    }
  },
});
