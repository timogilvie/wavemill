import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { callHeadlessLLM, HEADLESS_DEFAULT_MODEL, type HeadlessLLMOptions, type LLMCallResult } from './headless-llm.ts';
import {
  compileSchemaValidator,
  loadPrecompiledValidator,
  schemaSourceText,
  type SchemaValidatorFunction,
} from './schema-validators.ts';
import type { IncidentFilingReconciliation } from './incident-filing-reconciler.ts';
import type { IncidentRecord } from './wavemill-incident-model.ts';
import type { ObserverLinearConfig } from './incident-to-linear-synchronizer.ts';
import { redactEvidence, redactLinearIssueContent } from './incident-to-linear-synchronizer.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_PATH = resolve(__dirname, '..', '..', 'skills', 'root-cause-issue', 'SKILL.md');
const INVESTIGATION_SCHEMA_PATH = resolve(__dirname, '..', 'schemas', 'investigation-payload.schema.json');

let cachedSkillText: string | undefined;
function loadSkillText(): string {
  if (cachedSkillText === undefined) {
    cachedSkillText = readFileSync(SKILL_PATH, 'utf-8');
  }
  return cachedSkillText;
}

let cachedValidator: SchemaValidatorFunction | null | undefined;
function getValidator(): SchemaValidatorFunction {
  if (cachedValidator !== undefined) return cachedValidator;
  const schemaText = readFileSync(INVESTIGATION_SCHEMA_PATH, 'utf-8');
  cachedValidator = loadPrecompiledValidator('investigation-payload', schemaText, { allErrors: true, strict: false })
    ?? compileSchemaValidator(JSON.parse(schemaText), { allErrors: true, strict: false });
  return cachedValidator;
}

export interface InvestigationPayload {
  readonly incidentFingerprint: string;
  readonly mode: 'append_to_owner' | 'new_consolidation' | 'draft';
  readonly targetIssueId?: string;
  readonly title: string;
  readonly sections: {
    readonly why: string;
    readonly change: string;
    readonly notInScope: string;
    readonly acceptance: string;
  };
  readonly primitivesTable?: string;
  readonly fixturePointer?: string;
  readonly missingEvidence?: readonly string[];
  readonly modelId: string;
  readonly provider: 'claude' | 'codex' | 'native-openrouter' | 'native-openai';
  readonly generatedAt: string;
}

export interface InvestigationOutcome {
  readonly incident: IncidentRecord;
  readonly payload: InvestigationPayload | null;
  readonly reconciliation: IncidentFilingReconciliation;
  readonly state: 'pending' | 'draft' | 'ready' | 'exhausted' | 'skipped';
  readonly reason?: string;
}

function incidentDir(repoDir: string, fingerprint: string): string {
  return join(repoDir, '.wavemill', 'incidents', fingerprint);
}

function investigationPath(repoDir: string, fingerprint: string, revision: string): string {
  return join(incidentDir(repoDir, fingerprint), `investigation-${revision}.json`);
}

function draftPath(repoDir: string, fingerprint: string): string {
  return join(incidentDir(repoDir, fingerprint), 'draft.json');
}

function ensureDir(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

function readJsonFile<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function evidenceRevision(incident: IncidentRecord): string {
  // Matches the evidence revision used by the synchronizer: fingerprint + occurrenceCount + evidence hashes.
  const evidenceHash = incident.evidence
    .map((item) => `${item.type}:${item.source}:${item.timestamp}:${item.redactedData}`)
    .join('\0');
  return `${incident.fingerprint}:${incident.occurrenceCount}:${evidenceHash.length}`;
}

function buildInvestigationPrompt(incident: IncidentRecord, reconciliation: IncidentFilingReconciliation): string {
  return [
    'You are investigating a confirmed Wavemill incident for root cause and escalation.',
    '',
    'Incident fingerprint:',
    incident.fingerprint,
    '',
    'Category:',
    incident.category,
    '',
    'Root cause class:',
    incident.rootCauseClass,
    '',
    'Severity / confidence:',
    `${incident.severity} / ${incident.confidence}`,
    '',
    'Summary:',
    incident.summary,
    '',
    'Operator action note:',
    incident.operatorAction,
    '',
    'Occurrences:',
    String(incident.occurrenceCount),
    '',
    'Reconciliation (HOK-3324):',
    JSON.stringify(reconciliation, null, 2),
    '',
    'Known owner issue ids:',
    ...(Array.isArray(incident.metadata?.knownIssueIds) ? incident.metadata.knownIssueIds as string[] : ['none']),
    '',
    'Evidence (last 12 items):',
    ...incident.evidence.slice(-12).map((item) => (
      `- [${item.type}] ${item.source}:${item.lineNumber ?? ''} ${item.timestamp}\n${item.redactedData}`
    )),
    '',
    'Instructions:',
    '1. Decide whether to append evidence to an existing owner issue (mode: append_to_owner) or create one consolidated root-cause issue (mode: new_consolidation).',
    '2. For append_to_owner, set targetIssueId to the Linear issue identifier.',
    '3. For new_consolidation, produce a short title starting with "One " and four sections: why, change, notInScope, acceptance.',
    '4. If evidence is insufficient, respond with mode: draft and list missingEvidence.',
    '5. Output ONLY valid JSON matching the InvestigationPayload schema. No markdown, no preamble.',
  ].join('\n');
}

function parseModelResponse(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed.startsWith('```')) {
    const content = trimmed.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/, '');
    return JSON.parse(content);
  }
  return JSON.parse(trimmed);
}

