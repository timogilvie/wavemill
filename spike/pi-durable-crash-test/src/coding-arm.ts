// HOK-3150 §2.3: a minimal coding arm on pi-durable. Uses the spike's own
// small tools (not the production coding-tools factories, which are deeply
// coupled to the production registry — importing them unmodified would make
// this spike run production code paths and spend tokens).
//
// Tool surface in the spike:
//   read_file   (safe)   — read a file inside the worktree
//   list_files  (safe)   — list a directory
//   search_text (safe)   — grep a directory for a literal substring
//   apply_patch (unsafe) — multi-file write; writes files sequentially so a
//                          kill between two writes is observable (same shape
//                          as production patch-runtime.ts:377-388)
//   write_artifact (unsafe) — write a single file (used for the completion
//                             artifact)
//
// The replay labels match production (see replay-labels.ts).

import { Buffer } from 'node:buffer';
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

import { Type } from '@earendil-works/pi-ai';
import { defineExtension, defineTool, section } from '@earendil-works/pi-durable';

import { fireAndBlock, type CrashPoint } from './crash-points.ts';

export interface CodingArmToolOptions {
  readonly worktree: string;
  readonly featureDir: string;
  readonly crashPoint: CrashPoint;
  readonly readyFile: string;
  readonly executeLogPath: string;
}

/** Count file writes within a single apply_patch call for C2. */
let currentPatchWriteCount = 0;

async function recordExecute(opts: CodingArmToolOptions, name: string, callId: string): Promise<void> {
  const row = { name, callId, pid: process.pid, t: Date.now(), mode: process.env.HOK3150_MODE ?? '?' };
  await writeFile(opts.executeLogPath, JSON.stringify(row) + '\n', { flag: 'a' });
}

export function buildCodingExtension(opts: CodingArmToolOptions) {
  const safePause = async (name: string, callId: string) => {
    if (opts.crashPoint === 'B') {
      await fireAndBlock({ point: 'B', readyFile: opts.readyFile }, `${name}:${callId}`);
    }
  };
  const unsafePauseBefore = async (name: string, callId: string) => {
    if (opts.crashPoint === 'C1' && name === 'apply_patch') {
      await fireAndBlock({ point: 'C1', readyFile: opts.readyFile }, `${name}:${callId}`);
    }
  };
  const unsafePauseAfter = async (name: string, callId: string) => {
    if (opts.crashPoint === 'C3' && name === 'apply_patch') {
      await fireAndBlock({ point: 'C3', readyFile: opts.readyFile }, `${name}:${callId}`);
    }
  };

  const read_file = defineTool({
    name: 'read_file',
    description: 'Read a file within the worktree.',
    parameters: Type.Object({ path: Type.String() }),
    replay: 'safe',
    execute: async (args, api) => {
      await recordExecute(opts, 'read_file', api.callId);
      await safePause('read_file', api.callId);
      const abs = path.resolve(opts.worktree, args.path);
      const text = await readFile(abs, 'utf8');
      return { content: [{ type: 'text', text }] };
    },
  });

  const list_files = defineTool({
    name: 'list_files',
    description: 'List files in a directory within the worktree.',
    parameters: Type.Object({ path: Type.String() }),
    replay: 'safe',
    execute: async (args, api) => {
      await recordExecute(opts, 'list_files', api.callId);
      await safePause('list_files', api.callId);
      const abs = path.resolve(opts.worktree, args.path);
      const entries = await readdir(abs);
      return { content: [{ type: 'text', text: entries.join('\n') }] };
    },
  });

  const search_text = defineTool({
    name: 'search_text',
    description: 'Grep a directory for a literal substring.',
    parameters: Type.Object({ path: Type.String(), needle: Type.String() }),
    replay: 'safe',
    execute: async (args, api) => {
      await recordExecute(opts, 'search_text', api.callId);
      await safePause('search_text', api.callId);
      const abs = path.resolve(opts.worktree, args.path);
      const hits: string[] = [];
      async function walk(p: string): Promise<void> {
        for (const entry of await readdir(p, { withFileTypes: true })) {
          const child = path.join(p, entry.name);
          if (entry.isDirectory()) await walk(child);
          else if (entry.isFile()) {
            const text = await readFile(child, 'utf8');
            if (text.includes(args.needle)) hits.push(path.relative(opts.worktree, child));
          }
        }
      }
      await walk(abs);
      return { content: [{ type: 'text', text: hits.join('\n') || '(no hits)' }] };
    },
  });

  const apply_patch = defineTool({
    name: 'apply_patch',
    description:
      'Apply a multi-file patch. Each file is written sequentially; a crash between writes may leave the worktree partially patched.',
    parameters: Type.Object({
      files: Type.Array(
        Type.Object({ path: Type.String(), text: Type.String(), kind: Type.Optional(Type.String()) }),
      ),
    }),
    replay: 'unsafe',
    execute: async (args, api) => {
      await recordExecute(opts, 'apply_patch', api.callId);
      await unsafePauseBefore('apply_patch', api.callId);

      currentPatchWriteCount = 0;
      for (const file of args.files) {
        currentPatchWriteCount += 1;
        const abs = path.resolve(opts.worktree, file.path);
        await mkdir(path.dirname(abs), { recursive: true });
        if (
          opts.crashPoint === 'C2' &&
          args.files.length > 1 &&
          currentPatchWriteCount === 1
        ) {
          // Write the first file, then crash before the second.
          await writeFile(abs, file.text, 'utf8');
          await fireAndBlock(
            { point: 'C2', readyFile: opts.readyFile },
            `apply_patch:${api.callId}:between-writes`,
          );
        } else {
          await writeFile(abs, file.text, 'utf8');
        }
      }

      await unsafePauseAfter('apply_patch', api.callId);
      return {
        content: [
          { type: 'text', text: `applied ${args.files.length} files` },
        ],
      };
    },
  });

  const write_artifact = defineTool({
    name: 'write_artifact',
    description: 'Write a single file (used for the coding completion artifact).',
    parameters: Type.Object({ path: Type.String(), text: Type.String() }),
    replay: 'unsafe',
    execute: async (args, api) => {
      await recordExecute(opts, 'write_artifact', api.callId);
      const abs = path.resolve(opts.worktree, args.path);
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, args.text, 'utf8');
      return {
        content: [{ type: 'text', text: `wrote ${args.path}` }],
        control: { terminate: true as const },
      };
    },
  });

  const packetSection = section('packet', async () => {
    const packetPath = path.join(opts.featureDir, 'task-packet.md');
    try {
      return await readFile(packetPath, 'utf8');
    } catch {
      return undefined;
    }
  });

  const planSection = section('plan', async () => {
    const planPath = path.join(opts.featureDir, 'plan.md');
    try {
      return await readFile(planPath, 'utf8');
    } catch {
      return undefined;
    }
  });

  return defineExtension({
    name: 'spike.coding',
    tools: [read_file, list_files, search_text, apply_patch, write_artifact],
    sections: [
      section('preamble', () => 'You are a coding arm. Use the tools to carry out the plan.', { tag: false }),
      packetSection,
      planSection,
    ],
  });
}

/** Export the registered tool names for the replay-label assertion. */
export const SPIKE_TOOL_NAMES: readonly string[] = [
  'read_file',
  'list_files',
  'search_text',
  'apply_patch',
  'write_artifact',
];
