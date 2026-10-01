/**
 * Tool-decision capture adapter (HOK-2076).
 *
 * Reads a canonical session-event JSONL, projects it into decision rows,
 * and appends them to the corpus. Non-fatal by design: launch/loop sites
 * call it after a session ends and never propagate its errors.
 *
 * Invariant (HOK-3121): scripted rows — where `model` starts with
 * `scripted:` or `provider === 'scripted'` — are only appended when the
 * caller supplies an explicit {@link CaptureOptions.corpusDir}. Without
 * one they are recorded in `rejected` with the reason
 * `scripted_model_requires_explicit_corpus_dir`, so tests that forget to
 * point at a temp corpus cannot pollute the real repo corpus.
 */

import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

import { parseSessionEventJsonl, type SessionEvent } from './session-stream.schema.ts';
import { projectSessionEventsToDecisions } from './tool-decision-projector.ts';
import {
  appendToolDecisions,
  isScriptedToolDecisionRow,
  resolveToolDecisionCorpusPath,
  type AppendResult,
} from './tool-decision-corpus.ts';

export interface CaptureOptions {
  /** Path to the canonical session-events JSONL. */
  eventStreamPath: string;
  /** Repo root for resolving the corpus dir. */
  repoDir?: string;
  /**
   * Explicit corpus dir override. REQUIRED for scripted rows
   * (HOK-3121): rows whose `model` starts with `scripted:` or whose
   * `provider === 'scripted'` are rejected when this is unset.
   */
  corpusDir?: string;
  /** Optional file namespace (default "corpus"). */
  corpusNamespace?: string;
  /** Optional provider override forwarded to the projector. */
  provider?: string;
  /** Optional runtime label ("native" by default). */
  runtime?: string;
  /**
   * Backfill-only. When true, rows whose `decisionId` already exists in
   * the corpus overwrite the existing line in place rather than skipping.
   * Live single-session capture must leave this false (the default) so
   * concurrent sessions never clobber each other's rows.
   */
  replace?: boolean;
}

export interface CaptureResult {
  ok: boolean;
  reason?: string;
  corpusPath?: string;
  eventCount?: number;
  appended?: number;
  skippedDuplicates?: number;
  replaced?: number;
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

    // Zero-row warning: if the stream had tool_call events but the projector
    // produced zero rows, that's a regression or schema drift worth flagging.
    const hadToolCalls = events.some((e) => e.type === 'tool_call');
    const projectedZeroRows = projection.rows.length === 0;
    if (hadToolCalls && projectedZeroRows) {
      const streamLabel = path.basename(opts.eventStreamPath);
      const msg = `tool-decision capture: 0 rows projected from stream ${streamLabel} that had tool_call events`;
      console.warn(msg);
      projection.warnings = [...(projection.warnings ?? []), msg];
    }

    const corpusPath = resolveToolDecisionCorpusPath({
      repoDir: opts.repoDir,
      ...(opts.corpusDir ? { explicitDir: opts.corpusDir } : {}),
      ...(opts.corpusNamespace ? { namespace: opts.corpusNamespace } : {}),
    });

    // HOK-3121 guard: scripted rows must never land in the real repo
    // corpus. Without an explicit `corpusDir`, partition them off and
    // report them as rejected so the caller sees the leak was blocked.
    const scriptedRejections: AppendResult['rejected'] = [];
    const allowedRows = opts.corpusDir
      ? projection.rows
      : projection.rows.filter((row) => {
          if (isScriptedToolDecisionRow(row)) {
            scriptedRejections.push({
              decisionId: row.decisionId,
              reason: 'scripted_model_requires_explicit_corpus_dir',
            });
            return false;
          }
          return true;
        });

    const append = appendToolDecisions(allowedRows, corpusPath, {
      ...(opts.replace ? { replace: true } : {}),
    });
    return {
      ok: true,
      corpusPath,
      eventCount: events.length,
      appended: append.appended,
      skippedDuplicates: append.skippedDuplicates,
      replaced: append.replaced,
      warnings: projection.warnings,
      rejected: [...scriptedRejections, ...append.rejected],
    };
  } catch (err) {
    return { ok: false, reason: `error:${(err as Error).message.slice(0, 80)}` };
  }
}
