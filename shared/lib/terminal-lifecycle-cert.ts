import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

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
  soakSamples: SoakSample[];
  gates: {
    soak: GateVerdict;
    budgets: GateVerdict;
  };
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
  return {
    schemaVersion: TERMINAL_LIFECYCLE_CERT_SCHEMA_VERSION,
    runId: input.runId ?? `terminal-lifecycle-cert-${Date.now()}`,
    createdAt: new Date().toISOString(),
    repoDir,
    matrixResults: input.matrixResults ?? [],
    budgets,
    soakSamples,
    gates: {
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
    `| Soak | ${artifact.gates.soak.pass ? 'PASS' : 'FAIL'} | ${artifact.gates.soak.failures.length} |`,
    `| Budgets | ${artifact.gates.budgets.pass ? 'PASS' : 'FAIL'} | ${artifact.gates.budgets.failures.length} |`,
    ``,
    `## Counts`,
    ``,
    `- Matrix results: ${artifact.matrixResults.length}`,
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
