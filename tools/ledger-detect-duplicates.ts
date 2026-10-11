#!/usr/bin/env -S npx tsx
/**
 * Thin wrapper around detectDuplicates for the monitor tick (HOK-3183).
 *
 * Usage:
 *   npx tsx tools/ledger-detect-duplicates.ts [--repo-dir <dir>] [--since 30m] [--json] [--strict]
 */
import { runTool } from '../shared/lib/tool-runner.ts';
import { Ledger } from '../shared/lib/ledger.ts';
import { withShadowSuppressing } from '../shared/lib/ledger-shadow.ts';
import {
  appendDuplicateLog,
  DEFAULT_DETECTOR_WINDOW_MS,
  detectDuplicates,
  formatFinding,
} from '../shared/lib/side-effect-duplicate-detector.ts';

const UNIT_MS: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** Parse `30m`, `2h`, `45s`, `1d` or a bare millisecond count. */
function parseWindow(value: string | undefined): number {
  if (!value) return DEFAULT_DETECTOR_WINDOW_MS;
  const match = /^(\d+)(ms|s|m|h|d)?$/.exec(value.trim());
  if (!match) throw new Error(`invalid --since value: ${value}`);
  return Number.parseInt(match[1], 10) * UNIT_MS[match[2] ?? 'ms'];
}

runTool({
  name: 'ledger-detect-duplicates',
  description: 'Report side-effect keys applied twice and label writes with no ledger row.',
  options: {
    'repo-dir': { type: 'string', description: 'Milled repository directory' },
    since: { type: 'string', description: 'Scan window, e.g. 30m, 2h (default 30m)' },
    json: { type: 'boolean', description: 'Print JSON summary' },
    strict: { type: 'boolean', description: 'Fail with non-zero exit on error' },
  },
  examples: [
    'npx tsx tools/ledger-detect-duplicates.ts --repo-dir . --since 30m',
  ],
  run({ args }) {
    const repoDir = args['repo-dir'] || process.env.WAVEMILL_MILLED_REPO_DIR || process.cwd();
    const sinceMs = parseWindow(args.since);
    const runImpl = () => {
      const ledger = Ledger.open({ repoDir });
      try {
        const result = detectDuplicates(ledger, { sinceMs, repoDir });
        appendDuplicateLog(repoDir, result);
        return result;
      } finally {
        ledger.close();
      }
    };
    const result = args.strict === true ? runImpl() : withShadowSuppressing(runImpl);
    if (!result) {
      if (args.json) console.log(JSON.stringify({ shadow: 'suppressed' }));
      return;
    }
    for (const finding of result.findings) console.warn(formatFinding(finding));
    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`[side-effect-duplicate] scan duplicates=${result.duplicates} missingRows=${result.missingRows} allTime=${result.duplicateKeysAllTime} (${result.tookMs}ms)`);
    }
  },
});
