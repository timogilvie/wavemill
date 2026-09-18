#!/usr/bin/env -S npx tsx
import { fileURLToPath } from 'node:url';
import { claimReadyHandoff, publishReadyHandoff, recordReadyChecked } from '../shared/lib/ready-tend-handoff.ts';
import { runTool } from '../shared/lib/tool-runner.ts';

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
const config = {
  name: 'ready-tend-handoff',
  description: 'Publish or claim the head-bound Ready to Tend ownership handoff',
  options: {
    'feature-dir': { type: 'string', description: 'Ready artifact directory' },
    head: { type: 'string', description: 'Authoritative GitHub PR head SHA' },
  },
  positional: { name: 'action pr-number', description: 'publish|claim followed by PR number', required: true },
  async run({ args, positional }: { args: Record<string, string>; positional: string[] }) {
    const [action, rawPr] = positional;
    if (!args['feature-dir'] || !args.head || !rawPr) throw new Error('--feature-dir, --head, and PR number are required');
    const prNumber = Number(rawPr);
    if (!Number.isInteger(prNumber)) throw new Error('PR number must be an integer');
    const result = action === 'checked'
      ? { outcome: 'checked', record: await recordReadyChecked(args['feature-dir'], prNumber, args.head) }
      : action === 'publish'
      ? await publishReadyHandoff(args['feature-dir'], prNumber, args.head)
      : action === 'claim'
        ? await claimReadyHandoff(args['feature-dir'], prNumber, args.head)
        : (() => { throw new Error('action must be checked, publish, or claim'); })();
    console.log(JSON.stringify(result));
  },
} as const;
if (isMainModule) runTool(config);
