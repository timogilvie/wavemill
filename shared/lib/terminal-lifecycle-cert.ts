import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

export const TERMINAL_LIFECYCLE_CERT_SCHEMA_VERSION = 1;

export interface CertBudgetResult {
  name: string;
  measured: number;
  limit: number;
  pass: boolean;
}

export interface CertMatrixResult {
  scenario: string;
  mergeMethod?: string;
  passed: boolean;
  iterationMs?: number;
  observerAgreement?: boolean;
  evidencePath?: string;
}

export interface ShadowDecisionAudit {
  path: string;
  branch?: string;
  classification?: string;
  mode?: string;
  wouldDelete: boolean;
  safeToDelete: boolean;
  authorityPresent: boolean;
  finalHeadVerified: boolean;
  observerDisagrees: boolean;
  unsafeReasons: string[];
}

export interface SoakSample {
  cycle: number;
  timestamp: string;
  tmuxPanes: number;
  worktrees: number;
  branches: number;
  tempEntries: number;
  repeatedEpisodesBeforeRetry: number;
}

export interface GateVerdict {
  pass: boolean;
  failures: string[];
}

export interface TerminalLifecycleCertArtifact {
  schemaVersion: number;
  runId: string;
  createdAt: string;
  repoDir: string;
  matrixResults: CertMatrixResult[];
  budgets: CertBudgetResult[];
  shadowDecisions: ShadowDecisionAudit[];
  soakSamples: SoakSample[];
  gates: {
    shadow: GateVerdict;
    soak: GateVerdict;
    budgets: GateVerdict;
  };
}

function readJson(path: string): unknown | null {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as unknown;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function walkJsonFiles(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkJsonFiles(path));
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      out.push(path);
    }
  }
  return out.sort();
}

export function collectShadowDecisionAudit(repoDir: string): ShadowDecisionAudit[] {
  const absRepo = resolve(repoDir);
  const decisionDir = join(absRepo, '.wavemill', 'incidents', 'cleanup-decisions');
  return walkJsonFiles(decisionDir)
    .map((path) => {
      const raw = asRecord(readJson(path));
      const mode = typeof raw.mode === 'string' ? raw.mode : undefined;
      const wouldDelete = raw.wouldDelete === true || mode === 'shadow';
      if (mode !== 'shadow' && !wouldDelete) {
        return null;
      }
      const authorityPresent = typeof raw.authority === 'string' && raw.authority.trim().length > 0;
      const finalHeadVerified = raw.finalCheckPassed === true && typeof raw.finalHeadSha === 'string' && raw.finalHeadSha.length > 0;
      const safeToDelete = raw.safeToDelete === true;
      const observerDisposition = typeof raw.observerDisposition === 'string' ? raw.observerDisposition : '';
      const observerDisagrees = /retain|retained|verification-required|unsafe/i.test(observerDisposition);
      const unsafeReasons: string[] = [];
      if (!safeToDelete) unsafeReasons.push('safeToDelete_not_true');
      if (!authorityPresent) unsafeReasons.push('missing_authority');
      if (!finalHeadVerified) unsafeReasons.push('missing_final_head_verification');
      if (observerDisagrees) unsafeReasons.push('observer_disagreement');
      return {
        path: relative(absRepo, path),
        branch: typeof raw.branch === 'string' ? raw.branch : undefined,
        classification: typeof raw.classification === 'string' ? raw.classification : undefined,
        mode,
        wouldDelete,
        safeToDelete,
        authorityPresent,
        finalHeadVerified,
        observerDisagrees,
        unsafeReasons,
      };
    })
    .filter((entry): entry is ShadowDecisionAudit => entry !== null);
}

export function evaluateShadowGate(decisions: ShadowDecisionAudit[]): GateVerdict {
  const failures = decisions
    .filter((decision) => decision.unsafeReasons.length > 0)
    .map((decision) => `${decision.path}: ${decision.unsafeReasons.join(',')}`);
  return { pass: failures.length === 0, failures };
}

