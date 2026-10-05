#!/usr/bin/env -S npx tsx

import { rerouteRefusedCoder } from '../shared/lib/coder-launch-reroute.ts';
import { runTool } from '../shared/lib/tool-runner.ts';

runTool({
  name: 'reroute-refused-coder',
  description: 'Replace a coder the launch gate refused with the next launchable coder (HOK-3142).',
  options: {
    issue: { type: 'string', description: 'Task issue id.' },
    'feature-dir': { type: 'string', description: 'Task feature directory (holds .phase-config.json).' },
    'repo-dir': { type: 'string', description: 'Repository directory. Defaults to current directory.' },
    model: { type: 'string', description: 'Refused coder model (the routed model).' },
    'launch-model': { type: 'string', description: 'Alias-resolved launch model, when it differs from --model.' },
    reason: { type: 'string', description: 'Typed refusal reason, e.g. uncertified.' },
    certification: { type: 'string', description: 'Certification status, e.g. missing_live_canary.' },
    certify: { type: 'string', description: 'Certify command from the refusal diagnostic.' },
    json: { type: 'boolean', description: 'Emit machine-readable JSON (always on; kept for symmetry).' },
  },
  examples: [
    'npx tsx tools/reroute-refused-coder.ts --issue HOK-1 --feature-dir features/x --model gemini-2.5-pro --reason uncertified --certification missing_live_canary --json',
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

    const result = await rerouteRefusedCoder({
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
