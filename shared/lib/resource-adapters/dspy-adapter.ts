import { basename, resolve } from 'node:path';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { registerResource, toResourceRef, type ResourceRef } from '../resource-registry.ts';
import type { SelectorArtifact } from '../llm-router.ts';
import { resolveWavemillAssetPath } from '../native-agent/install-paths.ts';

function getArtifactName(artifactPath: string): string {
  return basename(artifactPath).replace(/\.json$/, '');
}

export function registerDspyArtifact(
  artifactPath: string,
  artifact: Record<string, unknown>,
  repoDir?: string,
): ResourceRef | null {
  const serialized = JSON.stringify(artifact, null, 2);
  const version = typeof artifact.version === 'string' && artifact.version.trim()
    ? artifact.version
    : undefined;

  return toResourceRef(registerResource({
    type: 'optimizer-artifact',
    name: getArtifactName(artifactPath),
    content: serialized,
    version,
    uri: artifactPath,
    lineage: {
      optimizer: typeof artifact.optimizer === 'string' ? artifact.optimizer : undefined,
      source: artifactPath,
    },
    metadata: {
      optimizer: artifact.optimizer,
      createdAt: artifact.created_at,
      teacherModel: artifact.teacher_model,
      runtimeModel: artifact.runtime_model,
      path: artifactPath,
    },
  }, { repoDir }));
}

export function scanAndRegisterAll(repoDir?: string): ResourceRef[] {
  const artifactsDir = resolveWavemillAssetPath('dspy/artifacts');
  if (!existsSync(artifactsDir)) {
    return [];
  }

  return readdirSync(artifactsDir)
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => {
      const path = resolve(artifactsDir, entry);
      if (!statSync(path).isFile()) {
        return null;
      }
      const artifact = JSON.parse(readFileSync(path, 'utf-8')) as SelectorArtifact;
      return registerDspyArtifact(path, artifact, repoDir);
    })
    .filter((entry): entry is ResourceRef => Boolean(entry));
}
