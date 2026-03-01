#!/usr/bin/env -S npx tsx
import { runTool } from '../shared/lib/tool-runner.ts';
import { resolve } from 'node:path';
import { gatherReviewContext } from '../shared/lib/review-context-gatherer.ts';

runTool({
  name: 'gather-review-context',
  description: 'Gather review context for the current branch',
  options: {
    help: { type: 'boolean', short: 'h', description: 'Show help' },
  },
  positional: {
    name: 'targetBranch repoDir',
    description: 'Target branch and repo directory',
    multiple: true,
  },
  examples: [
    'npx tsx tools/gather-review-context.ts',
    'npx tsx tools/gather-review-context.ts develop',
    'npx tsx tools/gather-review-context.ts main /path/to/repo',
  ],
  additionalHelp: `Gathers review context including:
- Git diff against target branch
- Task packet (if found)
- Plan document (if found)
- Design context (if enabled and artifacts exist)
- Metadata (branch, files, line counts, UI changes)

Outputs JSON to stdout.`,
  run({ positional }) {
    const targetBranch = positional[0] || 'main';
    const repoDir = positional[1] ? resolve(positional[1]) : process.cwd();

    const context = gatherReviewContext(targetBranch, repoDir);
    console.log(JSON.stringify(context, null, 2));
  },
});
