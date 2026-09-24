/**
 * Deterministic replay engine.
 *
 * Loads a checkpoint written by `session-checkpoint.ts`, reconstructs a
 * hermetic view of the observed state, and reports a fidelity score with
 * machine-readable non-fidelity reasons.
 *
 * The engine is intentionally structural: it compares hashes and captured
 * sequences rather than actually re-running the model. That is enough to
 * satisfy the packet's requirement that fidelity be `1.0` on unchanged
 * inputs and `<1.0` with reasons otherwise, and it keeps this module free
 * of any live LLM dependency.
 *
 * @module native-agent/deterministic-replay
 */

import { createHash } from 'node:crypto';
import type { ReplayNonFidelityReason } from '../eval-schema.ts';
import {
  loadCheckpoint,
  readCheckpointToolResult,
  readCheckpointEventStream,
  type CheckpointHandle,
} from './session-checkpoint.ts';

export type FidelityReason = ReplayNonFidelityReason;

export interface FidelityReasonDetail {
  code: FidelityReason;
  path?: string;
  expected?: string;
  observed?: string;
  message: string;
}

export interface ReplayInputs {
  /**
   * Observed working-tree file contents at replay time (rel path → content).
   * A missing file is compared against the checkpoint's recorded contents.
   */
  workingFiles?: Record<string, string>;
  /**
   * Observed tool-result contents by callId. When absent, the checkpoint's
   * recorded content is assumed (perfect fidelity for that call).
   */
  toolResults?: Record<string, string>;
  /**
   * Observed environment variables (name → value). Any drift on the
   * checkpoint's whitelist raises `ENV_MISMATCH`.
   */
  env?: Record<string, string>;
  /**
   * True when the replay attempted any network syscall. Setting this to
   * `true` guarantees a `NETWORK_ATTEMPT` non-fidelity reason.
   */
  networkAttempted?: boolean;
  /**
   * Optional replayed event stream. When present, it is compared
   * length-first, then per-event by `id` and by `kind`.
   */
  events?: Array<{ id: string; kind: string }>;
  /**
   * Observed entropy sources; any drift from the checkpoint's captured
   * seeds/sequences raises `NONDETERMINISTIC_TIME_LEAK`.
   */
  entropy?: {
    mathRandomSeed?: number;
    dateNowSeedMs?: number;
    uuidSequence?: string[];
  };
}

export interface ReplayResult {
  /** Fidelity score in [0, 1]. */
  fidelity: number;
  /** Stable machine-readable reasons for any deviation. */
  reasons: FidelityReason[];
  /** Rich per-reason detail for reporting. */
  reasonDetails: FidelityReasonDetail[];
  /** Handle to the checkpoint that was replayed. */
  checkpoint: CheckpointHandle;
}

/**
 * Per-reason fidelity penalties. Additive: unknown reason codes contribute
 * `1.0` (i.e. clamp to zero fidelity conservatively).
 */
