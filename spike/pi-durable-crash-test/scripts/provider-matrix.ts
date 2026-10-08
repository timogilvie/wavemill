// HOK-3150 gate 5: provider coverage probe.
//
// For every model currently certified for a native stage in the operator's
// cert store (~/.wavemill/native-agent-certifications), build a pi-ai 1.0.4
// Model and run a tiny smoke scenario (read → apply_patch → final answer)
// through pi-durable with in-memory storage. Record ok/fail, error class,
// response.model (for HOK-3143 identity verification), and tokens.
//
// Budgets:
//   - --dry-run         just lists certified models + checks pi-ai support
//                       (no model calls); use this when running without
//                       provider credentials. The default.
//   - --live            spend real tokens; capped per model and total.
//   - --budget-usd 3    overall cap (approximate — the spike has no
//                       authoritative USD meter; see output limits).

import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SPIKE_ROOT = path.resolve(__dirname, '..');

interface MatrixRow {
  readonly provider: string;
  readonly modelId: string;
  readonly piAiProviderAvailable: boolean;
  readonly certified: boolean;
  readonly stage?: string;
  readonly smokeOutcome: 'skipped-dry-run' | 'ok' | 'fail' | 'unauth' | 'balance';
  readonly reportedModel?: string;
  readonly notes?: string;
}

async function listCertifiedModels(): Promise<{ provider: string; modelId: string; stage: string }[]> {
  const certDir = path.join(os.homedir(), '.wavemill', 'native-agent-certifications');
  if (!existsSync(certDir)) return [];
  const out: { provider: string; modelId: string; stage: string }[] = [];
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(p);
      } else if (entry.isFile() && entry.name.endsWith('.json')) {
        try {
          const raw = JSON.parse(readFileSync(p, 'utf8'));
          const prov = raw?.identity?.provider ?? raw?.identity?.registryKey?.provider;
          const model = raw?.identity?.model ?? raw?.identity?.registryKey?.model ?? raw?.identity?.resolvedTarget?.model;
          const stage = raw?.identity?.phase ?? raw?.identity?.stage ?? raw?.phase;
          if (prov && model && stage) out.push({ provider: prov, modelId: model, stage });
        } catch {
          /* ignore malformed cert files */
        }
      }
    }
  };
  await walk(certDir);
  // Dedupe (prov, model, stage) tuples
  const seen = new Set<string>();
  return out.filter((r) => {
    const k = `${r.provider}:${r.modelId}:${r.stage}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

async function piAiHasProvider(name: string): Promise<boolean> {
  try {
    switch (name) {
      case 'openrouter': {
        const mod = await import('@earendil-works/pi-ai/providers/openrouter');
        return typeof (mod as any).openrouterProvider === 'function';
      }
      case 'openai': {
        const mod = await import('@earendil-works/pi-ai/providers/openai');
        return typeof (mod as any).openaiProvider === 'function';
      }
      case 'anthropic': {
        const mod = await import('@earendil-works/pi-ai/providers/anthropic');
        return typeof (mod as any).anthropicProvider === 'function';
      }
      case 'google': {
        const mod = await import('@earendil-works/pi-ai/providers/google-generative-ai' as any);
        return !!mod;
      }
      default:
        return false;
    }
  } catch {
    return false;
  }
}

async function dryRunRow(c: { provider: string; modelId: string; stage: string }): Promise<MatrixRow> {
  const supported = await piAiHasProvider(c.provider);
  return {
    provider: c.provider,
    modelId: c.modelId,
    piAiProviderAvailable: supported,
    certified: true,
    stage: c.stage,
    smokeOutcome: 'skipped-dry-run',
    notes: supported ? 'pi-ai 1.0.4 ships this provider; smoke not run (--dry-run)' : 'pi-ai 1.0.4 has no built-in provider for this id',
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const live = argv.includes('--live');
  if (live) {
    console.error('--live is not implemented in the spike (would spend real tokens). Use the operator-only path.');
    process.exit(2);
  }
  const certified = await listCertifiedModels();
  const rows: MatrixRow[] = [];
  if (certified.length === 0) {
    rows.push({
      provider: '(none)',
      modelId: '(none)',
      piAiProviderAvailable: false,
      certified: false,
      smokeOutcome: 'skipped-dry-run',
      notes: `No cert store at ~/.wavemill/native-agent-certifications. Run \`wavemill native-agent certifications list\` on the mill host to list certified models.`,
    });
  } else {
    for (const c of certified) rows.push(await dryRunRow(c));
  }

  const summary = {
    providers: Array.from(new Set(rows.map((r) => r.provider))),
    stages: Array.from(new Set(rows.map((r) => r.stage ?? '(unknown)'))),
    totalModels: rows.length,
    piAiSupported: rows.filter((r) => r.piAiProviderAvailable).length,
    piAiUnsupported: rows.filter((r) => r.certified && !r.piAiProviderAvailable).map((r) => `${r.provider}/${r.modelId}`),
    outcomes: rows.reduce<Record<string, number>>((acc, r) => {
      acc[r.smokeOutcome] = (acc[r.smokeOutcome] ?? 0) + 1;
      return acc;
    }, {}),
  };

  const outDir = path.join(SPIKE_ROOT, 'results');
  await mkdir(outDir, { recursive: true });
  await writeFile(
    path.join(outDir, 'provider-matrix.json'),
    JSON.stringify({ summary, rows }, null, 2) + '\n',
    'utf8',
  );
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error('provider-matrix failed:', err);
  process.exit(2);
});
