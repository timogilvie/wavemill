/**
 * observer-findings — single writer for `.wavemill/observer-findings.jsonl`.
 *
 * HOK-3102 (D7): every TS producer that appends to `observer-findings.jsonl`
 * routes through this module, and the module is gated on
 * `resolveSessionCapabilities(repoDir).observer` so nothing writes when no
 * observer will ever read. With the observer off, the file is never touched;
 * the startup runner truncates any legacy backlog once (see
 * `_cleanup_stale_observer_findings` in `wavemill-common.sh`).
 *
 * Best-effort by design: failures are swallowed to avoid perturbing the
 * caller's control flow, mirroring the pre-3102 private appenders.
 *
 * @module observer-findings
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { errorMessage } from './error-utils.ts';
import { resolveSessionCapabilities } from './config.ts';

export interface AppendObserverFindingOptions {
  /**
   * Skip the capabilities check (advanced; only use when the caller has
   * already resolved and is passing the decision through).
   */
  skipCapabilityCheck?: boolean;
}

/**
 * Append a JSONL finding record if the observer is active in this session.
 * Returns true when the write happened, false otherwise (gated off or error).
 */
export function appendObserverFinding(
  repoDir: string,
  finding: unknown,
  opts: AppendObserverFindingOptions = {},
): boolean {
  if (!opts.skipCapabilityCheck) {
    try {
      // readHealth:false — pure config decision; health is advisory only (D2).
      const caps = resolveSessionCapabilities(repoDir, { readHealth: false });
      if (!caps.observer) return false;
    } catch {
      // Fail closed if the resolver itself blows up; matches shell semantics.
      return false;
    }
  }
  try {
    const wavemillDir = join(repoDir, '.wavemill');
    mkdirSync(wavemillDir, { recursive: true });
    appendFileSync(join(wavemillDir, 'observer-findings.jsonl'), `${JSON.stringify(finding)}\n`, 'utf-8');
    return true;
  } catch (error) {
    // Best-effort: never throw. Match the pre-3102 console.error to preserve
    // any operator diagnostics they were used to seeing.
    console.error(`observer-findings: failed to append: ${errorMessage(error)}`);
    return false;
  }
}