function validatePayload(candidate: unknown): { ok: true; payload: InvestigationPayload } | { ok: false; errors: string[] } {
  const validate = getValidator();
  if (validate(candidate)) {
    const payload = candidate as InvestigationPayload;
    if (payload.mode === 'draft' && (!payload.missingEvidence || payload.missingEvidence.length === 0)) {
      return { ok: false, errors: ['draft mode requires missingEvidence'] };
    }
    if (payload.mode === 'append_to_owner' && !payload.targetIssueId) {
      return { ok: false, errors: ['append_to_owner requires targetIssueId'] };
    }
    return { ok: true, payload };
  }
  const errors = (validate.errors ?? []).map((e) => `${e.instancePath || '/'}: ${e.message}`);
  return { ok: false, errors };
}

export interface InvestigateConfirmedIncidentOptions {
  incident: IncidentRecord;
  repoDir: string;
  reconciliation: IncidentFilingReconciliation;
  runInvestigation?: (prompt: string, opts: HeadlessLLMOptions) => Promise<LLMCallResult>;
  now?: Date;
}

export async function investigateConfirmedIncident(
  opts: InvestigateConfirmedIncidentOptions,
): Promise<InvestigationOutcome> {
  const now = opts.now ?? new Date();
  const incident = opts.incident;
  const reconciliation = opts.reconciliation;
  const repoDir = opts.repoDir;

  if (reconciliation.outcome !== 'confirmed_active') {
    return {
      incident,
      payload: null,
      reconciliation,
      state: 'skipped',
      reason: `reconciliation: ${reconciliation.outcome}`,
    };
  }

  const revision = evidenceRevision(incident);
  const artefactPath = investigationPath(repoDir, incident.fingerprint, revision);
  const existing = readJsonFile<InvestigationPayload>(artefactPath);
  if (existing && existing.incidentFingerprint === incident.fingerprint) {
    return {
      incident,
      payload: existing,
      reconciliation,
      state: existing.mode === 'draft' ? 'draft' : 'ready',
      reason: 'reused stored investigation artefact',
    };
  }

  const runner = opts.runInvestigation ?? callHeadlessLLM;
  const prompt = buildInvestigationPrompt(incident, reconciliation);
  const result = await runner(prompt, {
    systemInstruction: loadSkillText(),
    noTools: true,
    model: HEADLESS_DEFAULT_MODEL,
    repoDir,
  });

  if (!result.ok || typeof result.output !== 'string' || result.output.trim() === '') {
    const draft: InvestigationPayload = {
      incidentFingerprint: incident.fingerprint,
      mode: 'draft',
      title: 'Draft: investigation failed',
      sections: { why: '', change: '', notInScope: '', acceptance: '' },
      missingEvidence: ['model_call_failed'],
      modelId: result.modelId ?? HEADLESS_DEFAULT_MODEL,
      provider: result.provider ?? 'claude',
      generatedAt: now.toISOString(),
    };
    ensureDir(artefactPath);
    writeFileSync(artefactPath, JSON.stringify(draft, null, 2));
    return { incident, payload: draft, reconciliation, state: 'draft', reason: 'model call failed' };
  }

  let parsed: unknown;
  try {
    parsed = parseModelResponse(result.output);
  } catch {
    const draft: InvestigationPayload = {
      incidentFingerprint: incident.fingerprint,
      mode: 'draft',
      title: 'Draft: malformed model output',
      sections: { why: '', change: '', notInScope: '', acceptance: '' },
      missingEvidence: ['model_output_malformed'],
      modelId: result.modelId ?? HEADLESS_DEFAULT_MODEL,
      provider: result.provider ?? 'claude',
      generatedAt: now.toISOString(),
    };
    ensureDir(artefactPath);
    writeFileSync(artefactPath, JSON.stringify(draft, null, 2));
    return { incident, payload: draft, reconciliation, state: 'draft', reason: 'model output malformed' };
  }

  const validated = validatePayload(parsed);
  if (!validated.ok) {
    const draft: InvestigationPayload = {
      incidentFingerprint: incident.fingerprint,
      mode: 'draft',
      title: 'Draft: payload validation failed',
      sections: { why: '', change: '', notInScope: '', acceptance: '' },
      missingEvidence: ['payload_validation_failed', ...validated.errors],
      modelId: result.modelId ?? HEADLESS_DEFAULT_MODEL,
      provider: result.provider ?? 'claude',
      generatedAt: now.toISOString(),
    };
    ensureDir(artefactPath);
    writeFileSync(artefactPath, JSON.stringify(draft, null, 2));
    return { incident, payload: draft, reconciliation, state: 'draft', reason: `payload validation: ${validated.errors.join('; ')}` };
  }

  const payload = validated.payload;
  ensureDir(artefactPath);
  writeFileSync(artefactPath, JSON.stringify(payload, null, 2));
  return {
    incident,
    payload,
    reconciliation,
    state: payload.mode === 'draft' ? 'draft' : 'ready',
    reason: payload.mode === 'draft' ? 'model returned draft' : undefined,
  };
}

