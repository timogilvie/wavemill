import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import Ajv from 'ajv';
import type { EvalRecord, RoutingRole } from './eval-schema.ts';
import {
  assertRegistryConsistency,
  computeIdentityFingerprint,
  type ModelCapabilities,
  type NativeCertificationMetadata,
} from './model-registry.ts';
import {
  loadModelRegistryCatalog,
  projectModelRegistryCatalog,
  type ModelRegistryCatalog,
} from './model-registry-loader.ts';
import { computeNormalizedEvaluationCost, type ModelPricing } from './pricing/model-pricing.ts';
import { deduplicateByHash } from './eval-aggregator.ts';
import {
  CERTIFICATION_SCHEMA_VERSION,
  isRevisionAwareArtifact,
  phaseSatisfies,
  type CertificationPhase,
  type CertificationSubject,
  type NativeCertificationArtifact,
} from './native-agent/certification/schema.ts';
import { listGlobalCertifications, readCertification } from './native-agent/certification/store.ts';
import {
  resolveCertificationSubject,
  subjectsEqual,
} from './native-agent/certification/identity.ts';

export interface ModelTransitionSpec {
  schemaVersion: '1';
  promotionId: string;
  manifestId?: string;
  catalogPath?: string;
  expected?: {
    minimumOldReferences?: number;
    maximumOldReferences?: number;
  };
  provisional: {
    alias: string;
    providerNativeId?: string;
    identityRevision: number;
  };
  final: {
    alias: string;
    provider: string;
    providerNativeId: string;
    identityRevision: number;
    displayName: string;
    family: string;
    pricingRevision?: string;
    pricing: Required<ModelPricing>;
    verification: {
      source: string;
      observedAt: string;
      catalogHash: string;
    };
    capabilities?: Partial<ModelCapabilities>;
  };
  disclosure: {
    disclosedAt: string;
    source: string;
  };
}

export type PromotionMode = 'dry-run' | 'apply' | 'rollback';
export type PromotionStatus = 'planned' | 'applied' | 'already_applied' | 'rolled_back';
export type CorpusKind = 'catalog' | 'json' | 'jsonl';

export interface PromotionFileManifest {
  path: string;
  relativePath: string;
  kind: CorpusKind;
  beforeHash: string;
  afterHash: string;
  recordCount: number;
  fieldChanges: number;
  oldReferencesBefore: number;
  finalReferencesBefore: number;
  finalReferencesAfter: number;
  backupPath?: string;
  tempPath?: string;
}

export interface DerivedCorpusManifest {
  path: string;
  relativePath: string;
  sourcePath: string;
  beforeHash: string;
  afterHash: string;
  beforeRecordCount: number;
  afterRecordCount: number;
  sourceRawRecordCount: number;
  duplicatesRemoved: number;
  backupPath?: string;
  tempPath?: string;
}

export interface PromotionManifest {
  schemaVersion: '1';
  manifestId: string;
  promotionId: string;
  mode: PromotionMode;
  status: PromotionStatus;
  repoDir: string;
  createdAt: string;
  provisional: ModelTransitionSpec['provisional'];
  final: ModelTransitionSpec['final'];
  disclosure: ModelTransitionSpec['disclosure'];
  files: PromotionFileManifest[];
  conservation: {
    evalIdsBefore: string[];
    evalIdsAfter: string[];
    evalIdsConserved: boolean;
    totalRecordsBefore: number;
    totalRecordsAfter: number;
    totalFieldChanges: number;
    oldReferencesBefore: number;
    oldReferencesAfter: number;
    finalReferencesBefore: number;
    finalReferencesAfter: number;
  };
  normalizedCost: {
    complete: number;
    missingTokenUsage: number;
    missingCacheUsage: number;
    missingCachePricing: number;
  };
  lineage: {
    catalogPath?: string;
    provisionalSuccessor: string;
    finalPredecessor: string;
  };
  derivedCorpora: DerivedCorpusManifest[];
  diagnostics: string[];
  manifestPath?: string;
}

export interface PlanPromotionOptions {
  spec: ModelTransitionSpec;
  repoDir: string;
  now?: string;
}

export interface ApplyPromotionOptions extends PlanPromotionOptions {
  manifest?: PromotionManifest;
}

export type ActivationStatus = 'activated' | 'already_activated';

export interface ActivatePromotionOptions {
  spec: ModelTransitionSpec;
  repoDir: string;
  now?: string;
  /**
   * Certification store root override. Defaults to the global store
   * (`~/.wavemill/native-agent-certifications`, or
   * `WAVEMILL_NATIVE_CERTIFICATION_ROOT` when set).
   */
  certificationRoot?: string;
}

export interface ActivationManifest {
  schemaVersion: '1';
  manifestId: string;
  promotionId: string;
  mode: 'activate';
  status: ActivationStatus;
  repoDir: string;
  createdAt: string;
  final: ModelTransitionSpec['final'];
  certification: {
    path: string;
    certifiedAt: string;
    phase: CertificationPhase;
    suiteVersion: string;
    subject: CertificationSubject;
  };
  registry: {
    path: string;
    relativePath: string;
    beforeHash: string;
    afterHash: string;
    backupPath?: string;
  };
  fieldChanges: string[];
  diagnostics: string[];
  manifestPath: string;
}

const TRANSITION_SCHEMA = JSON.parse(
  readFileSync(new URL('../schemas/model-transition.schema.json', import.meta.url), 'utf-8'),
);
const ajv = new Ajv({ allErrors: true, strict: false });
const validateTransitionSpec = ajv.compile(TRANSITION_SCHEMA);

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  '.next',
  'dist',
  'coverage',
  // Certification artifacts are subject records, never promotable corpora:
  // re-keying one would fabricate a certificate for the final identity
  // instead of requiring fresh certification of the promoted subject.
  'native-agent-certifications',
]);

const MODEL_ID_KEYS = new Set([
  'modelId',
  'resolvedModelId',
  'attempted_model',
  'model_alias',
  'judgeModel',
  'planner',
  'coder',
  'reviewer',
  'model',
  'primaryModel',
  'challengerModel',
  'requestedModel',
  'resolvedModel',
  'executedModel',
  'intendedModel',
  'fallbackModel',
  'selectedModel',
  'winningModel',
  'losingModel',
  'registryKey',
  'wavemillAlias',
  'alias',
]);

const MODEL_ARRAY_KEYS = new Set([
  'models_available',
  'modelsAvailable',
  'candidateOnlyProvisional',
  'candidates',
  'modelIds',
  'eligibleModels',
  'rejectedModels',
  'excludedModels',
]);

const MODEL_MAP_KEYS = new Set([
  'workflowTokenUsage',
  'pricingSnapshot',
  'models',
  'quota',
  'quota_snapshot',
]);

const PROVIDER_ID_KEYS = new Set([
  'providerNativeId',
  'provider_native_id',
  'providerModelId',
  'providerModel',
  'providerReturnedModel',
  'requestedWireId',
  'providerId',
  'openrouterId',
]);

const HOKUSAI_NAME = /hokusai/i;

const DERIVED_CORPUS_BASENAMES = new Set([
  'aggregated-evals.jsonl',
  'aggregated-evals.backfilled.jsonl',
]);

const RAW_EVALS_RELATIVE_PATH = join('.wavemill', 'evals', 'evals.jsonl');

interface ParsedJsonl {
  records: unknown[];
  lineCount: number;
}

