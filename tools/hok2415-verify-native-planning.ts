import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { launchNativePlanning } from '../shared/lib/native-agent/launch-planning.ts';
import { resolveNativeAgentProviders, type ReadyNativeProviderEntry } from '../shared/lib/native-agent/providers.ts';
import { closeManifest, openManifest, resolveManifestPath } from '../shared/lib/resource-manifest.ts';

const MODELS = [
  'qwen/qwen3-coder',
  'z-ai/glm-5.2',
  'moonshotai/kimi-k2.7-code',
] as const;

const TASK_PACKET = [
  '# Task Packet',
  '',
  '## Objective',
  'Plan a small safe change: add a CLI help text clarification to a hypothetical wavemill command.',
  '',
  '## Context',
  'Verification-only planning exercise for HOK-2415. Do not edit files during planning.',
  '',
  '## Requirements',
  '- Inspect the repository only if useful.',
  '- Return an implementation plan with verification steps.',
  '- Include a Release Readiness section.',
].join('\n');

function segment(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'native-planning';
}

async function main(): Promise<void> {
  const repoDir = process.cwd();

  for (const modelId of MODELS) {
    const slug = `hok-2415-native-planning-${segment(modelId).toLowerCase()}`;
    const session = `hok-2415-${segment(modelId).toLowerCase()}-${Date.now()}`;
    const wtDir = mkdtempSync(join(tmpdir(), `${slug}-`));
    const featureDir = join(wtDir, 'features', slug);
    mkdirSync(featureDir, { recursive: true });
    writeFileSync(join(featureDir, 'task-packet.md'), `${TASK_PACKET}\n`, 'utf8');

    const allEntries = resolveNativeAgentProviders(repoDir, { phase: 'planning' });
    const providerEntries = allEntries
      .filter((entry): entry is ReadyNativeProviderEntry =>
        entry.status === 'ready' && entry.modelId === modelId
      );

    if (providerEntries.length === 0) {
      console.log(JSON.stringify({
        modelId,
        status: 'no_ready_provider',
        entries: allEntries.map((entry) => ({
          modelId: entry.modelId,
          status: entry.status,
          reason: 'reason' in entry ? entry.reason : undefined,
        })),
      }, null, 2));
      continue;
    }

    const runTsxCommand = (args: string[]): string => {
      const outputIndex = args.indexOf('--output');
      if (outputIndex < 0) {
        return '';
      }
      const outputPath = args[outputIndex + 1];
      if (basename(args[0]) === 'route-task.ts') {
        writeFileSync(outputPath, `${JSON.stringify({
          planner: modelId,
          coder: 'codex',
          reviewer: 'claude',
          planDepth: 'light',
          source: 'hok-2415-verification',
        }, null, 2)}\n`, 'utf8');
      } else {
        writeFileSync(outputPath, `${TASK_PACKET}\n`, 'utf8');
      }
      return '';
    };

    openManifest(session, { workflowType: 'verification', repoDir });
    let result: Awaited<ReturnType<typeof launchNativePlanning>>;
    try {
      result = await launchNativePlanning({
        session,
        issue: 'HOK-2415',
        slug,
        wtDir,
        repoDir,
        title: 'Verify native OpenRouter planning',
        planDepth: 'light',
        operatingMode: 'normal',
        providerEntries,
        runTsxCommand,
      });
      closeManifest(session, { status: 'completed', repoDir });
    } catch (error) {
      closeManifest(session, { status: 'failed', repoDir });
      throw error;
    }

    const transcriptPath = join(
      repoDir,
      '.wavemill',
      'runs',
      segment(session),
      'native-sessions',
      `${segment(session)}-planning-${segment(slug)}.jsonl`,
    );
    const planningResultPath = join(featureDir, '.planning-result.json');
    const planningResult = JSON.parse(readFileSync(planningResultPath, 'utf8')) as {
      status?: string;
      agent?: string;
      model?: string;
      notes?: string;
    };
    const hook = JSON.parse(readFileSync(result.hookPath, 'utf8')) as {
      state?: string;
      event?: string;
      detail?: string;
    };
    const manifestPath = resolveManifestPath(session, repoDir);
    const planText = readFileSync(result.planPath, 'utf8');

    console.log(JSON.stringify({
      modelId,
      status: 'completed',
      session,
      wtDir,
      stopReason: result.stopReason,
      artifacts: {
        plan: result.planPath,
        route: join(featureDir, '.post-expansion-route.json'),
        approvalMarker: result.approvalMarkerPath,
        hook: result.hookPath,
        transcript: transcriptPath,
        planningResult: planningResultPath,
        manifest: manifestPath,
      },
      exists: {
        plan: existsSync(result.planPath),
        route: existsSync(join(featureDir, '.post-expansion-route.json')),
        approvalMarker: existsSync(result.approvalMarkerPath),
        hook: existsSync(result.hookPath),
        transcript: existsSync(transcriptPath),
        planningResult: existsSync(planningResultPath),
        manifest: existsSync(manifestPath),
      },
      hook: { state: hook.state, event: hook.event, detail: hook.detail },
      planningResult: {
        status: planningResult.status,
        agent: planningResult.agent,
        model: planningResult.model,
        notes: planningResult.notes,
      },
      planHead: planText.split('\n').slice(0, 8),
      planBytes: planText.length,
      transcriptBytes: existsSync(transcriptPath) ? readFileSync(transcriptPath, 'utf8').length : 0,
      manifestBytes: existsSync(manifestPath) ? readFileSync(manifestPath, 'utf8').length : 0,
    }, null, 2));
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
