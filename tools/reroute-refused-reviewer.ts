#!/usr/bin/env -S npx tsx

import { rerouteRefusedReviewer } from '../shared/lib/reviewer-launch-reroute.ts';
import { runTool } from '../shared/lib/tool-runner.ts';

runTool({
  name: 'reroute-refused-reviewer',
  description: 'Replace a reviewer the model refused mid-run with the next launchable reviewer (HOK-3146).',
  options: {
    issue: { type: 'string', description: 'Task issue id.' },
    'feature-dir': { type: 'string', description: 'Task feature directory (holds .phase-config.json).' },
    'repo-dir': { type: 'string', description: 'Repository directory. Defaults to current directory.' },
    model: { type: 'string', description: 'Refused reviewer model (the routed model).' },
    'launch-model': { type: 'string', description: 'Alias-resolved launch model, when it differs from --model.' },
    reason: { type: 'string', description: 'Typed refusal reason, e.g. model_at_capacity.' },
    certification: { type: 'string', description: 'Certification status, e.g. missing_live_canary.' },
    certify: { type: 'string', description: 'Certify command from the refusal diagnostic.' },
    json: { type: 'boolean', description: 'Emit machine-readable JSON (always on; kept for symmetry).' },
  },
  examples: [
    'npx tsx tools/reroute-refused-reviewer.ts --issue HOK-1 --feature-dir features/x --model gpt-6-sol --reason model_at_capacity --json',
  ],
  async run({ args }) {
    const issue = (args.issue as string | undefined)?.trim();
    const featureDir = (args['feature-dir'] as string | undefined)?.trim();
    const model = (args.model as string | undefined)?.trim();
    const reason = (args.reason as string | undefined)?.trim();
    if (!issue || !featureDir || !model || !reason) {
      throw new Error('--issue, --feature-dir, --model, and --reason are required');
    }
    const launchModel = (args['launch-model'] as string | undefined)?.trim();
    const certification = (args.certification as string | undefined)?.trim();
    const certifyCommand = (args.certify as string | undefined)?.trim();

    const result = await rerouteRefusedReviewer({
      repoDir: (args['repo-dir'] as string | undefined) || process.cwd(),
      featureDir,
      issue,
      refusedModels: launchModel ? [model, launchModel] : [model],
      refusal: {
        reason,
        ...(certification ? { certification } : {}),
        ...(certifyCommand ? { certifyCommand } : {}),
      },
    });
    console.log(JSON.stringify(result));
  },
});
