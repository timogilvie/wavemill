#!/usr/bin/env -S npx tsx
import { readFileSync } from 'node:fs';
import { runTool } from '../shared/lib/tool-runner.ts';
import {
  selectFirstWave,
  selectLaunchSet,
  type InFlightTask,
  type QueuePlan,
  type TaskWithScore,
} from '../shared/lib/plan-queue-utils.ts';

type SelectMode = 'first-wave' | 'launch-set';

type SelectWaveInput = {
  plan: QueuePlan;
  tasks: TaskWithScore[];
  mode: SelectMode;
  // first-wave uses maxParallel; launch-set reads freeSlots (falls back to maxParallel).
  maxParallel?: number;
  freeSlots?: number;
  inFlight?: InFlightTask[];
};

function parseInput(raw: string): SelectWaveInput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Failed to parse select-wave JSON from stdin: ${(error as Error).message}`);
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TypeError('select-wave input must be a JSON object');
  }

  const input = parsed as Partial<SelectWaveInput>;
  if (!Array.isArray(input.tasks)) {
    throw new TypeError('select-wave input must include a tasks array');
  }

  const mode: SelectMode = input.mode === 'launch-set' ? 'launch-set' : 'first-wave';

  if (mode === 'first-wave') {
    if (typeof input.maxParallel !== 'number') {
      throw new TypeError('select-wave input must include numeric maxParallel');
    }
  } else {
    const slotSource = input.freeSlots ?? input.maxParallel;
    if (typeof slotSource !== 'number') {
      throw new TypeError('launch-set mode requires numeric freeSlots or maxParallel');
    }
  }

  if (input.inFlight !== undefined && !Array.isArray(input.inFlight)) {
    throw new TypeError('inFlight must be an array when provided');
  }

  return {
    plan: (input.plan ?? {}) as QueuePlan,
    tasks: input.tasks,
    mode,
    maxParallel: input.maxParallel,
    freeSlots: input.freeSlots,
    inFlight: input.inFlight,
  };
}

runTool({
  name: 'select-wave',
  description: 'Select the first scheduler-derived parallel wave or safe launch set from scored tasks',
  options: {},
  examples: [
    'printf \'{"plan":{"availableNow":["HOK-1"]},"tasks":[{"id":"HOK-1","score":10}],"maxParallel":1}\' | npx tsx tools/select-wave.ts',
    'printf \'{"mode":"launch-set","plan":{"availableNow":["HOK-1"]},"tasks":[{"id":"HOK-1","score":10}],"freeSlots":1}\' | npx tsx tools/select-wave.ts',
  ],
  async run() {
    const input = parseInput(readFileSync(0, 'utf8'));
    if (input.mode === 'launch-set') {
      const freeSlots = input.freeSlots ?? input.maxParallel ?? 0;
      const set = selectLaunchSet(input.plan, input.tasks, {
        freeSlots,
        inFlight: input.inFlight ?? [],
      });
      process.stdout.write(`${JSON.stringify(set, null, 2)}\n`);
      return;
    }
    const selection = selectFirstWave(input.plan, input.tasks, { maxParallel: input.maxParallel ?? 0 });
    process.stdout.write(`${JSON.stringify(selection, null, 2)}\n`);
  },
});
