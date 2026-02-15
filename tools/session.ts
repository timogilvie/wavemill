#!/usr/bin/env -S npx tsx
// @ts-nocheck

/**
 * Session Management CLI Tool
 *
 * Manages workflow session metadata from within Claude/Codex commands.
 * All operations are non-intrusive — failures print warnings but exit 0.
 *
 * Usage:
 *   npx tsx tools/session.ts start --workflow feature --prompt "..." --model "claude-opus-4-6"
 *   npx tsx tools/session.ts update <sessionId> --pr "https://github.com/..."
 *   npx tsx tools/session.ts complete <sessionId> --status completed --execution-time 12345
 *   npx tsx tools/session.ts get [sessionId]
 */

import {
  createSession,
  updateSession,
  completeSession,
  getLatestSession,
  getSession,
} from '../shared/lib/session.js';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--') && argv[i + 1] && !argv[i + 1].startsWith('--')) {
      const key = argv[i].slice(2);
      args[key] = argv[++i];
    } else if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      args[key] = true;
    } else {
      args._.push(argv[i]);
    }
  }
  return args;
}

function showHelp() {
  console.log(`
Session Management Tool — Track workflow execution metadata

Subcommands:
  start      Create a new session (prints sessionId to stdout)
  update     Update an existing session
  complete   Finalize a session
  get        Read a session (latest or by ID)

Start options:
  --workflow TYPE     Workflow type: feature, bugfix, plan, validate-plan, implement-plan
  --prompt TEXT       Task description or prompt
  --model ID         Model identifier (e.g., claude-opus-4-6)
  --model-version V  Specific model version
  --issue ID         Linear issue ID (e.g., HOK-701)
  --repo-dir DIR     Repository directory (default: cwd)

Update options:
  npx tsx tools/session.ts update <sessionId> [--pr URL] [--issue ID]

Complete options:
  npx tsx tools/session.ts complete <sessionId> --status STATUS [--execution-time MS] [--user-wait-time MS] [--pr URL] [--error MSG]

Get options:
  npx tsx tools/session.ts get              Read latest session
  npx tsx tools/session.ts get <sessionId>  Read specific session

Examples:
  # Start a feature workflow session
  npx tsx tools/session.ts start --workflow feature --prompt "Add auth" --model claude-opus-4-6 --issue HOK-701

  # Update with PR
  npx tsx tools/session.ts update abc-123 --pr "https://github.com/org/repo/pull/42"

  # Complete session
  npx tsx tools/session.ts complete abc-123 --status completed --execution-time 30000

  # Get latest session
  npx tsx tools/session.ts get
`);
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const subcommand = rawArgs[0];
  const args = parseArgs(rawArgs.slice(1));

  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    showHelp();
    return;
  }

  try {
    switch (subcommand) {
      case 'start': {
        const sessionId = await createSession({
          workflowType: args.workflow || 'feature',
          prompt: args.prompt || '',
          model: args.model || process.env.CLAUDE_MODEL || 'unknown',
          modelVersion: args['model-version'] || undefined,
          issueId: args.issue || undefined,
          repoDir: args['repo-dir'] || undefined,
        });
        if (sessionId) {
          // Print only the sessionId to stdout for capture by workflows
          console.log(sessionId);
        } else {
          console.warn('[session] Failed to create session');
        }
        break;
      }

      case 'update': {
        const sessionId = args._[0];
        if (!sessionId) {
          console.warn('[session] Usage: session.ts update <sessionId> [--pr URL] [--issue ID]');
          return;
        }
        const updates = {};
        if (args.pr) updates.prIdentifier = args.pr;
        if (args.issue) updates.issueId = args.issue;
        await updateSession(sessionId, updates, args['repo-dir']);
        break;
      }

      case 'complete': {
        const sessionId = args._[0];
        if (!sessionId) {
          console.warn('[session] Usage: session.ts complete <sessionId> --status STATUS');
          return;
        }
        await completeSession(sessionId, {
          status: args.status || 'completed',
          executionTimeMs: args['execution-time'] ? Number(args['execution-time']) : undefined,
          userWaitTimeMs: args['user-wait-time'] ? Number(args['user-wait-time']) : undefined,
          prIdentifier: args.pr || undefined,
          error: args.error || undefined,
          repoDir: args['repo-dir'] || undefined,
        });
        break;
      }

      case 'get': {
        const sessionId = args._[0];
        const session = sessionId
          ? await getSession(sessionId, args['repo-dir'])
          : await getLatestSession(args['repo-dir']);
        if (session) {
          console.log(JSON.stringify(session, null, 2));
        } else {
          console.warn('[session] No session found');
        }
        break;
      }

      default:
        console.warn(`[session] Unknown subcommand: ${subcommand}`);
        showHelp();
    }
  } catch (err) {
    // Non-intrusive: warn but don't fail
    console.warn(`[session] Error: ${err.message}`);
  }
}

main();
