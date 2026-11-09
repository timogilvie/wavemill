#!/usr/bin/env -S npx tsx
/**
 * Operator tools check (HOK-3462): every tool is discoverable, and every
 * tool in docs/operator-tools.md still loads with --help.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runTool, resolveRepoDir } from '../shared/lib/tool-runner.ts';
import {
  OPERATOR_TOOLS_INDEX,
  checkOperatorToolsIndex,
  parseOperatorToolsIndex,
  runHelpChecks,
} from '../shared/lib/operator-tools-index.ts';

runTool({
  name: 'check-operator-tools',
  description: `Check that unreferenced tools are listed in ${OPERATOR_TOOLS_INDEX} and that each listed tool runs with --help`,
  options: {
    'repo-dir': { type: 'string', description: 'Repository root (default: cwd)' },
    'skip-help': { type: 'boolean', description: 'Only check the index, not --help' },
  },
  examples: ['npx tsx tools/check-operator-tools.ts', 'npx tsx tools/check-operator-tools.ts --skip-help'],
  async run({ args }) {
    const repoDir = resolveRepoDir(args['repo-dir'] as string | undefined);
    const problems: string[] = [];

    const findings = checkOperatorToolsIndex(repoDir);
    for (const tool of findings.unindexed) {
      problems.push(`${tool}: nothing references it; add a line to ${OPERATOR_TOOLS_INDEX} or delete it`);
    }
    for (const tool of findings.missingFiles) {
      problems.push(`${tool}: listed in ${OPERATOR_TOOLS_INDEX} but the file doesn't exist; remove the line`);
    }
    for (const tool of findings.duplicates) {
      problems.push(`${tool}: listed more than once in ${OPERATOR_TOOLS_INDEX}`);
    }

    const { tools } = parseOperatorToolsIndex(readFileSync(join(repoDir, OPERATOR_TOOLS_INDEX), 'utf-8'));
    const present = tools.filter((tool) => !findings.missingFiles.includes(tool));
    if (!args['skip-help']) {
      for (const result of await runHelpChecks(present, { repoDir })) {
        if (!result.ok) problems.push(`${result.tool}: --help failed (${result.reason})`);
      }
    }

    if (problems.length > 0) {
      console.error(`check-operator-tools: ${problems.length} problem(s)`);
      for (const problem of problems) console.error(`  - ${problem}`);
      process.exit(1);
    }
    console.log(`check-operator-tools: ${present.length} indexed tool(s) OK${args['skip-help'] ? ' (--help skipped)' : ''}`);
  },
});
