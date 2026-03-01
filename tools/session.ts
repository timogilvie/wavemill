#!/usr/bin/env -S npx tsx
import { runTool } from '../shared/lib/tool-runner.ts';
import {
  createSession,
  updateSession,
  completeSession,
  getLatestSession,
  getSession,
} from '../shared/lib/session.js';

async function handleStart(args: any): Promise<void> {
  const sessionId = await createSession({
    workflowType: (args.workflow as string) || 'feature',
    prompt: (args.prompt as string) || '',
    model: (args.model as string) || process.env.CLAUDE_MODEL || 'unknown',
    modelVersion: args['model-version'] as string | undefined,
    issueId: args.issue as string | undefined,
    repoDir: args['repo-dir'] as string | undefined,
  });
  if (sessionId) {
    console.log(sessionId);
  } else {
    console.warn('[session] Failed to create session');
  }
}

async function handleUpdate(sessionId: string | undefined, args: any): Promise<void> {
  if (!sessionId) {
    console.warn('[session] Usage: session.ts update <sessionId> [--pr URL] [--issue ID]');
    return;
  }
  const updates: Record<string, string> = {};
  if (args.pr) updates.prIdentifier = args.pr as string;
  if (args.issue) updates.issueId = args.issue as string;
  await updateSession(sessionId, updates, args['repo-dir'] as string | undefined);
}

async function handleComplete(sessionId: string | undefined, args: any): Promise<void> {
  if (!sessionId) {
    console.warn('[session] Usage: session.ts complete <sessionId> --status STATUS');
    return;
  }
  await completeSession(sessionId, {
    status: (args.status as string) || 'completed',
    executionTimeMs: args['execution-time'] ? Number(args['execution-time']) : undefined,
    userWaitTimeMs: args['user-wait-time'] ? Number(args['user-wait-time']) : undefined,
    prIdentifier: args.pr as string | undefined,
    error: args.error as string | undefined,
    repoDir: args['repo-dir'] as string | undefined,
  });
}

async function handleGet(sessionId: string | undefined, args: any): Promise<void> {
  const session = sessionId
    ? await getSession(sessionId, args['repo-dir'] as string | undefined)
    : await getLatestSession(args['repo-dir'] as string | undefined);
  if (session) {
    console.log(JSON.stringify(session, null, 2));
  } else {
    console.warn('[session] No session found');
  }
}

runTool({
  name: 'session',
  description: 'Manage workflow session metadata',
  options: {
    workflow: { type: 'string', description: 'Workflow type (feature, bugfix, plan, etc.)' },
    prompt: { type: 'string', description: 'Task description or prompt' },
    model: { type: 'string', description: 'Model identifier (e.g., claude-opus-4-6)' },
    'model-version': { type: 'string', description: 'Specific model version' },
    issue: { type: 'string', description: 'Linear issue ID (e.g., HOK-701)' },
    'repo-dir': { type: 'string', description: 'Repository directory (default: cwd)' },
    pr: { type: 'string', description: 'PR URL or number' },
    status: { type: 'string', description: 'Session status (completed, failed, etc.)' },
    'execution-time': { type: 'string', description: 'Execution time in milliseconds' },
    'user-wait-time': { type: 'string', description: 'User wait time in milliseconds' },
    error: { type: 'string', description: 'Error message if failed' },
    help: { type: 'boolean', short: 'h', description: 'Show help' },
  },
  positional: {
    name: 'subcommand args',
    description: 'Subcommand (start|update|complete|get) and optional arguments',
    multiple: true,
  },
  examples: [
    'npx tsx tools/session.ts start --workflow feature --prompt "Add auth" --model claude-opus-4-6 --issue HOK-701',
    'npx tsx tools/session.ts update abc-123 --pr "https://github.com/org/repo/pull/42"',
    'npx tsx tools/session.ts complete abc-123 --status completed --execution-time 30000',
    'npx tsx tools/session.ts get',
    'npx tsx tools/session.ts get abc-123',
  ],
  additionalHelp: `Subcommands:
  start      Create a new session (prints sessionId to stdout)
  update     Update an existing session
  complete   Finalize a session
  get        Read a session (latest or by ID)

All operations are non-intrusive — failures print warnings but exit 0.`,
  async run({ args, positional }) {
    const subcommand = positional[0];
    const sessionId = positional[1];

    try {
      switch (subcommand) {
        case 'start':
          await handleStart(args);
          break;
        case 'update':
          await handleUpdate(sessionId, args);
          break;
        case 'complete':
          await handleComplete(sessionId, args);
          break;
        case 'get':
          await handleGet(sessionId, args);
          break;
        default:
          console.warn(`[session] Unknown subcommand: ${subcommand || '(none)'}`);
          process.exit(1);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[session] Error: ${message}`);
    }
  },
});
