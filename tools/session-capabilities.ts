#!/usr/bin/env -S npx tsx
/**
 * session-capabilities — print the current session's active-consumer set.
 *
 * Thin CLI wrapper around `resolveSessionCapabilities` in shared/lib/config.ts
 * (HOK-3102). Shell callers in `wavemill-common.sh` (`wavemill_session_*`)
 * spawn this tool once per config change and cache the result.
 *
 * Emits a single JSON line to stdout.
 */
import { runTool, resolveRepoDir } from '../shared/lib/tool-runner.ts';
import { resolveSessionCapabilities } from '../shared/lib/config.ts';

runTool({
  name: 'session-capabilities',
  description: 'Print the session capability set (tend/observer/mergeExecutor/mergeQueue)',
  options: {
    'repo-dir': { type: 'string', description: 'Repository directory (default: cwd)' },
    'no-health': { type: 'boolean', description: 'Skip reading backstage-health.json' },
    json: { type: 'boolean', description: 'Emit JSON (default)' },
  },
  examples: [
    'npx tsx tools/session-capabilities.ts',
    'npx tsx tools/session-capabilities.ts --repo-dir /path/to/repo --no-health',
  ],
  additionalHelp: `Returns {tend, observer, mergeExecutor, mergeQueue, reasons, health}.
mergeExecutor is one of 'tend' | 'operator' | 'none'.`,
  async run({ args }) {
    const repoDir = resolveRepoDir((args['repo-dir'] as string | undefined) ?? undefined);
    const caps = resolveSessionCapabilities(repoDir, {
      readHealth: !args['no-health'],
    });
    process.stdout.write(JSON.stringify(caps) + '\n');
  },
});
