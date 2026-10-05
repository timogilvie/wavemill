import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { runNativeExpansion, writeNativeExpansionSidecar } from '../shared/lib/native-expansion.ts';
import { isValidTaskPacket, writeTaskPacketArtifacts } from '../shared/lib/task-packet-utils.ts';
import { DEFAULT_VALIDATION_CONFIG, validateTaskPacket } from '../shared/lib/task-packet-validator.ts';
import { loadPromptTemplate } from '../shared/lib/prompt-utils.ts';
import { closeManifest, openManifest, resolveManifestPath } from '../shared/lib/resource-manifest.ts';
import { resolveWavemillPromptPath } from '../shared/lib/native-agent/install-paths.ts';

async function main(): Promise<void> {
  const repoDir = process.cwd();
  const outDir = '/tmp/hok2417/fixture';
  const outputFile = join(outDir, 'task-packet.md');
  const session = `hok-2417-fixture-native-expansion-${Date.now()}`;
  mkdirSync(outDir, { recursive: true });

  const promptTemplate = await loadPromptTemplate(resolveWavemillPromptPath('issue-writer.md'));
  const issueContext = [
    'Issue: HOK-2417-FIXTURE',
    'Title: Fixture-backed native task expansion verification',
    'Description:',
    'Create a verification-only task packet for checking native OpenRouter task expansion artifacts.',
    'Acceptance criteria:',
    '- Confirm task packet sections are present.',
    '- Confirm native metadata and transcript are emitted.',
    '- Confirm missing certification and missing API key behavior is covered separately.',
  ].join('\n');
  const codebaseContext = [
    'Relevant files:',
    '- shared/lib/native-expansion.ts controls native task expansion.',
    '- tools/expand-issue.ts writes task packet artifacts and native sidecars.',
    '- shared/lib/native-agent/providers.ts gates native provider selection on certification artifacts.',
  ].join('\n');

  openManifest(session, { workflowType: 'verification', repoDir });
  let result: Awaited<ReturnType<typeof runNativeExpansion>>;
  try {
    result = await runNativeExpansion({
      promptTemplate,
      issueContext,
      codebaseContext,
      mode: 'normal',
      repoDir,
      issueId: 'HOK-2417-FIXTURE',
      env: {
        ...process.env,
        WAVEMILL_SESSION: session,
        WAVEMILL_ISSUE: 'HOK-2417-FIXTURE',
      },
    });
    closeManifest(session, { status: 'completed', repoDir });
  } catch (error) {
    closeManifest(session, { status: 'failed', repoDir });
    throw error;
  }

  const artifacts = await writeTaskPacketArtifacts(outputFile, {
    header: '',
    details: '',
    fullContent: result.text,
  });
  const sidecar = await writeNativeExpansionSidecar(outputFile, result.native);
  const validation = await validateTaskPacket(result.text, repoDir, {
    ...DEFAULT_VALIDATION_CONFIG,
    layer2: { enabled: false },
  });
  const manifestPath = resolveManifestPath(session, repoDir);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    status?: string;
    resources?: unknown[];
    phases?: Record<string, unknown[]>;
  };

  console.log(JSON.stringify({
    issueId: 'HOK-2417-FIXTURE',
    session,
    model: result.native.model,
    provider: result.native.provider,
    api: result.native.api,
    cost: result.native.cost,
    inputTokens: result.native.totalInputTokens,
    outputTokens: result.native.totalOutputTokens,
    deniedToolCalls: result.native.deniedToolCalls,
    stopReason: result.native.stopReason,
    durationMs: result.native.durationMs,
    artifacts: {
      taskPacket: outputFile,
      header: artifacts.header,
      details: artifacts.details,
      sidecar,
      transcript: result.native.transcriptPath,
      manifest: manifestPath,
    },
    exists: {
      taskPacket: existsSync(outputFile),
      header: existsSync(artifacts.header),
      details: existsSync(artifacts.details),
      sidecar: existsSync(sidecar),
      transcript: existsSync(result.native.transcriptPath),
      manifest: existsSync(manifestPath),
    },
    bytes: {
      taskPacket: statSync(outputFile).size,
      sidecar: statSync(sidecar).size,
      transcript: statSync(result.native.transcriptPath).size,
      manifest: statSync(manifestPath).size,
    },
    validation: {
      isValidTaskPacket: isValidTaskPacket(result.text),
      passed: validation.passed,
      issueCount: validation.issues.length,
      layer1IssueCount: validation.layer1Issues.length,
    },
    manifestSummary: {
      status: manifest.status,
      resources: manifest.resources?.length ?? 0,
      taskExpansionRecords: manifest.phases?.['task-expansion']?.length ?? 0,
      phases: Object.keys(manifest.phases ?? {}),
    },
  }, null, 2));
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
