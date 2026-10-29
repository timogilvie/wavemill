#!/usr/bin/env -S npx tsx
import { runTool } from '../shared/lib/tool-runner.ts';
import {
  providerForModel,
  readPersistedContract,
  serializeContract,
  readValidatedContract,
  type ChallengeSide,
  type StageRole,
} from '../shared/lib/execution-contract.ts';

const STAGES = new Set(['planning', 'coding', 'review']);
const SIDES = new Set(['primary', 'challenger']);

function requireStage(value: string | undefined): StageRole {
  if (!value || !STAGES.has(value)) {
    throw new Error(`--stage must be one of: planning, coding, review`);
  }
  return value as StageRole;
}

function parseSide(value: string | undefined): ChallengeSide | undefined {
  if (!value) return undefined;
  if (!SIDES.has(value)) throw new Error(`--challenge-side must be primary or challenger`);
  return value as ChallengeSide;
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value));
}

await runTool({
  name: 'recovery-contract',
  description: 'Read and validate persisted Wavemill execution contracts',
  positional: {
    name: 'command',
    description: 'read, validate, read-and-validate, serialize, provider',
    required: true,
  },
  options: {
    'feature-dir': { type: 'string', description: 'Feature directory containing .phase-config.json' },
    stage: { type: 'string', description: 'Stage role: planning, coding, or review' },
    'challenge-side': { type: 'string', description: 'Challenge side: primary or challenger' },
    repo: { type: 'string', description: 'Repository directory for provider/cert checks' },
    model: { type: 'string', description: 'Model id for provider lookup' },
    json: { type: 'boolean', description: 'Emit JSON' },
  },
  async run({ args, positional }) {
    const command = positional[0];

    if (command === 'provider') {
      const model = args.model;
      if (!model) throw new Error('--model is required for provider');
      printJson({ ok: true, provider: providerForModel(model) });
      return;
    }

    const featureDir = args['feature-dir'];
    if (!featureDir) throw new Error('--feature-dir is required');
    const stageRole = requireStage(args.stage);
    const challengeSide = parseSide(args['challenge-side']);
    if (command === 'validate' || command === 'read-and-validate') {
      printJson(readValidatedContract({ featureDir, stageRole, challengeSide, repoDir: args.repo }));
      return;
    }
    const read = readPersistedContract({ featureDir, stageRole, challengeSide });

    if (command === 'read') {
      printJson(read);
      return;
    }

    if (command === 'serialize') {
      if (!read.ok) {
        printJson(read);
        return;
      }
      printJson({ ok: true, serialized: serializeContract(read.contract) });
      return;
    }

    throw new Error(`unknown command '${command}'`);
  },
});
