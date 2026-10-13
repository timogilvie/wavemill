#!/usr/bin/env -S npx tsx

/**
 * One batched `gh pr list` query for a set of task branches, written to the
 * session PR cache (HOK-3206). The monitor's hot pass uses the equivalent
 * shell form (`wavemill_pr_cache_refresh`) to avoid a tsx spawn; this tool is
 * the canonical implementation for one-shot CLIs and tests. Both write the
 * same schema atomically (tmp + rename).
 */

import { execFile } from 'node:child_process';
import { renameSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { fetchBatchedPullRequests } from '../shared/lib/session-gh-cache.ts';
import { runTool } from '../shared/lib/tool-runner.ts';

const execFileAsync = promisify(execFile);

runTool({
  name: 'batch-pr-fetch',
  description: 'Fetch PR rows for task branches in one gh call and write the session PR cache',
  options: {
    branch: {
      type: 'string',
      description: 'Comma-separated task branches (omit for the open-PR dump)',
    },
    output: {
      type: 'string',
      description: 'Cache file to write (default: stdout only)',
    },
    'repo-dir': {
      type: 'string',
      description: 'Repository directory (default: current directory)',
    },
  },
  examples: [
    'npx tsx tools/batch-pr-fetch.ts --branch task/a,task/b --output /tmp/s-pr-cache.json',
  ],
  async run({ args }) {
    const branches = String(args.branch ?? '').split(',').map((b) => b.trim()).filter(Boolean);
    const cwd = args['repo-dir'] ? String(args['repo-dir']) : process.cwd();
    const rows = await fetchBatchedPullRequests(branches, async (ghArgs) => {
      const { stdout } = await execFileAsync('gh', ghArgs, { cwd, encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024 });
      return stdout;
    });
    const payload = `${JSON.stringify(rows)}\n`;
    if (args.output) {
      const output = String(args.output);
      const tmp = `${output}.tmp.${process.pid}`;
      writeFileSync(tmp, payload, 'utf-8');
      renameSync(tmp, output);
    }
    process.stdout.write(payload);
  },
});
