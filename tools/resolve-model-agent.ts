#!/usr/bin/env -S npx tsx

import { getEffectiveRegistry } from '../shared/lib/model-registry.ts';
import { resolveModelAgent, resolveLaunchPreflight, type AgentResolutionPhase } from '../shared/lib/model-agent-resolution.ts';
import { runTool } from '../shared/lib/tool-runner.ts';

type BatchRole = 'planner' | 'coder' | 'reviewer';

const PHASE_BY_ROLE: Record<BatchRole, AgentResolutionPhase> = {
  planner: 'planning',
  coder: 'coding',
  reviewer: 'review',
};

runTool({
  name: 'resolve-model-agent',
  description: 'Resolve the launcher agent for a model and phase.',
  options: {
    model: {
      type: 'string',
      description: 'Model ID to resolve.',
    },
    phase: {
      type: 'string',
      description: 'Execution phase: planning, coding, or review.',
    },
    planner: {
      type: 'string',
      description: 'Planner model ID to resolve in batch mode.',
    },
    coder: {
      type: 'string',
      description: 'Coder model ID to resolve in batch mode.',
    },
    reviewer: {
      type: 'string',
      description: 'Reviewer model ID to resolve in batch mode.',
    },
    repo: {
      type: 'string',
      description: 'Repository directory. Defaults to current directory.',
    },
    preflight: {
      type: 'boolean',
      description: 'Use launch preflight (resolves successors, handles retirement).',
    },
    json: {
      type: 'boolean',
      description: 'Emit machine-readable JSON.',
    },
  },
  examples: [
    'npx tsx tools/resolve-model-agent.ts --model claude-sonnet-5 --phase coding',
    'npx tsx tools/resolve-model-agent.ts --model mistral-large-2 --phase planning',
    'npx tsx tools/resolve-model-agent.ts --planner claude-sonnet-5 --coder gpt-5.6-terra --reviewer mistral-large-2',
  ],
  async run({ args }) {
    const model = (args.model as string | undefined)?.trim();
    const rawPhase = (args.phase as string | undefined)?.trim();
    const planner = (args.planner as string | undefined)?.trim();
    const coder = (args.coder as string | undefined)?.trim();
    const reviewer = (args.reviewer as string | undefined)?.trim();
    const repoDir = (args.repo as string | undefined) || process.cwd();
    const usePreflight = args.preflight === true;
    const registry = getEffectiveRegistry(repoDir);

    const requestedRoles = ([
      ['planner', planner],
      ['coder', coder],
      ['reviewer', reviewer],
    ] as const).filter(([, value]) => Boolean(value)) as Array<[BatchRole, string]>;

    if ((model || rawPhase) && requestedRoles.length > 0) {
      throw new Error('Use either --model/--phase or batch role flags, not both');
    }

    if (requestedRoles.length > 0) {
      const results: Partial<Record<BatchRole, ReturnType<typeof resolveModelAgent> | ReturnType<typeof resolveLaunchPreflight>>> = {};
      const diagnostics: string[] = [];

      for (const [role, requestedModel] of requestedRoles) {
        const result = usePreflight
          ? resolveLaunchPreflight({
            requestedModel,
            phase: PHASE_BY_ROLE[role],
            repoDir,
            registry,
          })
          : resolveModelAgent({
            model: requestedModel,
            phase: PHASE_BY_ROLE[role],
            repoDir,
            registry,
          });
        results[role] = result;
        if (!result.ok) {
          diagnostics.push(result.diagnostic);
        }
      }

      console.log(JSON.stringify({ ok: diagnostics.length === 0, results }));
      if (diagnostics.length > 0) {
        console.error(diagnostics.join('\n'));
        process.exit(1);
      }
      return;
    }

    if (!model) {
      throw new Error('--model is required');
    }
    if (!rawPhase) {
      throw new Error('--phase is required');
    }
    if (rawPhase !== 'planning' && rawPhase !== 'coding' && rawPhase !== 'review') {
      throw new Error(`invalid --phase "${rawPhase}". Must be one of: planning, coding, review`);
    }

    const result = usePreflight
      ? resolveLaunchPreflight({
        requestedModel: model,
        phase: rawPhase as AgentResolutionPhase,
        repoDir,
        registry,
      })
      : resolveModelAgent({
        model,
        phase: rawPhase as AgentResolutionPhase,
        repoDir,
        registry,
      });

    console.log(JSON.stringify(result));
    if (!result.ok) {
      console.error(result.diagnostic);
      process.exit(1);
    }
  },
});
