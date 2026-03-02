#!/usr/bin/env -S npx tsx
import { runTool } from '../shared/lib/tool-runner.ts';
import '../shared/lib/env.js';
import { runEvaluation } from '../shared/lib/eval-orchestrator.ts';
import { formatEvalRecord } from '../shared/lib/eval-formatter.ts';

runTool({
  name: 'eval-workflow',
  description: 'Evaluate LLM performance on a completed workflow',
  options: {
    issue: { type: 'string', description: 'Linear issue ID (e.g., HOK-123)' },
    pr: { type: 'string', description: 'GitHub PR number' },
    model: { type: 'string', description: 'Override eval model' },
    'repo-dir': { type: 'string', description: 'Repository directory' },
    agent: { type: 'string', description: 'Agent type (claude or codex)' },
    'solution-model': { type: 'string', description: 'Model used for solution' },
    'routing-decision': { type: 'string', description: 'Routing decision metadata (JSON)' },
    help: { type: 'boolean', short: 'h', description: 'Show help' },
  },
  examples: [
    'npx tsx tools/eval-workflow.ts',
    'npx tsx tools/eval-workflow.ts --issue HOK-123 --pr 456',
    'npx tsx tools/eval-workflow.ts --model claude-sonnet-4-5-20250929',
  ],
  additionalHelp: `Context Resolution:
  1. Explicit arguments (--issue, --pr) take priority
  2. Falls back to .wavemill/workflow-state.json (most recent task with PR)
  3. Falls back to current branch's open PR

Environment Variables:
  EVAL_MODEL         Override judge model (default: claude-sonnet-4-5-20250929)
  LINEAR_API_KEY     Required for fetching issue details from Linear

Requires:
  claude CLI installed and authenticated (uses your subscription)`,
  async run({ args }) {
    try {
      // Parse routing decision if provided
      let routingDecision = undefined;
      if (args['routing-decision']) {
        try {
          routingDecision = JSON.parse(args['routing-decision'] as string);
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          console.error(`Warning: failed to parse routing decision JSON: ${errorMsg}`);
        }
      }

      // Run evaluation
      const record = await runEvaluation({
        issueId: args.issue as string | undefined,
        prNumber: args.pr as string | undefined,
        repoDir: (args['repo-dir'] as string) || process.cwd(),
        agentType: (args.agent as string) || 'claude',
        solutionModel: args['solution-model'] as string | undefined,
        routingDecision,
        evalModel: args.model as string | undefined,
      });

      // Format and print
      console.log(formatEvalRecord(record));

      // Print raw JSON for piping
      if (process.stdout.isTTY === false) {
        console.log(JSON.stringify(record, null, 2));
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`Error: ${errorMsg}`);
      process.exit(1);
    }
  },
});