export const FIDELITY_WEIGHTS: Record<FidelityReason, number> = {
  WORKING_TREE_MISMATCH: 0.25,
  EVENT_STREAM_DIVERGENCE: 0.4,
  TOOL_RESULT_HASH_MISMATCH: 0.25,
  NONDETERMINISTIC_TIME_LEAK: 0.15,
  ENV_MISMATCH: 0.1,
  NETWORK_ATTEMPT: 1.0,
  HERMETICITY_VIOLATION: 1.0,
  CHECKPOINT_CORRUPT: 1.0,
};

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Compute a fidelity score in [0, 1] from a set of non-fidelity reasons.
 *
 * A single unknown reason drops fidelity to zero; that matches the packet's
 * conservative posture ("do not use counterfactual results for routing unless
 * replay-fidelity and analysis thresholds are met").
 */
export function calculateFidelity(reasons: FidelityReason[]): number {
  if (reasons.length === 0) return 1;
  let penalty = 0;
  for (const reason of reasons) {
    const weight = FIDELITY_WEIGHTS[reason];
    penalty += typeof weight === 'number' ? weight : 1;
  }
  return Math.max(0, 1 - Math.min(1, penalty));
}

/**
 * Replay a checkpoint against observed inputs and report fidelity.
 *
 * This function does no I/O beyond reading the checkpoint. It never opens a
 * network socket; if the caller reports `networkAttempted: true` the replay
 * fails closed with a `NETWORK_ATTEMPT` reason.
 */
export function replayFromCheckpoint(
  checkpointRoot: string,
  inputs: ReplayInputs = {},
): ReplayResult {
  let handle: CheckpointHandle;
  try {
    handle = loadCheckpoint(checkpointRoot);
  } catch (err) {
    return {
      fidelity: 0,
      reasons: ['CHECKPOINT_CORRUPT'],
      reasonDetails: [
        {
          code: 'CHECKPOINT_CORRUPT',
          message: (err as Error).message,
        },
      ],
      checkpoint: { root: checkpointRoot, manifest: {} as CheckpointHandle['manifest'] },
    };
  }
  const manifest = handle.manifest;
  const details: FidelityReasonDetail[] = [];

  if (inputs.networkAttempted) {
    details.push({
      code: 'NETWORK_ATTEMPT',
      message: 'Replay reported an outbound network attempt',
    });
  }

  const observedFiles = inputs.workingFiles ?? {};
  for (const [relPath, expectedHash] of Object.entries(manifest.workingFileHashes)) {
    if (!(relPath in observedFiles)) continue;
    const observedHash = sha256Hex(observedFiles[relPath]);
    if (observedHash !== expectedHash) {
      details.push({
        code: 'WORKING_TREE_MISMATCH',
        path: relPath,
        expected: expectedHash,
        observed: observedHash,
        message: `Working-tree file ${relPath} diverges from checkpoint`,
      });
    }
  }

  const observedToolResults = inputs.toolResults ?? {};
  for (const [callId, expectedHash] of Object.entries(manifest.toolResultHashes)) {
    if (!(callId in observedToolResults)) continue;
    const observedHash = sha256Hex(observedToolResults[callId]);
    if (observedHash !== expectedHash) {
      details.push({
        code: 'TOOL_RESULT_HASH_MISMATCH',
        path: callId,
        expected: expectedHash,
        observed: observedHash,
        message: `Tool result for call ${callId} diverges from checkpoint`,
      });
    }
  }

  if (inputs.env) {
    for (const [name, expected] of Object.entries(manifest.runtimeEnv.whitelistEnv)) {
      if (!(name in inputs.env)) continue;
      if (inputs.env[name] !== expected) {
        details.push({
          code: 'ENV_MISMATCH',
          path: name,
          expected,
          observed: inputs.env[name],
          message: `Environment variable ${name} diverges from checkpoint`,
        });
      }
    }
  }

  if (inputs.entropy) {
    if (
      typeof inputs.entropy.mathRandomSeed === 'number'
      && inputs.entropy.mathRandomSeed !== manifest.entropy.mathRandomSeed
    ) {
      details.push({
        code: 'NONDETERMINISTIC_TIME_LEAK',
        path: 'mathRandomSeed',
        expected: String(manifest.entropy.mathRandomSeed),
        observed: String(inputs.entropy.mathRandomSeed),
        message: 'Math.random seed diverges from checkpoint',
      });
    }
    if (
      typeof inputs.entropy.dateNowSeedMs === 'number'
      && inputs.entropy.dateNowSeedMs !== manifest.entropy.dateNowSeedMs
    ) {
      details.push({
        code: 'NONDETERMINISTIC_TIME_LEAK',
        path: 'dateNowSeedMs',
        expected: String(manifest.entropy.dateNowSeedMs),
        observed: String(inputs.entropy.dateNowSeedMs),
        message: 'Date.now seed diverges from checkpoint',
      });
    }
    if (Array.isArray(inputs.entropy.uuidSequence)) {
      const expected = manifest.entropy.uuidSequence ?? [];
      const observed = inputs.entropy.uuidSequence;
      const diverges =
        expected.length !== observed.length
        || expected.some((value, idx) => value !== observed[idx]);
      if (diverges) {
        details.push({
          code: 'NONDETERMINISTIC_TIME_LEAK',
          path: 'uuidSequence',
          message: 'UUID sequence diverges from checkpoint',
        });
      }
    }
  }

  if (inputs.events) {
    const originalStream = readCheckpointEventStream(checkpointRoot).map((event) => ({
      id: typeof event.id === 'string' ? event.id : '',
      kind: typeof event.kind === 'string' ? event.kind : '',
    }));
    const observedStream = inputs.events;
    if (originalStream.length !== observedStream.length) {
      details.push({
        code: 'EVENT_STREAM_DIVERGENCE',
        path: 'length',
        expected: String(originalStream.length),
        observed: String(observedStream.length),
        message: 'Replayed event stream length diverges',
      });
    } else {
      for (let i = 0; i < originalStream.length; i++) {
        if (
          originalStream[i].id !== observedStream[i].id
          || originalStream[i].kind !== observedStream[i].kind
        ) {
          details.push({
            code: 'EVENT_STREAM_DIVERGENCE',
            path: String(i),
            expected: `${originalStream[i].id}:${originalStream[i].kind}`,
            observed: `${observedStream[i].id}:${observedStream[i].kind}`,
            message: `Replayed event at index ${i} diverges`,
          });
          break;
        }
      }
    }
  }

  const reasons = details.map((detail) => detail.code);
  const fidelity = calculateFidelity(reasons);
  return { fidelity, reasons, reasonDetails: details, checkpoint: handle };
}

/**
 * Convenience wrapper that treats the checkpoint's own recorded content as
 * the observed inputs. Always returns fidelity 1.0 on a well-formed
 * checkpoint; used by the baseline replay row in `counterfactual-runner.ts`
 * and by callers that want a self-integrity assertion.
 */
export function replayCheckpointAgainstItself(checkpointRoot: string): ReplayResult {
  const handle = loadCheckpoint(checkpointRoot);
  const toolResults: Record<string, string> = {};
  for (const callId of Object.keys(handle.manifest.toolResultHashes)) {
    const envelope = readCheckpointToolResult(checkpointRoot, callId);
    if (envelope) toolResults[callId] = envelope.content;
  }
  return replayFromCheckpoint(checkpointRoot, { toolResults });
}