interface TransformedData {
  value: unknown;
  fieldChanges: number;
  oldReferencesBefore: number;
  finalReferencesBefore: number;
  finalReferencesAfter: number;
  normalizedCost: PromotionManifest['normalizedCost'];
  evalIds: string[];
}

interface PlannedFile {
  manifest: PromotionFileManifest;
  content: string;
}

interface PlannedDerivedCorpus {
  manifest: DerivedCorpusManifest;
  content: string;
}

interface PromotionPlan {
  manifest: PromotionManifest;
  files: PlannedFile[];
  derivedCorpora: PlannedDerivedCorpus[];
}

export function parseModelTransitionSpecFile(path: string): ModelTransitionSpec {
  const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
  return validateModelTransitionSpec(parsed);
}

export function validateModelTransitionSpec(value: unknown): ModelTransitionSpec {
  if (!validateTransitionSpec(value)) {
    const detail = (validateTransitionSpec.errors ?? [])
      .map((error) => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`)
      .join('; ');
    throw new Error(`Invalid model transition spec: ${detail}`);
  }
  return value as ModelTransitionSpec;
}

/**
 * Structural check for checked-in model transition specs. Spec files carry the
 * provisional alias/providerNativeId in structured keys (`alias`,
 * `providerNativeId`) by design, so corpus discovery must not treat them as
 * promotable data: counting them would trip the "both provisional and final
 * references present" refusal and applying would rewrite the spec itself.
 */
export function isTransitionSpecShape(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.promotionId === 'string'
    && !!record.provisional && typeof record.provisional === 'object'
    && !!record.final && typeof record.final === 'object'
    && !!record.disclosure && typeof record.disclosure === 'object';
}

function contentMentionsIdentities(content: string, spec: ModelTransitionSpec): boolean {
  const needles = [
    spec.provisional.alias,
    spec.provisional.providerNativeId,
    spec.final.alias,
    spec.final.providerNativeId,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
  return needles.some((needle) => content.includes(needle));
}

export function planModelPromotion(options: PlanPromotionOptions): PromotionManifest {
  return buildPromotionPlan(options).manifest;
}

export function applyModelPromotion(options: ApplyPromotionOptions): PromotionManifest {
  const repoDir = resolve(options.repoDir);
  const manifestPath = promotionManifestPath(repoDir, options.spec);
  if (existsSync(manifestPath)) {
    const existing = JSON.parse(readFileSync(manifestPath, 'utf-8')) as PromotionManifest;
    if (existing.status === 'applied' && isAlreadyApplied(options.spec, repoDir)) {
      return {
        ...existing,
        mode: 'apply',
        status: 'already_applied',
        diagnostics: ['promotion already applied; no writes performed'],
      };
    }
  }

  const plan = options.manifest
    ? rebuildPlanFromManifest(options, options.manifest)
    : buildPromotionPlan({ ...options, repoDir });
  if (plan.manifest.status === 'already_applied') {
    return plan.manifest;
  }

  mkdirSync(promotionDir(repoDir, options.spec), { recursive: true });
  for (const file of plan.files) {
    if (file.manifest.fieldChanges === 0) {
      continue;
    }
    const currentHash = sha256(readFileSync(file.manifest.path, 'utf-8'));
    if (currentHash !== file.manifest.beforeHash) {
      cleanupTemps(plan.files);
      throw new Error(`Refusing to apply stale plan; hash changed for ${file.manifest.relativePath}`);
    }
    const backupPath = file.manifest.backupPath;
    const tempPath = file.manifest.tempPath;
    if (!backupPath || !tempPath) {
      cleanupTemps(plan.files);
      throw new Error(`Internal error: missing backup/temp path for ${file.manifest.relativePath}`);
    }
    mkdirSync(dirname(backupPath), { recursive: true });
    mkdirSync(dirname(tempPath), { recursive: true });
    if (!existsSync(backupPath)) {
      copyFileSync(file.manifest.path, backupPath);
    }
    writeFileSync(tempPath, file.content, 'utf-8');
    const stagedHash = sha256(readFileSync(tempPath, 'utf-8'));
    if (stagedHash !== file.manifest.afterHash) {
      cleanupTemps(plan.files);
      throw new Error(`Internal error: staged hash mismatch for ${file.manifest.relativePath}`);
    }
  }

  for (const file of plan.files) {
    if (file.manifest.fieldChanges === 0 || !file.manifest.tempPath) {
      continue;
    }
    renameSync(file.manifest.tempPath, file.manifest.path);
  }

  for (const derived of plan.derivedCorpora) {
    if (derived.manifest.beforeHash === derived.manifest.afterHash) {
      continue;
    }
    const backupPath = derived.manifest.backupPath;
    const tempPath = derived.manifest.tempPath;
    if (!backupPath || !tempPath) {
      throw new Error(`Internal error: missing backup/temp path for derived corpus ${derived.manifest.relativePath}`);
    }
    mkdirSync(dirname(backupPath), { recursive: true });
    mkdirSync(dirname(tempPath), { recursive: true });
    if (!existsSync(backupPath)) {
      copyFileSync(derived.manifest.path, backupPath);
    }
    writeFileSync(tempPath, derived.content, 'utf-8');
    const stagedHash = sha256(readFileSync(tempPath, 'utf-8'));
    if (stagedHash !== derived.manifest.afterHash) {
      unlinkSync(tempPath);
      throw new Error(`Internal error: staged hash mismatch for derived corpus ${derived.manifest.relativePath}`);
    }
    renameSync(tempPath, derived.manifest.path);
  }

  const appliedManifest: PromotionManifest = {
    ...plan.manifest,
    mode: 'apply',
    status: 'applied',
    manifestPath,
  };
  writeFileSync(manifestPath, `${JSON.stringify(appliedManifest, null, 2)}\n`, 'utf-8');
  return appliedManifest;
}

export function rollbackModelPromotion(manifestPath: string): PromotionManifest {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as PromotionManifest;
  const restorations: Array<{ path: string; backupPath: string; beforeHash: string }> = [];
  for (const file of manifest.files) {
    if (!file.backupPath) continue;
    restorations.push({ path: file.path, backupPath: file.backupPath, beforeHash: file.beforeHash });
  }
  for (const derived of manifest.derivedCorpora ?? []) {
    if (!derived.backupPath) continue;
    restorations.push({ path: derived.path, backupPath: derived.backupPath, beforeHash: derived.beforeHash });
  }
  for (const restoration of restorations) {
    if (!existsSync(restoration.backupPath)) {
      throw new Error(`Missing backup for rollback: ${restoration.backupPath}`);
    }
    const backupContent = readFileSync(restoration.backupPath, 'utf-8');
    if (sha256(backupContent) !== restoration.beforeHash) {
      throw new Error(`Backup hash mismatch for rollback: ${restoration.backupPath}`);
    }
  }
  for (const restoration of restorations) {
    const tempPath = `${restoration.path}.rollback-${process.pid}.tmp`;
    copyFileSync(restoration.backupPath, tempPath);
    renameSync(tempPath, restoration.path);
  }

  const rolledBack: PromotionManifest = {
    ...manifest,
    mode: 'rollback',
    status: 'rolled_back',
    diagnostics: [...manifest.diagnostics, 'rollback restored exact backups'],
  };
  return rolledBack;
}

/**
 * Activate an already-promoted model: the post-certification half of a
 * promotion. The apply path deliberately lands the final model with
 * `launchEligible`/`routingEligible` false, `readOnlyNative` partial, and
 * `evidencePolicy` held; nothing may flip those until certification of the
 * final subject has actually run. Activation verifies a matching
 * revision-aware certification artifact in the certification store first, so
 * the apply → certify → activate gate is enforced by the tool rather than by
 * reviewer vigilance. Refusals leave the catalog byte-for-byte unchanged, and
 * repeat invocations report `already_activated` without writing.
 */
export function activateModelPromotion(options: ActivatePromotionOptions): ActivationManifest {
  const spec = validateModelTransitionSpec(options.spec);
  const repoDir = resolve(options.repoDir);
  const now = options.now ?? new Date().toISOString();
  const catalogPath = resolveCatalogPath(repoDir, spec);
  if (!catalogPath) {
    throw new Error('No model registry catalog found; nothing to activate');
  }
  const beforeContent = readFileSync(catalogPath, 'utf-8');
  const catalog = loadModelRegistryCatalog(catalogPath);
  const finalEntry = catalog.models.find((entry) => entry.id === spec.final.alias);
  if (!finalEntry) {
    throw new Error(
      `Catalog does not contain final model ${spec.final.alias}; run the promotion with --apply before --activate`,
    );
  }
  const provisionalEntry = catalog.models.find((entry) => entry.id === spec.provisional.alias);
  if (provisionalEntry?.capabilities.identity?.lineage?.successor !== spec.final.alias) {
    throw new Error(
      `Catalog entry ${spec.final.alias} is not the promoted successor of ${spec.provisional.alias}; refusing to activate`,
    );
  }
  const capabilities = finalEntry.capabilities;
  const nativeCapability = capabilities.nativeCapability;
  const supportedModel = capabilities.supportedModel;
  const identity = capabilities.identity;
  if (!nativeCapability || !supportedModel || !identity) {
    throw new Error(
      `Final model ${spec.final.alias} is missing nativeCapability, supportedModel, or identity metadata; cannot activate`,
    );
  }

  const certification = findActivationCertification(spec, catalog, options.certificationRoot);

  const fieldChanges: string[] = [];
  if (nativeCapability.readOnlyNative !== 'certified') {
    nativeCapability.readOnlyNative = 'certified';
    fieldChanges.push('nativeCapability.readOnlyNative=certified');
  }
  // The certification metadata mirrors the validated artifact: apply seeds a
  // stale block from the provisional source (or none at all), and the actual
  // certification timestamp only exists once the artifact does.
  const certificationMetadata: NativeCertificationMetadata = {
    ...(nativeCapability.certification ?? {}),
    maxCertifiedPhase: certification.artifact.phase,
    certifiedAt: certification.artifact.certifiedAt,
    certificationSuiteVersion: certification.artifact.suiteVersion,
  };
  if (JSON.stringify(nativeCapability.certification) !== JSON.stringify(certificationMetadata)) {
    nativeCapability.certification = certificationMetadata;
    fieldChanges.push(`nativeCapability.certification.certifiedAt=${certification.artifact.certifiedAt}`);
  }
  if (supportedModel.launchEligible !== true) {
    supportedModel.launchEligible = true;
    fieldChanges.push('supportedModel.launchEligible=true');
  }
  if (supportedModel.routingEligible !== true) {
    supportedModel.routingEligible = true;
    fieldChanges.push('supportedModel.routingEligible=true');
  }
  if (identity.evidencePolicy !== 'eligible') {
    identity.evidencePolicy = 'eligible';
    fieldChanges.push('identity.evidencePolicy=eligible');
  }

  const manifestPath = activationManifestPath(repoDir, spec);
  const beforeHash = sha256(beforeContent);
  const relativeCatalogPath = relative(repoDir, catalogPath);
  const baseManifest = {
    schemaVersion: '1' as const,
    manifestId: spec.manifestId ?? spec.promotionId,
    promotionId: spec.promotionId,
    mode: 'activate' as const,
    repoDir,
    createdAt: now,
    final: spec.final,
    certification: {
      path: certification.path,
      certifiedAt: certification.artifact.certifiedAt,
      phase: certification.artifact.phase,
      suiteVersion: certification.artifact.suiteVersion,
      subject: certification.artifact.subject,
    },
    fieldChanges,
    manifestPath,
  };

  if (fieldChanges.length === 0) {
    return {
      ...baseManifest,
      status: 'already_activated',
      registry: {
        path: catalogPath,
        relativePath: relativeCatalogPath,
        beforeHash,
        afterHash: beforeHash,
      },
      diagnostics: ['model already activated; no writes performed'],
    };
  }

  // The activated catalog must still satisfy every registry invariant (e.g.
  // readOnlyNative=certified must agree with the transport compat flags)
  // before any file is touched.
  assertRegistryConsistency(projectModelRegistryCatalog(catalog));

  const afterContent = `${JSON.stringify(catalog, null, 2)}\n`;
  const backupPath = join(promotionDir(repoDir, spec), 'activation-backups', relativeCatalogPath);
  mkdirSync(dirname(backupPath), { recursive: true });
  if (!existsSync(backupPath)) {
    copyFileSync(catalogPath, backupPath);
  }
  const tempPath = tempPathFor(catalogPath, spec);
  writeFileSync(tempPath, afterContent, 'utf-8');
  renameSync(tempPath, catalogPath);

  const manifest: ActivationManifest = {
    ...baseManifest,
    status: 'activated',
    registry: {
      path: catalogPath,
      relativePath: relativeCatalogPath,
      beforeHash,
      afterHash: sha256(afterContent),
      backupPath,
    },
    diagnostics: [`activation flipped ${fieldChanges.length} field(s) after verified certification`],
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
  return manifest;
}

interface ActivationCertification {
  artifact: NativeCertificationArtifact;
  path: string;
}

/**
 * Locate a certification artifact that proves the promoted final subject was
 * certified: current schema, revision-aware subject equal to the catalog's
 * resolved subject, matching suite version, and a phase satisfying the
 * highest phase the catalog requires. Throws when nothing qualifies.
 */
function findActivationCertification(
  spec: ModelTransitionSpec,
  catalog: ModelRegistryCatalog,
  certificationRoot?: string,
): ActivationCertification {
  const registry = projectModelRegistryCatalog(catalog);
  const capabilities = registry.models[spec.final.alias];
  const suiteVersion = capabilities?.supportedModel?.certificationSuiteVersion
    ?? capabilities?.nativeCapability?.certification?.certificationSuiteVersion
    ?? capabilities?.supportedModel?.canonicalArtifactIdentity?.suiteVersion;
  if (!suiteVersion) {
    throw new Error(`Final model ${spec.final.alias} declares no certificationSuiteVersion; cannot verify certification`);
  }
  const requiredPhase = highestRequiredPhase(capabilities?.supportedModel?.requiredCertificationPhaseByStage)
    ?? capabilities?.nativeCapability?.certification?.maxCertifiedPhase
    ?? 'read-only';
  const nativeProvider = capabilities?.nativeCapability?.nativeProvider;
  if (!nativeProvider) {
    throw new Error(`Final model ${spec.final.alias} declares no nativeProvider; cannot resolve certification subject`);
  }
  const subject = resolveCertificationSubject({
    provider: nativeProvider,
    model: spec.final.alias,
    registry,
  }).subject;
  for (const certPath of listGlobalCertifications({ root: certificationRoot })) {
    const result = readCertification(certPath);
    if (!result.ok || !isRevisionAwareArtifact(result.artifact)) {
      continue;
    }
    const artifact = result.artifact;
    if (
      artifact.suiteVersion === suiteVersion
      && phaseSatisfies(artifact.phase, requiredPhase)
      && subjectsEqual(artifact.subject, subject)
    ) {
      return { artifact, path: certPath };
    }
  }
  throw new Error(
    `No certification artifact for ${spec.final.alias} satisfies suite ${suiteVersion} at phase ${requiredPhase} or above; `
    + 'certify the promoted model before --activate',
  );
}

function buildPromotionPlan(options: PlanPromotionOptions): PromotionPlan {
  const spec = validateModelTransitionSpec(options.spec);
  const repoDir = resolve(options.repoDir);
  validateIdentityInputs(spec);
  const catalogPath = resolveCatalogPath(repoDir, spec);
  const files = discoverPromotionFiles(repoDir, catalogPath);
  const now = options.now ?? new Date().toISOString();
  const plannedFiles: PlannedFile[] = [];
  let totalRecordsBefore = 0;
  let totalRecordsAfter = 0;
  let totalFieldChanges = 0;
  let oldReferencesBefore = 0;
  let oldReferencesAfter = 0;
  let finalReferencesBefore = 0;
  let finalReferencesAfter = 0;
  const evalIdsBefore: string[] = [];
  const evalIdsAfter: string[] = [];
  const normalizedCost = emptyNormalizedCostCounts();
  const diagnostics: string[] = [];

  for (const path of files) {
    const kind = path === catalogPath ? 'catalog' : path.endsWith('.jsonl') ? 'jsonl' : 'json';
    const beforeContent = readFileSync(path, 'utf-8');
    const beforeHash = sha256(beforeContent);
    let beforeRecords: unknown[];
    try {
      beforeRecords = kind === 'jsonl'
        ? parseStrictJsonl(path, beforeContent).records
        : [parseStrictJson(path, beforeContent)];
    } catch (error) {
      if (contentMentionsIdentities(beforeContent, spec)) {
        // A broken file that names either identity cannot be transformed
        // safely, so the whole promotion refuses rather than skipping it.
        throw error;
      }
      diagnostics.push(
        `Skipped unparseable ${kind} file ${relative(repoDir, path)} (mentions neither identity): `
        + `${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    if (kind === 'json' && isTransitionSpecShape(beforeRecords[0])) {
      // Checked-in transition specs intentionally reference both identities in
      // structured keys; they describe the promotion and are never a corpus.
      diagnostics.push(`Skipped transition spec ${relative(repoDir, path)} (promotion input, not a corpus).`);
      continue;
    }
    refuseAcceptedHokusaiRows(path, beforeRecords, spec);
    const transformed = kind === 'catalog'
      ? transformCatalogFile(path, spec, now)
      : transformRecords(beforeRecords, spec, now);
    // transformRecords always yields an array; a plain JSON file holds exactly
    // one document, which must be written back unwrapped.
    const afterValue = kind === 'json' ? (transformed.value as unknown[])[0] : transformed.value;
    const afterRecords = kind === 'jsonl'
      ? (transformed.value as unknown[])
      : [afterValue];
    const afterContent = kind === 'jsonl'
      ? serializeJsonl(transformed.value as unknown[])
      : `${JSON.stringify(afterValue, null, 2)}\n`;
    const afterHash = sha256(afterContent);
    const recordCount = kind === 'jsonl' ? beforeRecords.length : 1;
    totalRecordsBefore += recordCount;
    totalRecordsAfter += afterRecords.length;
    totalFieldChanges += transformed.fieldChanges;
    oldReferencesBefore += transformed.oldReferencesBefore;
    finalReferencesBefore += transformed.finalReferencesBefore;
    finalReferencesAfter += transformed.finalReferencesAfter;
    oldReferencesAfter += kind === 'catalog' ? 0 : countReferences(afterRecords, spec, 'old');
    evalIdsBefore.push(...extractEvalIds(beforeRecords));
    evalIdsAfter.push(...extractEvalIds(afterRecords));
    addNormalizedCostCounts(normalizedCost, transformed.normalizedCost);

    plannedFiles.push({
      manifest: {
        path,
        relativePath: relative(repoDir, path),
        kind,
        beforeHash,
        afterHash,
        recordCount,
        fieldChanges: transformed.fieldChanges,
        oldReferencesBefore: transformed.oldReferencesBefore,
        finalReferencesBefore: transformed.finalReferencesBefore,
        finalReferencesAfter: transformed.finalReferencesAfter,
        backupPath: transformed.fieldChanges > 0 ? backupPathFor(repoDir, spec, path) : undefined,
        tempPath: transformed.fieldChanges > 0 ? tempPathFor(path, spec) : undefined,
      },
      content: afterContent,
    });
  }

  validatePreflight(spec, repoDir, catalogPath, plannedFiles, {
    oldReferencesBefore,
    oldReferencesAfter,
    finalReferencesBefore,
    finalReferencesAfter,
    evalIdsBefore,
    evalIdsAfter,
  });

  const rawEvalsPlan = plannedFiles.find(
    (file) => relative(repoDir, file.manifest.path) === RAW_EVALS_RELATIVE_PATH,
  );
  const derivedCorpora = planDerivedCorpora(repoDir, spec, rawEvalsPlan);

  const derivedNeedsRebuild = derivedCorpora.some(
    (entry) => entry.manifest.beforeHash !== entry.manifest.afterHash,
  );
  const status: PromotionStatus = oldReferencesBefore === 0 && finalReferencesBefore > 0 && !derivedNeedsRebuild
    ? 'already_applied'
    : 'planned';
  if (status === 'already_applied') {
    diagnostics.push('promotion already appears applied; no writes planned');
  }
  for (const derived of derivedCorpora) {
    const rebuiltTotal = derived.manifest.afterRecordCount + derived.manifest.duplicatesRemoved;
    if (rebuiltTotal !== derived.manifest.sourceRawRecordCount) {
      throw new Error(
        `Derived corpus ${derived.manifest.relativePath} raw-to-derived record counts do not reconcile: `
        + `sourceRaw=${derived.manifest.sourceRawRecordCount} after=${derived.manifest.afterRecordCount} `
        + `duplicatesRemoved=${derived.manifest.duplicatesRemoved}`,
      );
    }
    diagnostics.push(
      `Derived corpus ${derived.manifest.relativePath} will be rebuilt from re-keyed raw evals`
      + ` (source ${relative(repoDir, derived.manifest.sourcePath)}, `
      + `${derived.manifest.sourceRawRecordCount} raw → ${derived.manifest.afterRecordCount} deduped).`,
    );
  }

  const manifest: PromotionManifest = {
    schemaVersion: '1',
    manifestId: spec.manifestId ?? spec.promotionId,
    promotionId: spec.promotionId,
    mode: 'dry-run',
    status,
    repoDir,
    createdAt: now,
    provisional: spec.provisional,
    final: spec.final,
    disclosure: spec.disclosure,
    files: plannedFiles.map((file) => file.manifest),
    conservation: {
      evalIdsBefore,
      evalIdsAfter,
      evalIdsConserved: sameStringMultiset(evalIdsBefore, evalIdsAfter),
      totalRecordsBefore,
      totalRecordsAfter,
      totalFieldChanges,
      oldReferencesBefore,
      oldReferencesAfter,
      finalReferencesBefore,
      finalReferencesAfter,
    },
    normalizedCost,
    lineage: {
      catalogPath: catalogPath ? relative(repoDir, catalogPath) : undefined,
      provisionalSuccessor: spec.final.alias,
      finalPredecessor: spec.provisional.alias,
    },
    derivedCorpora: derivedCorpora.map((entry) => entry.manifest),
    diagnostics,
    manifestPath: promotionManifestPath(repoDir, spec),
  };

  return { manifest, files: plannedFiles, derivedCorpora };
}

function rebuildPlanFromManifest(
  options: ApplyPromotionOptions,
  manifest: PromotionManifest,
): PromotionPlan {
  const fresh = buildPromotionPlan(options);
  const expectedFiles = manifest.files.filter((file) => file.fieldChanges > 0);
  for (const expected of expectedFiles) {
    const actual = fresh.manifest.files.find((file) => file.relativePath === expected.relativePath);
    if (!actual || actual.beforeHash !== expected.beforeHash || actual.afterHash !== expected.afterHash) {
      throw new Error(`Supplied manifest no longer matches ${expected.relativePath}`);
    }
  }
  return fresh;
}

function validateIdentityInputs(spec: ModelTransitionSpec): void {
  if (spec.provisional.alias === spec.final.alias) {
    throw new Error('Provisional and final aliases must differ');
  }
  if (spec.provisional.providerNativeId && spec.provisional.providerNativeId === spec.final.providerNativeId) {
    throw new Error('Provisional and final providerNativeId values must differ');
  }
  const expected = computeIdentityFingerprint({
    alias: spec.final.alias,
    providerNativeId: spec.final.providerNativeId,
    provider: spec.final.provider,
    revision: spec.final.identityRevision,
  });
  if (spec.final.capabilities?.identity?.fingerprint && spec.final.capabilities.identity.fingerprint !== expected) {
    throw new Error('Final capabilities identity fingerprint does not match transition spec');
  }
}

function validatePreflight(
  spec: ModelTransitionSpec,
  repoDir: string,
  catalogPath: string | undefined,
  plannedFiles: PlannedFile[],
  counts: {
    oldReferencesBefore: number;
    oldReferencesAfter: number;
    finalReferencesBefore: number;
    finalReferencesAfter: number;
    evalIdsBefore: string[];
    evalIdsAfter: string[];
  },
): void {
  if (counts.oldReferencesBefore > 0 && counts.finalReferencesBefore > 0) {
    throw new Error('Refusing promotion with both provisional and final structured references present');
  }
  if (counts.oldReferencesAfter !== 0) {
    throw new Error(`Refusing promotion with ${counts.oldReferencesAfter} provisional references remaining after transform`);
  }
  if (!sameStringMultiset(counts.evalIdsBefore, counts.evalIdsAfter)) {
    throw new Error('Eval ID conservation failed');
  }
  if (spec.expected?.minimumOldReferences !== undefined && counts.oldReferencesBefore < spec.expected.minimumOldReferences) {
    throw new Error(`Old reference count ${counts.oldReferencesBefore} is below expected minimum ${spec.expected.minimumOldReferences}`);
  }
  if (spec.expected?.maximumOldReferences !== undefined && counts.oldReferencesBefore > spec.expected.maximumOldReferences) {
    throw new Error(`Old reference count ${counts.oldReferencesBefore} is above expected maximum ${spec.expected.maximumOldReferences}`);
  }
  if (catalogPath) {
    validateCertificationIfNeeded(spec, repoDir, plannedFiles);
  }
}

function validateCertificationIfNeeded(
  spec: ModelTransitionSpec,
  repoDir: string,
  plannedFiles: PlannedFile[],
): void {
  const catalogFile = plannedFiles.find((file) => file.manifest.kind === 'catalog');
  if (!catalogFile) {
    return;
  }
  const catalog = JSON.parse(catalogFile.content) as ModelRegistryCatalog;
  const registry = projectModelRegistryCatalog(catalog);
  const finalCapabilities = registry.models[spec.final.alias];
  if (!finalCapabilities?.nativeCapability || finalCapabilities.nativeCapability.readOnlyNative !== 'certified') {
    return;
  }
  const suiteVersion = finalCapabilities.supportedModel?.certificationSuiteVersion
    ?? finalCapabilities.nativeCapability.certification?.certificationSuiteVersion;
  if (!suiteVersion) {
    throw new Error('Final native model requires certificationSuiteVersion');
  }
  const requiredPhase = highestRequiredPhase(finalCapabilities.supportedModel?.requiredCertificationPhaseByStage)
    ?? finalCapabilities.nativeCapability.certification?.maxCertifiedPhase
    ?? 'read-only';
  const subject = resolveCertificationSubject({
    provider: finalCapabilities.nativeCapability.nativeProvider,
    model: spec.final.alias,
    registry,
  }).subject;
  const certs = discoverCertificationFiles(repoDir);
  for (const certPath of certs) {
    const result = readCertification(certPath);
    if (!result.ok || !isRevisionAwareArtifact(result.artifact)) {
      continue;
    }
    if (
      result.artifact.schemaVersion === CERTIFICATION_SCHEMA_VERSION
      && result.artifact.suiteVersion === suiteVersion
      && phaseSatisfies(result.artifact.phase, requiredPhase)
      && subjectsEqual(result.artifact.subject, subject)
    ) {
      return;
    }
  }
  throw new Error(`Missing revision-aware native certification for final model ${spec.final.alias}`);
}

function highestRequiredPhase(
  phases: Partial<Record<string, CertificationPhase>> | undefined,
): CertificationPhase | undefined {
  if (!phases) return undefined;
  let highest: CertificationPhase | undefined;
  for (const phase of Object.values(phases)) {
    if (!highest || phaseSatisfies(phase, highest)) {
      highest = phase;
    }
  }
  return highest;
}

function transformCatalogFile(path: string, spec: ModelTransitionSpec, now: string): TransformedData {
  const catalog = loadModelRegistryCatalog(path);
  const beforeFinalRefs = countReferences([catalog], spec, 'final');
  const provisional = catalog.models.find((entry) => entry.id === spec.provisional.alias);
  if (!provisional) {
    if (catalog.models.some((entry) => entry.id === spec.final.alias)) {
      return {
        value: catalog,
        fieldChanges: 0,
        oldReferencesBefore: 0,
        finalReferencesBefore: beforeFinalRefs,
        finalReferencesAfter: beforeFinalRefs,
        normalizedCost: emptyNormalizedCostCounts(),
        evalIds: [],
      };
    }
    throw new Error(`Catalog does not contain provisional model ${spec.provisional.alias}`);
  }
  if (catalog.models.some((entry) => entry.id === spec.final.alias)) {
    // Already-applied detection must precede the provisional-shape checks:
    // the applied catalog has flipped the source identity to verified.
    if (provisional.capabilities.identity?.lineage?.successor === spec.final.alias) {
      return {
        value: catalog,
        fieldChanges: 0,
        oldReferencesBefore: 0,
        finalReferencesBefore: beforeFinalRefs,
        finalReferencesAfter: beforeFinalRefs,
        normalizedCost: emptyNormalizedCostCounts(),
        evalIds: [],
      };
    }
    throw new Error(`Catalog already contains final model ${spec.final.alias}`);
  }
  if (provisional.capabilities.identity?.status !== 'provisional') {
    throw new Error(`Catalog source ${spec.provisional.alias} must have identity.status=provisional`);
  }
  if (provisional.capabilities.identity.revision !== spec.provisional.identityRevision) {
    throw new Error(`Catalog source ${spec.provisional.alias} identity revision mismatch`);
  }
  if (provisional.capabilities.identity.evidencePolicy !== 'held') {
    throw new Error(`Catalog source ${spec.provisional.alias} must keep evidencePolicy=held`);
  }
  const finalEntry = buildFinalCatalogEntry(provisional.capabilities, spec, now);
  provisional.capabilities.identity = {
    ...provisional.capabilities.identity,
    // Disclosure verifies what the stealth identity was: the historical entry
    // becomes a verified member of the final family (registry invariants
    // forbid a provisional identity from declaring a successor), while its
    // evidence stays held and its alias/wire-id/fingerprint stay untouched.
    status: 'verified',
    family: spec.final.family as NonNullable<ModelCapabilities['identity']>['family'],
    verification: { ...spec.final.verification },
    lineage: {
      ...(provisional.capabilities.identity.lineage ?? {}),
      successor: spec.final.alias,
      disclosedAt: spec.disclosure.disclosedAt,
      disclosureSource: spec.disclosure.source,
    },
  };
  provisional.capabilities.supportedModel = {
    ...(provisional.capabilities.supportedModel ?? {}),
    routingEligible: false,
    launchEligible: false,
    lifecycle: 'deprecated',
  };
  catalog.models.push(finalEntry);
  catalog.openrouterMappings = updateOpenRouterMappings(catalog.openrouterMappings, spec);
  return {
    value: catalog,
    fieldChanges: 1,
    oldReferencesBefore: 0,
    finalReferencesBefore: beforeFinalRefs,
    finalReferencesAfter: countReferences([catalog], spec, 'final'),
    normalizedCost: emptyNormalizedCostCounts(),
    evalIds: [],
  };
}

function buildFinalCatalogEntry(
  source: ModelCapabilities,
  spec: ModelTransitionSpec,
  now: string,
): ModelRegistryCatalog['models'][number] {
  const pricing = spec.final.pricing;
  const overrides = spec.final.capabilities ?? {};
  const supportedModel = {
    ...(source.supportedModel ?? {}),
    ...(overrides.supportedModel ?? {}),
    wavemillAlias: spec.final.alias,
    providerNativeId: spec.final.providerNativeId,
    provider: spec.final.provider as NonNullable<ModelCapabilities['supportedModel']>['provider'],
    routingEligible: overrides.supportedModel?.routingEligible ?? true,
    launchEligible: overrides.supportedModel?.launchEligible ?? true,
    lifecycle: overrides.supportedModel?.lifecycle ?? 'supported',
  };
  const nativeCapability = source.nativeCapability || overrides.nativeCapability
    ? {
      ...(source.nativeCapability ?? {}),
      ...(overrides.nativeCapability ?? {}),
      nativeProvider: spec.final.provider as NonNullable<ModelCapabilities['nativeCapability']>['nativeProvider'],
    }
    : undefined;

  return {
    id: spec.final.alias,
    capabilities: {
      ...source,
      ...overrides,
      vendor: overrides.vendor ?? source.vendor,
      strengths: overrides.strengths ? [...overrides.strengths] : [...source.strengths],
      weaknesses: overrides.weaknesses ? [...overrides.weaknesses] : source.weaknesses.filter((item) => !/provisional|pending disclosure/i.test(item)),
      pricing,
      costPerMillionInputTokensUsd: pricing.inputCostPerMTok,
      costPerMillionOutputTokensUsd: pricing.outputCostPerMTok,
      defaultLadderEligible: overrides.defaultLadderEligible ?? false,
      supportedModel,
      nativeCapability,
      identity: {
        status: 'verified',
        revision: spec.final.identityRevision,
        fingerprint: computeIdentityFingerprint({
          alias: spec.final.alias,
          providerNativeId: spec.final.providerNativeId,
          provider: spec.final.provider,
          revision: spec.final.identityRevision,
        }),
        displayName: spec.final.displayName,
        family: spec.final.family as NonNullable<ModelCapabilities['identity']>['family'],
        evidencePolicy: overrides.identity?.evidencePolicy ?? 'held',
        verification: { ...spec.final.verification },
        lineage: {
          predecessors: [
            ...new Set([
              ...((overrides.identity?.lineage?.predecessors) ?? []),
              spec.provisional.alias,
            ]),
          ],
          formerIds: [
            ...new Set([
              ...((overrides.identity?.lineage?.formerIds) ?? []),
              spec.provisional.providerNativeId ?? spec.provisional.alias,
            ]),
          ],
          disclosedAt: spec.disclosure.disclosedAt || now,
          disclosureSource: spec.disclosure.source,
        },
      },
    },
  };
}

function updateOpenRouterMappings(openrouterMappings: unknown[] | undefined, spec: ModelTransitionSpec): unknown[] | undefined {
  if (!openrouterMappings) return openrouterMappings;
  const cloned = JSON.parse(JSON.stringify(openrouterMappings)) as unknown[];
  for (const row of cloned) {
    if (!row || typeof row !== 'object') continue;
    const mapping = row as Record<string, unknown>;
    // The historical mapping row stays resolvable but must read as terminal:
    // coverage/watchlist tooling excludes deprecated rows from follow-ups.
    if (mapping.wavemillAlias === spec.provisional.alias) {
      mapping.status = 'deprecated';
    }
  }
  cloned.push({
    wavemillAlias: spec.final.alias,
    openrouterId: spec.final.providerNativeId,
    family: spec.final.family,
    status: 'active',
    priorityTier: 3,
    roleEligibility: ['planning', 'coding', 'review'],
  });
  return cloned;
}

function transformRecords(records: unknown[], spec: ModelTransitionSpec, now: string): TransformedData {
  const beforeOld = countReferences(records, spec, 'old');
  const beforeFinal = countReferences(records, spec, 'final');
  const normalizedCost = emptyNormalizedCostCounts();
  let fieldChanges = 0;
  const transformed = records.map((record) => {
    const recordResult = transformValue(record, spec);
    fieldChanges += recordResult.changed;
    const maybeEval = recordResult.value as Partial<EvalRecord>;
    if (isEvalRecordShape(maybeEval)) {
      const evalResult = finalizeEvalRecord(maybeEval as EvalRecord, spec, now);
      if (evalResult.changed) {
        fieldChanges += 1;
      }
      addNormalizedCostCounts(normalizedCost, evalResult.normalizedCost);
      return evalResult.record;
    }
    return recordResult.value;
  });
  return {
    value: transformed,
    fieldChanges,
    oldReferencesBefore: beforeOld,
    finalReferencesBefore: beforeFinal,
    finalReferencesAfter: countReferences(transformed, spec, 'final'),
    normalizedCost,
    evalIds: extractEvalIds(transformed),
  };
}

function finalizeEvalRecord(
  record: EvalRecord,
  spec: ModelTransitionSpec,
  now: string,
): {
  record: EvalRecord;
  changed: boolean;
  normalizedCost: PromotionManifest['normalizedCost'];
} {
  const normalizedCost = emptyNormalizedCostCounts();
  const cloned = record;
  let changed = false;
  const roles = cloned.modelIdentityAttribution?.roles ?? {};
  for (const [role, observation] of Object.entries(roles) as Array<[RoutingRole, NonNullable<typeof roles[RoutingRole]>]>) {
    const matchesPromotedObservation = observation
      && (
        observation.alias === spec.provisional.alias
        || (observation.alias === spec.final.alias && observation.identityStatus === 'provisional')
      );
    if (!matchesPromotedObservation) {
      continue;
    }
    observation.alias = spec.final.alias;
    observation.providerId = spec.final.providerNativeId;
    observation.identityStatus = 'verified';
    observation.identityRevision = spec.final.identityRevision;
    observation.fingerprint = computeIdentityFingerprint({
      alias: spec.final.alias,
      providerNativeId: spec.final.providerNativeId,
      provider: spec.final.provider,
      revision: spec.final.identityRevision,
    });
    observation.evidencePolicy = 'held';
    changed = true;
  }
  if (cloned.modelIdentityAttribution && changed) {
    cloned.modelIdentityAttribution.finalization = {
      promotedAt: now,
      manifestId: spec.manifestId ?? spec.promotionId,
      fromRevision: spec.provisional.identityRevision,
      toRevision: spec.final.identityRevision,
      observedAlias: spec.provisional.alias,
      finalAlias: spec.final.alias,
    };
    cloned.modelIdentityAttribution.provisionalRoles = cloned.modelIdentityAttribution.provisionalRoles
      .filter((role) => roles[role]?.alias !== spec.final.alias);
    cloned.modelIdentityAttribution.candidateOnlyProvisional = cloned.modelIdentityAttribution.candidateOnlyProvisional
      .filter((modelId) => modelId !== spec.provisional.alias);
    cloned.eligibilityErrors = [
      ...new Set([
        ...(cloned.eligibilityErrors ?? []),
        'provisional_model_identity',
      ]),
    ];
    cloned.trainingEligible = false;
    cloned.budgetEvalEligible = false;
    cloned.nonRewardReason ??= {
      code: 'provisional_model_identity',
      message: 'Promotion finalizes catalog identity but historical evidence remains held until re-qualified.',
    };
  }

  for (const [modelId, usage] of Object.entries(cloned.workflowTokenUsage ?? {})) {
    if (modelId !== spec.final.alias && modelId !== spec.provisional.alias) {
      continue;
    }
    const normalized = computeNormalizedEvaluationCost(usage, spec.final.pricing, {
      requireExplicitCache: true,
      pricingRevision: spec.final.pricingRevision ?? spec.promotionId,
    });
    if (normalized.coverage === 'complete') normalizedCost.complete++;
    if (normalized.coverage === 'missing_token_usage') normalizedCost.missingTokenUsage++;
    if (normalized.coverage === 'missing_cache_usage') normalizedCost.missingCacheUsage++;
    if (normalized.coverage === 'missing_cache_pricing') normalizedCost.missingCachePricing++;
    if (!normalizedCostAlreadyMatches(cloned.normalizedEvaluationCost, normalized)) {
      cloned.normalizedEvaluationCost = {
        ...normalized,
        computedAt: now,
      };
      changed = true;
    }
    break;
  }

  return { record: cloned, changed, normalizedCost };
}

function normalizedCostAlreadyMatches(
  existing: EvalRecord['normalizedEvaluationCost'] | undefined,
  computed: ReturnType<typeof computeNormalizedEvaluationCost>,
): boolean {
  if (!existing) return false;
  const existingSansComputedAt = { ...existing } as Record<string, unknown>;
  delete existingSansComputedAt.computedAt;
  return JSON.stringify(existingSansComputedAt) === JSON.stringify(computed);
}

function transformValue(value: unknown, spec: ModelTransitionSpec, parentKey?: string): { value: unknown; changed: number } {
  if (Array.isArray(value)) {
    let changed = 0;
    const next = value.map((item) => {
      const result = transformValue(item, spec, parentKey);
      changed += result.changed;
      return result.value;
    });
    return { value: next, changed };
  }
  if (!value || typeof value !== 'object') {
    return { value, changed: 0 };
  }
  const record = value as Record<string, unknown>;
  let changed = 0;
  for (const [key, fieldValue] of Object.entries(record)) {
    let effectiveKey = key;
    if (MODEL_MAP_KEYS.has(parentKey ?? '') && key === spec.provisional.alias) {
      effectiveKey = spec.final.alias;
      record[effectiveKey] = fieldValue;
      delete record[key];
      changed++;
    }
    if (typeof fieldValue === 'string') {
      if (MODEL_ID_KEYS.has(effectiveKey) && fieldValue === spec.provisional.alias) {
        record[effectiveKey] = spec.final.alias;
        changed++;
        continue;
      }
      if (PROVIDER_ID_KEYS.has(effectiveKey) && spec.provisional.providerNativeId && fieldValue === spec.provisional.providerNativeId) {
        record[effectiveKey] = spec.final.providerNativeId;
        changed++;
        continue;
      }
    }
    if (Array.isArray(fieldValue) && MODEL_ARRAY_KEYS.has(effectiveKey)) {
      const next = fieldValue.map((item) => item === spec.provisional.alias ? spec.final.alias : item);
      const delta = next.filter((item, index) => item !== fieldValue[index]).length;
      if (delta > 0) {
        record[effectiveKey] = next;
        changed += delta;
      }
      continue;
    }
    const nested = transformValue(record[effectiveKey], spec, effectiveKey);
    if (nested.changed > 0) {
      record[effectiveKey] = nested.value;
      changed += nested.changed;
    }
  }
  return { value: record, changed };
}

function countReferences(records: unknown[], spec: ModelTransitionSpec, target: 'old' | 'final'): number {
  const alias = target === 'old' ? spec.provisional.alias : spec.final.alias;
  const providerNativeId = target === 'old' ? spec.provisional.providerNativeId : spec.final.providerNativeId;
  let count = 0;
  function visit(value: unknown, key?: string): void {
    if (typeof value === 'string') {
      if (MODEL_ID_KEYS.has(key ?? '') && value === alias) count++;
      if (providerNativeId && PROVIDER_ID_KEYS.has(key ?? '') && value === providerNativeId) count++;
      return;
    }
    if (Array.isArray(value)) {
      if (MODEL_ARRAY_KEYS.has(key ?? '')) {
        count += value.filter((item) => item === alias).length;
      }
      for (const item of value) visit(item);
      return;
    }
    if (value && typeof value === 'object') {
      for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
        if (MODEL_MAP_KEYS.has(key ?? '') && childKey === alias) count++;
        visit(childValue, childKey);
      }
    }
  }
  for (const record of records) visit(record);
  return count;
}

function parseStrictJson(path: string, content: string): unknown {
  try {
    return JSON.parse(content);
  } catch (error) {
    throw new Error(`Malformed JSON in ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseStrictJsonl(path: string, content: string): ParsedJsonl {
  const records: unknown[] = [];
  const lines = content.split('\n');
  let lineCount = 0;
  // Some writers emit pretty-printed JSON documents back to back instead of
  // one document per line, so accumulate lines until the buffer parses. A
  // single-line record parses immediately, keeping strict JSONL strict.
  let buffer = '';
  let bufferStartLine = 0;
  for (const line of lines) {
    if (line.length === 0 && line === lines[lines.length - 1]) {
      continue;
    }
    if (buffer.length === 0 && line.trim().length === 0) {
      continue;
    }
    lineCount++;
    if (buffer.length === 0) {
      bufferStartLine = lineCount;
    }
    buffer = buffer.length === 0 ? line : `${buffer}\n${line}`;
    try {
      records.push(JSON.parse(buffer));
      buffer = '';
    } catch {
      // Keep accumulating; leftover content at the end is malformed.
    }
  }
  if (buffer.length > 0) {
    throw new Error(`Malformed JSONL in ${path} line ${bufferStartLine}: unparseable record`);
  }
  return { records, lineCount };
}

function serializeJsonl(records: unknown[]): string {
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
}

function discoverPromotionFiles(repoDir: string, catalogPath?: string): string[] {
  const files: string[] = [];
  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const childDir = join(dir, entry.name);
        // Never cross into a nested repository (e.g. worktrees checked out
        // under the main repo): those files belong to other branches.
        if (!SKIP_DIRS.has(entry.name) && entry.name !== 'model-promotions' && !existsSync(join(childDir, '.git'))) {
          walk(childDir);
        }
        continue;
      }
      if (!entry.isFile()) continue;
      const path = join(dir, entry.name);
      if (path.includes(`${sep}.wavemill${sep}model-promotions${sep}`)) continue;
      if (path.endsWith('.backup') || path.includes('.promotion-tmp-')) continue;
      if (DERIVED_CORPUS_BASENAMES.has(entry.name)) continue;
      if (path.endsWith('.json') || path.endsWith('.jsonl')) {
        files.push(path);
      }
    }
  }
  walk(repoDir);
  const normalized = new Set(files.map((file) => resolve(file)));
  if (catalogPath) normalized.add(resolve(catalogPath));
  return [...normalized].sort();
}

function discoverDerivedCorpusFiles(repoDir: string): string[] {
  const evalsDir = join(repoDir, '.wavemill', 'evals');
  if (!existsSync(evalsDir)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(evalsDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (DERIVED_CORPUS_BASENAMES.has(entry.name)) {
      files.push(resolve(join(evalsDir, entry.name)));
    }
  }
  return files.sort();
}

function planDerivedCorpora(
  repoDir: string,
  spec: ModelTransitionSpec,
  rawEvalsPlan: PlannedFile | undefined,
): PlannedDerivedCorpus[] {
  const derived = discoverDerivedCorpusFiles(repoDir);
  if (derived.length === 0) return [];
  if (!rawEvalsPlan) {
    throw new Error(
      `Derived eval corpora exist at ${derived.map((path) => relative(repoDir, path)).join(', ')}`
      + ` but ${RAW_EVALS_RELATIVE_PATH} is missing; cannot rebuild without a raw source.`,
    );
  }
  const rawRecords = parseStrictJsonl(rawEvalsPlan.manifest.path, rawEvalsPlan.content).records as EvalRecord[];
  const deduped = deduplicateByHash(rawRecords);
  const rebuiltContent = serializeJsonl(deduped.deduplicatedRecords);
  const rebuiltHash = sha256(rebuiltContent);
  const planned: PlannedDerivedCorpus[] = [];
  for (const path of derived) {
    const beforeContent = readFileSync(path, 'utf-8');
    const beforeHash = sha256(beforeContent);
    const beforeParsed = parseStrictJsonl(path, beforeContent);
    planned.push({
      manifest: {
        path,
        relativePath: relative(repoDir, path),
        sourcePath: rawEvalsPlan.manifest.path,
        beforeHash,
        afterHash: rebuiltHash,
        beforeRecordCount: beforeParsed.records.length,
        afterRecordCount: deduped.uniqueRecords,
        sourceRawRecordCount: deduped.totalRecords,
        duplicatesRemoved: deduped.duplicatesRemoved,
        backupPath: backupPathFor(repoDir, spec, path),
        tempPath: tempPathFor(path, spec),
      },
      content: rebuiltContent,
    });
  }
  return planned;
}

function resolveCatalogPath(repoDir: string, spec: ModelTransitionSpec): string | undefined {
  const candidates = [
    spec.catalogPath,
    'shared/fixtures/model-registry.v1.json',
    '.wavemill/model-registry.v1.json',
    'model-registry.v1.json',
  ].filter(Boolean) as string[];
  for (const candidate of candidates) {
    const path = isAbsolute(candidate) ? candidate : join(repoDir, candidate);
    if (existsSync(path)) {
      return resolve(path);
    }
  }
  return undefined;
}

function discoverCertificationFiles(repoDir: string): string[] {
  const base = join(repoDir, '.wavemill', 'native-agent-certifications');
  if (!existsSync(base)) return [];
  const files: string[] = [];
  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.isFile() && entry.name.endsWith('.json')) {
        files.push(path);
      }
    }
  }
  walk(base);
  return files;
}

function refuseAcceptedHokusaiRows(path: string, records: unknown[], spec: ModelTransitionSpec): void {
  if (!HOKUSAI_NAME.test(path)) {
    return;
  }
  for (const record of records) {
    if (
      countReferences([record], spec, 'old') > 0
      && containsAcceptedStatus(record)
    ) {
      throw new Error(`Refusing already-accepted Hokusai row in ${path}`);
    }
  }
}

function containsAcceptedStatus(value: unknown): boolean {
  if (typeof value === 'string') {
    return value === 'accepted';
  }
  if (Array.isArray(value)) {
    return value.some(containsAcceptedStatus);
  }
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some(containsAcceptedStatus);
  }
  return false;
}

function isEvalRecordShape(value: Partial<EvalRecord>): value is EvalRecord {
  return typeof value.id === 'string'
    && typeof value.schemaVersion === 'string'
    && typeof value.modelId === 'string';
}

function extractEvalIds(records: unknown[]): string[] {
  return records
    .filter((record): record is { id: string; schemaVersion?: string } =>
      !!record && typeof record === 'object' && typeof (record as { id?: unknown }).id === 'string'
      && typeof (record as { schemaVersion?: unknown }).schemaVersion === 'string')
    .map((record) => record.id);
}

function sameStringMultiset(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((value, index) => value === b[index]);
}

function emptyNormalizedCostCounts(): PromotionManifest['normalizedCost'] {
  return {
    complete: 0,
    missingTokenUsage: 0,
    missingCacheUsage: 0,
    missingCachePricing: 0,
  };
}

function addNormalizedCostCounts(
  target: PromotionManifest['normalizedCost'],
  source: PromotionManifest['normalizedCost'],
): void {
  target.complete += source.complete;
  target.missingTokenUsage += source.missingTokenUsage;
  target.missingCacheUsage += source.missingCacheUsage;
  target.missingCachePricing += source.missingCachePricing;
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function promotionDir(repoDir: string, spec: ModelTransitionSpec): string {
  return join(repoDir, '.wavemill', 'model-promotions', spec.promotionId);
}

function promotionManifestPath(repoDir: string, spec: ModelTransitionSpec): string {
  return join(promotionDir(repoDir, spec), `${spec.manifestId ?? spec.promotionId}.manifest.json`);
}

function activationManifestPath(repoDir: string, spec: ModelTransitionSpec): string {
  return join(promotionDir(repoDir, spec), `${spec.manifestId ?? spec.promotionId}.activation.manifest.json`);
}

function backupPathFor(repoDir: string, spec: ModelTransitionSpec, filePath: string): string {
  const rel = relative(repoDir, filePath);
  return join(promotionDir(repoDir, spec), 'backups', rel);
}

function tempPathFor(path: string, spec: ModelTransitionSpec): string {
  // The basename keeps staged temp files distinct when several planned files
  // share a directory; a promotion-id-only name would clobber earlier stages.
  return join(dirname(path), `.${basename(path)}.${spec.promotionId}.${process.pid}.promotion-tmp`);
}

function cleanupTemps(files: PlannedFile[]): void {
  for (const file of files) {
    if (file.manifest.tempPath && existsSync(file.manifest.tempPath)) {
      unlinkSync(file.manifest.tempPath);
    }
  }
}

function isAlreadyApplied(spec: ModelTransitionSpec, repoDir: string): boolean {
  const plan = buildPromotionPlan({ spec, repoDir });
  return plan.manifest.status === 'already_applied';
}
