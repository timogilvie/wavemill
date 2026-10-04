#!/usr/bin/env -S npx tsx
/**
 * HOK-3101 — CLI wrapper over `shared/lib/task-progress.ts` for shell
 * consumers (dashboard, monitor stall check, terminal reconciler, etc.).
 *
 * Contract:
 *   - `--issue <ID>` is required.
 *   - Missing inputs are absent, never fatal; a well-formed empty result is
 *     still emitted so callers get `{}` on parse failure.
 *   - Exits 0 on any input mode.
 *   - `--write-cache` writes an atomic tmp+rename to
 *     `/tmp/wavemill-${session}-${issue}.progress.json`.
 *   - `--max-age <s>` short-circuits the compute if the cache is fresh; the
 *     cache is printed instead. This is how the monitor stall check keeps
 *     under ~1 compute per running coding task per 60s.
 *
 * Fail-safe direction: any thrown error prints `{}` and exits 0 so shell
 * `jq` consumers never explode on stderr output.
 */

import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { runTool } from '../shared/lib/tool-runner.ts';
import {
  getTaskProgress,
  progressCacheIsFresh,
  type TaskProgress,
} from '../shared/lib/task-progress.ts';

interface TaskLookup {
  updated?: string;
  branch?: string;
  slug?: string;
  worktree?: string;
  status?: string;
  phase?: string;
  lifecycle?: unknown;
}

function loadTaskFromState(stateFile: string | undefined, issue: string): TaskLookup | undefined {
  if (!stateFile || !existsSync(stateFile)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(stateFile, 'utf-8')) as { tasks?: Record<string, unknown> };
    const task = parsed?.tasks?.[issue];
    if (task && typeof task === 'object') {
      return task as TaskLookup;
    }
  } catch {
    // ignore
  }
  return undefined;
}

function capturePaneText(target: string): string | undefined {
  try {
    const stdout = execFileSync('tmux', ['capture-pane', '-p', '-t', target, '-S', '-200'], {
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return stdout;
  } catch {
    return undefined;
  }
}

/** HOK-3137: resolve a tmux pane target to its pid for the background-work probe. */
function resolvePanePid(target: string): number | undefined {
  try {
    const stdout = execFileSync('tmux', ['list-panes', '-t', target, '-F', '#{pane_pid}'], {
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const pid = Number.parseInt(stdout.trim().split('\n')[0] ?? '', 10);
    return Number.isFinite(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function atomicWrite(destPath: string, contents: string): boolean {
  try {
    const tmp = `${destPath}.tmp.${process.pid}`;
    writeFileSync(tmp, contents, 'utf-8');
    renameSync(tmp, destPath);
    return true;
  } catch {
    return false;
  }
}

function tryPrintCache(cachePath: string, maxAgeSeconds: number): TaskProgress | null {
  if (!existsSync(cachePath)) return null;
  try {
    const raw = readFileSync(cachePath, 'utf-8');
    const parsed = JSON.parse(raw) as TaskProgress;
    if (progressCacheIsFresh(parsed, maxAgeSeconds)) {
      return parsed;
    }
  } catch {
    // stale/malformed; recompute
  }
  return null;
}

runTool({
  name: 'task-progress',
  description:
    'HOK-3101 — one progress/liveness primitive shared across observer, monitor, ready-watchdog, reconciler and dashboard.',
  options: {
    issue: { type: 'string', description: 'Task issue ID (required)' },
    session: { type: 'string', description: 'Wavemill session (default $WAVEMILL_SESSION or wavemill)' },
    'state-file': { type: 'string', description: 'workflow-state.json path' },
    worktree: { type: 'string', description: 'Worktree directory (defaults from state file)' },
    'feature-dir': { type: 'string', description: 'features/<slug> directory' },
    phase: { type: 'string', description: 'Active phase (planning|coding|review|ready) for launch anchoring' },
    'pane-target': { type: 'string', description: 'tmux pane target for the blocking-prompt matcher' },
    'pane-pid': { type: 'string', description: 'Pane shell pid for the HOK-3137 background-work probe; resolved from --pane-target when absent' },
    'stall-minutes': { type: 'string', description: 'Stall threshold in minutes (default 30)' },
    'write-cache': { type: 'boolean', description: 'Atomically write /tmp/wavemill-<session>-<issue>.progress.json' },
    'max-age': { type: 'string', description: 'When set, return the cache if it is younger than this (seconds)' },
    'agent-process-live': {
      type: 'string',
      description: 'Optional pane/process liveness fact: "true"|"false"|"unknown"',
    },
  },
  async run({ args }) {
    const issue = args.issue?.trim();
    if (!issue) {
      // Fail-safe: shell consumers expect {}
      console.log('{}');
      return;
    }
    const session = args.session?.trim() || process.env.WAVEMILL_SESSION || 'wavemill';
    const cachePath = `/tmp/wavemill-${session}-${issue}.progress.json`;

    // Short-circuit on a fresh cache.
    if (args['max-age']) {
      const seconds = Number.parseInt(args['max-age'], 10);
      if (Number.isFinite(seconds) && seconds > 0) {
        const cached = tryPrintCache(cachePath, seconds);
        if (cached) {
          console.log(JSON.stringify(cached));
          return;
        }
      }
    }

    const stateFile = args['state-file'];
    const task = loadTaskFromState(stateFile, issue);
    const worktree = args.worktree ?? task?.worktree;
    const paneText = args['pane-target'] ? capturePaneText(args['pane-target']) : undefined;

    let panePid: number | undefined;
    if (args['pane-pid']) {
      const parsed = Number.parseInt(args['pane-pid'], 10);
      panePid = Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
    } else if (args['pane-target']) {
      panePid = resolvePanePid(args['pane-target']);
    }

    let agentProcessLive: boolean | null | undefined;
    if (args['agent-process-live']) {
      switch (args['agent-process-live'].toLowerCase()) {
        case 'true': agentProcessLive = true; break;
        case 'false': agentProcessLive = false; break;
        default: agentProcessLive = null;
      }
    }

    const stallMinutesArg = args['stall-minutes'];
    const stallMinutes = stallMinutesArg
      ? (() => {
          const n = Number.parseFloat(stallMinutesArg);
          return Number.isFinite(n) && n > 0 ? n : undefined;
        })()
      : process.env.WAVEMILL_TASK_STALL_MINUTES
        ? (() => {
            const n = Number.parseFloat(process.env.WAVEMILL_TASK_STALL_MINUTES!);
            return Number.isFinite(n) && n > 0 ? n : undefined;
          })()
        : undefined;

    let progress: TaskProgress;
    try {
      progress = getTaskProgress({
        issue,
        session,
        task: task as never,
        worktree,
        featureDir: args['feature-dir'],
        phase: args.phase,
        paneText,
        panePid,
        agentProcessLive,
        stallMinutes,
      });
    } catch {
      console.log('{}');
      return;
    }

    const serialized = JSON.stringify(progress);
    if (args['write-cache']) {
      atomicWrite(cachePath, serialized);
    }
    console.log(serialized);
  },
});
