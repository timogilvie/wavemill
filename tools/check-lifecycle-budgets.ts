#!/usr/bin/env -S npx tsx
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { runTool } from '../shared/lib/tool-runner.ts';
import {
  checkCertificationBudgets,
  formatVerdict,
  loadCertificationReport,
  loadMonitorTiming,
} from '../shared/lib/lifecycle-budgets.ts';

runTool({
  name: 'check-lifecycle-budgets',
  description: 'Validate a lifecycle certification report + monitor timing file against the HOK-2957 budgets.',
  options: {
    report: {
      type: 'string',
      description: 'Path to certification-report.json (required).',
    },
    'monitor-timing': {
      type: 'string',
      description: 'Optional path to STATE_DIR/monitor-timing.json for the p95 idle budget.',
    },
    json: {
      type: 'boolean',
      description: 'Emit JSON verdict instead of the formatted report.',
    },
  },
  examples: [
    'npx tsx tools/check-lifecycle-budgets.ts --report path/to/certification-report.json',
    'npx tsx tools/check-lifecycle-budgets.ts --report r.json --monitor-timing t.json --json',
  ],
  run({ args }) {
    const reportPath = args.report ? resolve(String(args.report)) : '';
    if (!reportPath) {
      console.error('--report is required');
      process.exit(1);
    }
    if (!existsSync(reportPath)) {
      console.error(`certification report not found: ${reportPath}`);
      process.exit(1);
    }
    const report = loadCertificationReport(reportPath);
    const timing = args['monitor-timing'] ? loadMonitorTiming(resolve(String(args['monitor-timing']))) : null;
    const verdict = checkCertificationBudgets(report, timing);
    if (args.json) {
      console.log(JSON.stringify(verdict, null, 2));
    } else {
      console.log(formatVerdict(verdict));
    }
    process.exit(verdict.passed ? 0 : 2);
  },
});
