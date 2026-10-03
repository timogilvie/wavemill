#!/usr/bin/env -S npx tsx

import { relative } from 'node:path';
import { runTool } from '../shared/lib/tool-runner.ts';
import {
  listGlobalCertifications,
  readCertification,
  resolveCertificationStorage,
  resolveCertificationSubject,
  type AnyNativeCertificationArtifact,
  type CertificationSubject,
} from '../shared/lib/native-agent/certification/index.ts';
import {
  writeIdentityAudit,
  type IdentityAuditArtifact,
  type IdentityAuditOperation,
} from '../shared/lib/native-agent/certification/identity-invalidation.ts';
import { getEffectiveRegistry, type ModelRegistry } from '../shared/lib/model-registry.ts';

export type { IdentityAuditOperation, IdentityAuditArtifact } from '../shared/lib/native-agent/certification/identity-invalidation.ts';
export { writeIdentityAudit } from '../shared/lib/native-agent/certification/identity-invalidation.ts';

export interface IdentityCommandResult extends IdentityAuditArtifact {
  auditPath?: string;
}

export function planIdentityAudit(opts: {
  operation: IdentityAuditOperation;
  provider: string;
  model: string;
  reason?: string;
  root?: string;
  registry?: ModelRegistry;
  now?: () => Date;
}): IdentityCommandResult {
  const registry = opts.registry ?? getEffectiveRegistry();
  const now = opts.now ?? (() => new Date());
  const root = resolveCertificationStorage({ scope: 'global', root: opts.root }).root;
  const resolved = resolveCertificationSubject({
    provider: opts.provider,
    model: opts.model,
    registry,
  });
  const affected = listGlobalCertifications({ root: opts.root })
    .map((artifactPath) => ({ artifactPath, read: readCertification(artifactPath) }))
    .filter((entry): entry is { artifactPath: string; read: { ok: true; artifact: AnyNativeCertificationArtifact } } => entry.read.ok)
    .filter(({ read }) =>
      read.artifact.provider === resolved.storageIdentity.provider
      && read.artifact.model === resolved.storageIdentity.model);

  return {
    schemaVersion: 1,
    operation: opts.operation,
    dryRun: true,
    reason: opts.reason ?? (opts.operation === 'reidentify' ? 'identity-reidentified' : 'identity-invalidated'),
    createdAt: now().toISOString(),
    requested: {
      provider: opts.provider,
      model: opts.model,
    },
    oldSubjects: uniqueJson(affected.map(({ read }) =>
      'subject' in read.artifact
        ? read.artifact.subject
        : {
          schemaVersion: read.artifact.schemaVersion,
          provider: read.artifact.provider,
          model: read.artifact.model,
          suiteVersion: read.artifact.suiteVersion,
        })),
    newSubject: opts.operation === 'reidentify' ? resolved.subject : undefined,
    affectedArtifactPaths: affected.map(({ artifactPath }) => relative(root, artifactPath) || artifactPath).sort(),
    recertificationCommands: affected.map(({ read }) =>
      `wavemill native-agent certifications re-certify --provider ${resolved.subject.nativeProvider} --model ${resolved.subject.registryKey} --phase ${read.artifact.phase}`,
    ),
  };
}

export function runReidentifyCommand(argv = process.argv.slice(2)): Promise<void> {
  return runIdentityCommand('reidentify', argv);
}

export function runInvalidateCommand(argv = process.argv.slice(2)): Promise<void> {
  return runIdentityCommand('invalidate', argv);
}

function runIdentityCommand(operation: IdentityAuditOperation, argv: string[]): Promise<void> {
  return runTool({
    name: `native-agent-certifications ${operation}`,
    description: `${operation} native-agent certification identity audit records. Defaults to dry-run.`,
    options: {
      provider: { type: 'string', description: 'Native provider.' },
      model: { type: 'string', description: 'Model alias or provider-native ID.' },
      reason: { type: 'string', description: 'Audit reason.' },
      execute: { type: 'boolean', description: 'Write the audit artifact.' },
      json: { type: 'boolean', description: 'Emit machine-readable JSON.' },
      root: { type: 'string', description: 'Override the global certification root.' },
    },
    examples: [
      `wavemill native-agent certifications ${operation} --provider openrouter --model ox-alpha --json`,
      `wavemill native-agent certifications ${operation} --provider openrouter --model ox-alpha --execute`,
    ],
    async run({ args }) {
      const provider = args.provider as string | undefined;
      const model = args.model as string | undefined;
      if (!provider || !model) {
        console.error('Error: --provider and --model are required');
        process.exit(2);
      }
      const root = resolveCertificationStorage({ scope: 'global', root: args.root as string | undefined }).root;
      const dryRun = args.execute !== true;
      const plan = planIdentityAudit({
        operation,
        provider,
        model,
        reason: args.reason as string | undefined,
        root: args.root as string | undefined,
      });
      const result: IdentityCommandResult = {
        ...plan,
        dryRun,
      };
      if (!dryRun) {
        result.auditPath = writeIdentityAudit(root, result);
      }
      if (args.json === true) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(`${operation.toUpperCase()} ${dryRun ? 'DRY-RUN' : 'AUDIT-WRITTEN'}`);
      console.log(`Reason: ${result.reason}`);
      if (result.newSubject) console.log(`New subject: ${JSON.stringify(result.newSubject)}`);
      console.log('Affected artifacts:');
      for (const artifactPath of result.affectedArtifactPaths) console.log(`  ${artifactPath}`);
      console.log('Re-certification commands:');
      for (const command of result.recertificationCommands) console.log(`  ${command}`);
      if (result.auditPath) console.log(`Audit: ${result.auditPath}`);
    },
  }, argv);
}

function uniqueJson(values: unknown[]): unknown[] {
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const value of values) {
    const key = JSON.stringify(value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}
