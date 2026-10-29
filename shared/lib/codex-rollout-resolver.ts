/**
 * Resolve Codex `pending:<nonce>` ownership rows to exact thread ids
 * (HOK-3328).
 *
 * Codex picks its own thread id, so a shell launch records
 * `pending:<nonce>` and prefixes the prompt with the launch-nonce line
 * (`launchNonceLine`). The rollout Codex writes for that launch carries the
 * nonce in its first user prompt and the thread id in `session_meta.payload.id`
 * — a proof of match, not a timestamp guess: a rollout counts only when it
 * contains the exact nonce (and, when the row recorded one, the same cwd).
 *
 * The resolution is appended to the ownership record once
 * (`appendSessionRefResolution`), so later reads never rescan.
 *
 * @module codex-rollout-resolver
 */

import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pendingNonce, type SessionOwnershipRow } from './session-ownership.ts';

/** Bytes of a rollout's head scanned for `session_meta` and the first prompt. */
const HEAD_BYTES = 256 * 1024;
/** A rollout older than its launch row (minus clock slack) cannot be that launch. */
const MTIME_SLACK_MS = 60_000;
const MAX_DEPTH = 5;

/** `$CODEX_HOME/sessions`, defaulting to `~/.codex/sessions`. */
export function codexSessionsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.CODEX_HOME || join(homedir(), '.codex'), 'sessions');
}

function readHead(file: string): string {
  const fd = openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const bytes = readSync(fd, buffer, 0, HEAD_BYTES, 0);
    return buffer.subarray(0, bytes).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

function listRollouts(dir: string, minMtimeMs: number, depth = 0, out: string[] = []): string[] {
  if (depth > MAX_DEPTH) return out;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      listRollouts(path, minMtimeMs, depth + 1, out);
    } else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
      try {
        if (statSync(path).mtimeMs >= minMtimeMs) out.push(path);
      } catch {
        // Unreadable entry: not a match.
      }
    }
  }
  return out;
}

interface RolloutHead {
  threadId: string | null;
  cwd: string | null;
  text: string;
}

function parseHead(text: string): RolloutHead {
  let threadId: string | null = null;
  let cwd: string | null = null;
  for (const line of text.split('\n')) {
    if (!line.includes('"session_meta"')) continue;
    try {
      const entry = JSON.parse(line);
      if (entry?.type === 'session_meta') {
        threadId = typeof entry.payload?.id === 'string' ? entry.payload.id : null;
        cwd = typeof entry.payload?.cwd === 'string' ? entry.payload.cwd : null;
        break;
      }
    } catch {
      // Truncated or foreign line.
    }
  }
  return { threadId, cwd, text };
}

/**
 * Map each pending Codex row's ref to the thread id of the rollout that
 * carries its launch nonce. Rows with no matching rollout are left out.
 */
export function resolveCodexLaunchNonces(
  rows: readonly SessionOwnershipRow[],
  roots: readonly string[] = [codexSessionsRoot()],
): Map<string, string> {
  const resolved = new Map<string, string>();
  const pending = rows.filter((row) => row.harness === 'codex' && pendingNonce(row.sessionRef));
  if (pending.length === 0) return resolved;

  const minMtime = Math.min(...pending.map((row) => Date.parse(row.launchedAt))) - MTIME_SLACK_MS;
  const heads: RolloutHead[] = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const file of listRollouts(root, minMtime)) {
      try {
        heads.push(parseHead(readHead(file)));
      } catch {
        // Unreadable rollout: not a match.
      }
    }
  }

  for (const row of pending) {
    const nonce = pendingNonce(row.sessionRef)!;
    const match = heads.find((head) => head.threadId
      && head.text.includes(nonce)
      && (!row.cwd || !head.cwd || head.cwd === row.cwd));
    if (match?.threadId) resolved.set(row.sessionRef, match.threadId);
  }
  return resolved;
}