export function evaluateBudgetGate(budgets: CertBudgetResult[]): GateVerdict {
  const failures = budgets
    .filter((budget) => !budget.pass)
    .map((budget) => `${budget.name}: measured ${budget.measured} > limit ${budget.limit}`);
  return { pass: failures.length === 0, failures };
}

export function evaluateSoakGate(samples: SoakSample[]): GateVerdict {
  const failures: string[] = [];
  if (samples.length > 1) {
    const first = samples[0];
    const last = samples[samples.length - 1];
    for (const key of ['tmuxPanes', 'worktrees', 'branches', 'tempEntries'] as const) {
      if (last[key] > first[key]) {
        failures.push(`${key}_grew:${first[key]}->${last[key]}`);
      }
    }
  }
  for (const sample of samples) {
    if (sample.repeatedEpisodesBeforeRetry > 0) {
      failures.push(`cycle ${sample.cycle}: repeated cleanup episodes before nextRetryAt`);
    }
  }
  return { pass: failures.length === 0, failures };
}

export function buildCertificationArtifact(input: {
  repoDir: string;
  runId?: string;
  matrixResults?: CertMatrixResult[];
  budgets?: CertBudgetResult[];
  soakSamples?: SoakSample[];
}): TerminalLifecycleCertArtifact {
  const repoDir = resolve(input.repoDir);
  const budgets = input.budgets ?? [];
  const soakSamples = input.soakSamples ?? [];
  const shadowDecisions = collectShadowDecisionAudit(repoDir);
  return {
    schemaVersion: TERMINAL_LIFECYCLE_CERT_SCHEMA_VERSION,
    runId: input.runId ?? `terminal-lifecycle-cert-${Date.now()}`,
    createdAt: new Date().toISOString(),
    repoDir,
    matrixResults: input.matrixResults ?? [],
    budgets,
    shadowDecisions,
    soakSamples,
    gates: {
      shadow: evaluateShadowGate(shadowDecisions),
      soak: evaluateSoakGate(soakSamples),
      budgets: evaluateBudgetGate(budgets),
    },
  };
}

export function renderCertificationMarkdown(artifact: TerminalLifecycleCertArtifact): string {
  const lines = [
    `# Terminal Lifecycle Certification Report`,
    ``,
    `Run: ${artifact.runId}`,
    `Created: ${artifact.createdAt}`,
    `Repository: ${artifact.repoDir}`,
    ``,
    `## Gates`,
    ``,
    `| Gate | Verdict | Failures |`,
    `| --- | --- | --- |`,
    `| Shadow | ${artifact.gates.shadow.pass ? 'PASS' : 'FAIL'} | ${artifact.gates.shadow.failures.length} |`,
    `| Soak | ${artifact.gates.soak.pass ? 'PASS' : 'FAIL'} | ${artifact.gates.soak.failures.length} |`,
    `| Budgets | ${artifact.gates.budgets.pass ? 'PASS' : 'FAIL'} | ${artifact.gates.budgets.failures.length} |`,
    ``,
    `## Counts`,
    ``,
    `- Matrix results: ${artifact.matrixResults.length}`,
    `- Shadow decisions: ${artifact.shadowDecisions.length}`,
    `- Soak samples: ${artifact.soakSamples.length}`,
    `- Budgets: ${artifact.budgets.length}`,
  ];

  for (const [name, gate] of Object.entries(artifact.gates)) {
    if (!gate.pass) {
      lines.push('', `## ${name} Failures`, '', ...gate.failures.map((failure) => `- ${failure}`));
    }
  }
  return `${lines.join('\n')}\n`;
}

export function writeCertificationReport(artifact: TerminalLifecycleCertArtifact, outDir: string): { jsonPath: string; markdownPath: string } {
  mkdirSync(outDir, { recursive: true });
  const base = `${artifact.runId.replace(/[^A-Za-z0-9_.-]/g, '-')}`;
  const jsonPath = join(outDir, `${base}.json`);
  const markdownPath = join(outDir, `${base}.md`);
  writeFileSync(jsonPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf-8');
  writeFileSync(markdownPath, renderCertificationMarkdown(artifact), 'utf-8');
  return { jsonPath, markdownPath };
}
