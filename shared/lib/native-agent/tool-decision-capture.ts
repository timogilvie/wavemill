/**
 * Tool-decision capture adapter (HOK-2076).
 *
 * Reads a canonical session-event JSONL, projects it into decision rows,
 * and appends them to the corpus. Non-fatal by design: launch/loop sites
 * call it after a session ends and never propagate its errors.
 */

import { existsSync, readFileSync } from 'node:fs';

import { parseSessionEventJsonl, type SessionEvent } from './session-stream.schema.ts';
import { projectSessionEventsToDecisions } from './tool-decision-projector.ts';
import {
  appendToolDecisions,
  resolveToolDecisionCorpusPath,
  type AppendResult,
} from './tool-decision-corpus.ts';

export interface CaptureOptions {
  /** Path to the canonical session-events JSONL. */
  eventStreamPath: string;
  /** Repo root for resolving the corpus dir. */
  repoDir?: string;
  /** Optional explicit corpus dir override. */
  corpusDir?: string;
  /** Optional file namespace (default "corpus"). */
  corpusNamespace?: string;
  /** Optional provider override forwarded to the projector. */
  provider?: string;
  /** Optional runtime label ("native" by default). */
  runtime?: string;
}

export interface CaptureResult {
  ok: boolean;
  reason?: string;
  corpusPath?: string;
  eventCount?: number;
  appended?: number;
  skippedDuplicates?: number;
  warnings?: string[];
  rejected?: AppendResult['rejected'];
}

/**
 * Read → project → append. Never throws.
 * Meant to be called from launch-planning / launch-coding / review right
 * after the session ended.
 */
export function captureToolDecisionsFromStream(opts: CaptureOptions): CaptureResult {
  try {
    if (!existsSync(opts.eventStreamPath)) {
      return { ok: false, reason: 'stream_missing' };
    }
    const raw = readFileSync(opts.eventStreamPath, 'utf-8');
    if (raw.trim() === '') {
      return { ok: false, reason: 'stream_empty' };
    }
    let events: SessionEvent[];
    try {
      events = parseSessionEventJsonl(raw);
    } catch (err) {
      return { ok: false, reason: `parse_error:${(err as Error).message.slice(0, 80)}` };
    }
    const projection = projectSessionEventsToDecisions({
      events,
      ...(opts.provider ? { provider: opts.provider } : {}),
      ...(opts.runtime ? { runtime: opts.runtime } : {}),
    });
    const corpusPath = resolveToolDecisionCorpusPath({
      repoDir: opts.repoDir,
      ...(opts.corpusDir ? { explicitDir: opts.corpusDir } : {}),
      ...(opts.corpusNamespace ? { namespace: opts.corpusNamespace } : {}),
    });
    const append = appendToolDecisions(projection.rows, corpusPath);
    return {
      ok: true,
      corpusPath,
      eventCount: events.length,
      appended: append.appended,
      skippedDuplicates: append.skippedDuplicates,
      warnings: projection.warnings,
      rejected: append.rejected,
    };
  } catch (err) {
    return { ok: false, reason: `error:${(err as Error).message.slice(0, 80)}` };
  }
}