export function preparePayloadForTransport(
  outcome: InvestigationOutcome,
):
  | { kind: 'skip'; reason: string }
  | { kind: 'draft'; draftPath: string }
  | { kind: 'transport'; body: string; title: string; targetIssueId?: string } {
  if (outcome.reconciliation.outcome !== 'confirmed_active') {
    return { kind: 'skip', reason: `reconciliation: ${outcome.reconciliation.outcome}` };
  }
  if (!outcome.payload) {
    return { kind: 'skip', reason: 'investigation_pending' };
  }
  if (outcome.payload.mode === 'draft') {
    const path = draftPath(outcome.incident.metadata?.repoDir ?? process.cwd(), outcome.incident.fingerprint);
    ensureDir(path);
    writeFileSync(path, JSON.stringify(outcome.payload, null, 2));
    return { kind: 'draft', draftPath: path };
  }
  return {
    kind: 'transport',
    title: outcome.payload.title,
    body: renderInvestigatedIssueBody(outcome.incident, outcome.payload),
    ...(outcome.payload.mode === 'append_to_owner' ? { targetIssueId: outcome.payload.targetIssueId } : {}),
  };
}

export function renderInvestigatedIssueBody(incident: IncidentRecord, payload: InvestigationPayload): string {
  if (payload.mode === 'draft') {
    throw new Error('renderInvestigatedIssueBody refuses to render a draft payload');
  }
  const sections = [
    '## Why',
    payload.sections.why,
    '',
    '## Change',
    payload.sections.change,
    '',
    '## Not in scope',
    payload.sections.notInScope,
    '',
    '## Acceptance',
    payload.sections.acceptance,
  ];
  if (payload.primitivesTable) {
    sections.push('', '## Primitives reused', payload.primitivesTable);
  }
  sections.push(
    '',
    '---',
    `**Incident fingerprint**: ${incident.fingerprint}`,
    `**Investigated at**: ${payload.generatedAt}`,
    `**Model**: ${payload.modelId} (${payload.provider})`,
  );
  return sections.join('\n');
}

export function renderInvestigatedCommentBody(
  incident: IncidentRecord,
  payload: InvestigationPayload,
  config: ObserverLinearConfig,
  evidenceRevision: string,
  now: Date,
): string {
  if (payload.mode !== 'append_to_owner') {
    throw new Error('renderInvestigatedCommentBody only renders append_to_owner payloads');
  }
  const evidence = redactEvidence(incident.evidence, config.redaction).slice(-8);
  return redactLinearIssueContent([
    `## Wavemill Root-Cause Evidence Update`,
    `- **Fingerprint**: ${incident.fingerprint}`,
    `- **Root Cause**: ${incident.rootCauseClass}`,
    `- **Severity/Confidence**: ${incident.severity}/${incident.confidence}`,
    `- **Occurrences**: ${incident.occurrenceCount}`,
    `- **Evidence revision**: ${evidenceRevision}`,
    `- **Investigated at**: ${payload.generatedAt}`,
    `- **Model**: ${payload.modelId} (${payload.provider})`,
    '',
    '## New Evidence',
    ...evidence.map((item) => `- ${item.type}: ${item.source} [${item.timestamp}] ${item.redactedData}`),
    '',
    `Synced at: ${now.toISOString()}`,
  ].join('\n'), config.redaction);
}
