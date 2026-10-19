#!/usr/bin/env -S npx tsx
/**
 * HOK-3229 — live workflow-state invariant checker.
 *
 * Called once per monitor tick as a tracked async job (HOK-3206 pattern):
 *   npx tsx tools/state-invariants.ts --repo-dir . [--result-path ...]
 *
 * Reads workflow state, PR cache, task-progress snapshots, condition-marker
 * sidecars, and retry sentinels; evaluates every HOK-3229 invariant against
 * them, writes new violations to `.wavemill/invariant-violations.jsonl`, and
 * forwards each urgent finding to the observer-alerts pipeline so first
 * occurrences become OS desktop notifications. Always exits 0; infra errors
 * are logged but never crash the monitor.
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  appendFileSync,
  mkdirSync,
  writeFileSync,
  renameSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { runTool } from '../shared/lib/tool-runner.ts';
import { readWorkflowState, workflowTaskEntries, type WorkflowState } from '../shared/lib/workflow-state.ts';
import { readSessionPrCache, type CachedPullRequest } from '../shared/lib/session-gh-cache.ts';
import {
  findTaskInState,
  buildMergeLabelLiveState,
  type MergeLabelTaskView,
  type MergeLabelLiveState,
} from '../shared/lib/merge-labels.ts';
import {
  evaluateInvariants,
  createEmptyCache,
  parseConditionSidecar,
  type EvaluateInvariantsInputs,
  type ConditionSidecarInfo,
  type RetrySentinelInfo,
  type StateInvariantsCache,
  type WaitingOnEvidence,
  type InvariantViolation,
} from '../shared/lib/state-invariants.ts';
import { appendObserverFinding } from '../shared/lib/observer-findings.ts';
import type { TaskProgress } from '../shared/lib/task-progress.ts';
import { Ledger } from '../shared/lib/ledger.ts';
import { runConsistencyCheck } from '../shared/lib/ledger-consistency.ts';
import { withShadowSuppressing } from '../shared/lib/ledger-shadow.ts';

// ── Local helpers ────────────────────────────────────────────────────────────

function readJson<T = Record<string, unknown>>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function readTaskProgress(repoDir: string, session: string, issue: string): TaskProgress | null {
  // Prefer the on-disk cache (no tsx spawn). Fall back to a bounded one-shot
  // spawn via task-progress.ts so the detector still works on first boot.
  const cachePath = `/tmp/wavemill-${session}-${issue}.progress.json`;
  const cached = readJson<TaskProgress>(cachePath);
  if (cached) return cached;
  try {
    const stdout = execFileSync(
      'npx',
      [
        'tsx',
        join(repoDir, 'tools', 'task-progress.ts'),
        '--issue',
        issue,
        '--session',
        session,
        '--state-file',
        join(repoDir, '.wavemill', 'workflow-state.json'),
      ],
      { encoding: 'utf-8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const parsed = JSON.parse(stdout) as TaskProgress;
    if (parsed && typeof parsed === 'object' && parsed.issue) return parsed;
    return null;
  } catch {
    return null;
  }
}

function readOperatorEventSeq(stateDir: string): number {
  const events = join(stateDir, '.operator-events.jsonl');
  if (!existsSync(events)) return 0;
  try {
    const text = readFileSync(events, 'utf-8');
    return text.split('\n').filter((l) => l.length > 0).length;
  } catch {
    return 0;
  }
}

function readWorktreeHead(worktree: string): string | undefined {
  try {
    const out = execFileSync('git', ['-C', worktree, 'rev-parse', 'HEAD'], {
      encoding: 'utf-8',
      timeout: 3_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim() || undefined;
  } catch {
    return undefined;
  }
}

function enumerateConditionSidecarsForTask(taskId: string, stateDir: string): ConditionSidecarInfo[] {
  if (!existsSync(stateDir)) return [];
  const out: ConditionSidecarInfo[] = [];
  let entries: string[];
  try {
    entries = readdirSync(stateDir);
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (!entry.endsWith('-condition.json') && !entry.endsWith('.condition.json')) continue;
    const path = join(stateDir, entry);
    let raw: string | null = null;
    try {
      raw = readFileSync(path, 'utf-8');
    } catch {
      raw = null;
    }
    out.push(parseConditionSidecar(taskId, path, raw));
  }
  return out;
}

function enumerateRetrySentinelsForTask(taskId: string, stateDir: string): RetrySentinelInfo[] {
  if (!existsSync(stateDir)) return [];
  const buckets = new Map<string, RetrySentinelInfo>();
  const retryRe = /^\.retry-(.+?)-(count|head|exhausted|last-at|exhausted-condition\.json)$/;
  const legacyRe = /^\.failed-ready-recheck-(count|head|exhausted|last-at|exhausted-condition\.json)$/;
  let entries: string[];
  try {
    entries = readdirSync(stateDir);
  } catch {
    return [];
  }
  for (const entry of entries) {
    let bucket: string | undefined;
    const retryMatch = entry.match(retryRe);
    const legacyMatch = entry.match(legacyRe);
    if (retryMatch) bucket = retryMatch[1];
    else if (legacyMatch) bucket = 'failed-ready-recheck';
    if (!bucket) continue;
    if (!buckets.has(bucket)) {
      const base = bucket === 'failed-ready-recheck' ? '.failed-ready-recheck' : `.retry-${bucket}`;
      const exhaustedPath = join(stateDir, `${base}-exhausted`);
      const conditionPath = join(stateDir, `${base}-exhausted-condition.json`);
      buckets.set(bucket, {
        taskId,
        bucket,
        exhaustedPath,
        exhaustedExists: existsSync(exhaustedPath),
        conditionPath,
        conditionExists: existsSync(conditionPath),
      });
    }
  }
  return Array.from(buckets.values());
}

function waitingOnEvidenceForTask(stateDir: string): WaitingOnEvidence {
  if (!existsSync(stateDir)) return { hasWaitingOnMarker: false };
  const needs = join(stateDir, '.needs-attention');
  const needsTransient = join(stateDir, '.needs-attention-transient');
  const readyWait = join(stateDir, '.ready-waiting-on.json');
  const parts: string[] = [];
  if (existsSync(needs)) parts.push('.needs-attention');
  if (existsSync(needsTransient)) parts.push('.needs-attention-transient');
  if (existsSync(readyWait)) parts.push('.ready-waiting-on.json');
  return { hasWaitingOnMarker: parts.length > 0, detail: parts.join(',') || undefined };
}

function stateDirFor(task: { worktree?: string | number; slug?: string }): string | undefined {
  const worktree = typeof task.worktree === 'string' ? task.worktree : undefined;
  const slug = typeof task.slug === 'string' ? task.slug : undefined;
  if (!worktree || !slug) return undefined;
  const feat = join(worktree, 'features', slug);
  if (existsSync(feat)) return feat;
  const bug = join(worktree, 'bugs', slug);
  if (existsSync(bug)) return bug;
  return feat;
}

function readStateInvariantsCache(repoDir: string): StateInvariantsCache {
  const path = join(repoDir, '.wavemill', 'state-invariants-cache.json');
  const raw = readJson<StateInvariantsCache>(path);
  if (!raw || raw.schemaVersion !== 1) return createEmptyCache();
  // Fill in missing shape bits.
  return {
    schemaVersion: 1,
    lastTickAt: raw.lastTickAt,
    pr: raw.pr ?? {},
    marker: raw.marker ?? {},
    signatures: raw.signatures ?? {},
  };
}

function writeStateInvariantsCache(repoDir: string, cache: StateInvariantsCache): void {
  const dir = join(repoDir, '.wavemill');
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // best-effort
  }
  const target = join(dir, 'state-invariants-cache.json');
  const tmp = `${target}.tmp.${process.pid}`;
  try {
    writeFileSync(tmp, `${JSON.stringify(cache)}\n`, 'utf-8');
    renameSync(tmp, target);
  } catch (error) {
    console.error(`[state-invariants] failed to persist cache: ${(error as Error).message}`);
  }
}

function appendViolationsJsonl(repoDir: string, lines: string[]): void {
  if (lines.length === 0) return;
  const dir = join(repoDir, '.wavemill');
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // best-effort
  }
  const target = join(dir, 'invariant-violations.jsonl');
  try {
    appendFileSync(target, `${lines.join('\n')}\n`, { encoding: 'utf-8', flag: 'a' });
  } catch (error) {
    console.error(`[state-invariants] failed to append violations: ${(error as Error).message}`);
  }
}

function envNumber(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// ── Main entry ───────────────────────────────────────────────────────────────

interface ToolArgs {
  'repo-dir'?: string;
  'result-path'?: string;
  json?: boolean;
}

async function runCheck(args: ToolArgs): Promise<void> {
  const repoDir = args['repo-dir'] || process.env.WAVEMILL_MILLED_REPO_DIR || process.cwd();
  const stateFile = join(repoDir, '.wavemill', 'workflow-state.json');
  const state: WorkflowState | null = readWorkflowState(stateFile);
  if (!state) {
    console.error(`[state-invariants] no workflow state at ${stateFile}; skipping`);
    writeResultMarker(args['result-path'], { ok: true, skipped: true });
    return;
  }

  const session = process.env.WAVEMILL_SESSION ?? 'wavemill';
  const nowMs = Date.now();

  // Per-task evidence (progress, state dir contents, worktree head).
  const taskProgress = new Map<string, TaskProgress>();
  const conditionSidecars: ConditionSidecarInfo[] = [];
  const retrySentinels: RetrySentinelInfo[] = [];
  const waitingOnByTaskId = new Map<string, WaitingOnEvidence>();
  const worktreeHeads = new Map<string, string>();
  const operatorSeq = new Map<string, number>();

  for (const [taskId, task] of workflowTaskEntries(state)) {
    const stateDir = stateDirFor(task);
    // Progress is read for ALL known tasks (not just those with a state dir),
    // since the cache lives in /tmp and may still be useful.
    const prog = readTaskProgress(repoDir, session, taskId);
    if (prog) taskProgress.set(taskId, prog);

    if (stateDir) {
      conditionSidecars.push(...enumerateConditionSidecarsForTask(taskId, stateDir));
      retrySentinels.push(...enumerateRetrySentinelsForTask(taskId, stateDir));
      waitingOnByTaskId.set(taskId, waitingOnEvidenceForTask(stateDir));
      operatorSeq.set(taskId, readOperatorEventSeq(stateDir));
    } else {
      waitingOnByTaskId.set(taskId, { hasWaitingOnMarker: false });
    }

    const worktree = typeof task.worktree === 'string' ? task.worktree : undefined;
    if (worktree) {
      const head = readWorktreeHead(worktree);
      if (head) worktreeHeads.set(taskId, head);
    }
  }

  // PR cache + per-PR views and live state.
  const prs: CachedPullRequest[] = readSessionPrCache() ?? [];
  const taskViews = new Map<number, MergeLabelTaskView | null>();
  const liveStates = new Map<number, MergeLabelLiveState | null>();
  const prHeadByNumber = new Map<number, string>();
  for (const pr of prs) {
    if (typeof pr.headRefOid === 'string' && pr.headRefOid) {
      prHeadByNumber.set(pr.number, pr.headRefOid);
    }
    const view = findTaskInState(pr.number, state, repoDir);
    taskViews.set(pr.number, view);
    if (view) {
      try {
        const live = await buildMergeLabelLiveState(pr.number, pr.headRefOid ?? '', view.featureDir, repoDir);
        liveStates.set(pr.number, live);
      } catch {
        liveStates.set(pr.number, null);
      }
    } else {
      liveStates.set(pr.number, null);
    }
  }

  const previousCache = readStateInvariantsCache(repoDir);

  const inputs: EvaluateInvariantsInputs = {
    state,
    taskProgress,
    prs,
    taskViews,
    liveStates,
    conditionSidecars,
    retrySentinels,
    waitingOnByTaskId,
    cache: previousCache,
    stateInspection: {
      worktreeHeadsByTaskId: worktreeHeads,
      operatorEventSeqByTaskId: operatorSeq,
      prHeadByNumber,
      nowMs,
    },
    config: {
      readyStuckMinutes: envNumber('WAVEMILL_STATE_INV_READY_STUCK_MINUTES', 15),
      labelMismatchGraceTicks: envNumber('WAVEMILL_STATE_INV_LABEL_GRACE_TICKS', 2),
      markerGraceTicks: envNumber('WAVEMILL_STATE_INV_MARKER_GRACE_TICKS', 2),
    },
  };

  const { violations: structural, nextCache } = evaluateInvariants(inputs);

  // Ledger-consistency findings: route each disagreement into a violation.
  const ledgerViolations = runLedgerConsistency(repoDir, state, nowMs);

  const allViolations = [...structural, ...ledgerViolations];

  // Append JSONL lines for NEW signatures only (dedup against previous cache).
  const newLines: string[] = [];
  for (const v of allViolations) {
    const isNew = !(v.signature in previousCache.signatures);
    if (isNew) newLines.push(JSON.stringify(v));
    // Log every violation line for log miners.
    console.error(`[urgent] state-invariants ${v.invariantId} ${v.signature}`);
    if (isNew) {
      // Forward to the observer-alerts journal via the shared appender.
      appendObserverFinding(repoDir, {
        subsystem: 'state-invariants',
        title: `invariant ${v.invariantId} violated`,
        body: formatFindingBody(v),
        severity: 'urgent',
        at: v.detectedAt,
        context: {
          signature: v.signature,
          invariantId: v.invariantId,
          taskId: v.taskId,
          prNumber: v.prNumber,
        },
      });
    }
  }
  appendViolationsJsonl(repoDir, newLines);
  writeStateInvariantsCache(repoDir, nextCache);

  const summary = {
    ok: true,
    violationCount: allViolations.length,
    newCount: newLines.length,
    tookMs: Date.now() - nowMs,
  };
  if (args.json) console.log(JSON.stringify(summary));
  writeResultMarker(args['result-path'], summary);
}

function formatFindingBody(v: InvariantViolation): string {
  const lines: string[] = [];
  lines.push(`invariant: ${v.invariantId}`);
  if (v.taskId) lines.push(`task: ${v.taskId}`);
  if (v.prNumber) lines.push(`pr: #${v.prNumber}`);
  for (const [k, val] of Object.entries(v.evidence)) {
    const s = typeof val === 'object' ? JSON.stringify(val) : String(val);
    const truncated = s.length > 200 ? `${s.slice(0, 200)}…` : s;
    lines.push(`${k}: ${truncated}`);
  }
  return lines.join('\n');
}

function runLedgerConsistency(repoDir: string, state: WorkflowState, nowMs: number): InvariantViolation[] {
  const out: InvariantViolation[] = [];
  const nowIso = new Date(nowMs).toISOString();
  const impl = (): InvariantViolation[] => {
    const ledger = Ledger.open({ repoDir });
    try {
      for (const [taskId, task] of workflowTaskEntries(state)) {
        const stateDir = stateDirFor(task);
        if (!stateDir) continue;
        try {
          const result = runConsistencyCheck({
            stateDir,
            issue: taskId,
            ledger,
            nowMs,
          });
          for (const d of result.disagreements) {
            const sig = `ledger-${d.category}:task=${taskId}:${d.stepId ?? d.bucket ?? d.trigger ?? ''}`;
            out.push({
              invariantId: `ledger-${d.category}`,
              taskId,
              severity: 'urgent',
              detectedAt: nowIso,
              evidence: {
                category: d.category,
                severity: d.severity,
                detail: d.detail,
                stepId: d.stepId,
                bucket: d.bucket,
                trigger: d.trigger,
              },
              signature: sig,
            });
          }
        } catch {
          // best-effort per task
        }
      }
      return out;
    } finally {
      try {
        ledger.close();
      } catch {
        // best-effort
      }
    }
  };
  const result = withShadowSuppressing(impl);
  return Array.isArray(result) ? result : out;
}

function writeResultMarker(path: string | undefined, payload: Record<string, unknown>): void {
  if (!path) return;
  try {
    const tmp = `${path}.tmp.${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify({ ...payload, kind: 'state-invariants' })}\n`, 'utf-8');
    renameSync(tmp, path);
  } catch {
    // best-effort
  }
}

runTool({
  name: 'state-invariants',
  description: 'Evaluate HOK-3229 live workflow-state invariants (detection only).',
  options: {
    'repo-dir': { type: 'string', description: 'Milled repository directory (default: cwd)' },
    'result-path': { type: 'string', description: 'Optional path for the tracked-job result marker' },
    json: { type: 'boolean', description: 'Print the JSON summary on stdout' },
  },
  examples: ['npx tsx tools/state-invariants.ts --repo-dir .'],
  async run({ args }) {
    try {
      await runCheck(args as ToolArgs);
    } catch (error) {
      console.error(`[state-invariants] unexpected error: ${(error as Error).message}`);
      writeResultMarker((args as ToolArgs)['result-path'], {
        ok: false,
        error: (error as Error).message,
      });
    }
  },
});
