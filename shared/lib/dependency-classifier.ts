import { callLLM } from './llm-cli.ts';
import { fillPromptTemplate, loadPromptTemplate } from './prompt-utils.ts';
import { resolveWavemillPromptPath } from './native-agent/install-paths.ts';

export interface IssueContext {
  id: string;
  title: string;
  summary?: string;
  labels?: string[];
}

export interface AuthoritativeEdge {
  from: string;
  to: string;
  type: 'blocks' | 'blocked_by';
  source: 'linear';
}

export interface InferredEdge {
  from: string;
  to: string;
  type: 'blocks' | 'blocked_by' | 'shared_surface';
  confidence: number;
  rationale?: string;
  source: 'inferred';
}

export type ClassifierEdge = AuthoritativeEdge | InferredEdge;

export interface Triage {
  id: string;
  risk?: 'low' | 'medium' | 'high';
  complexity?: 'low' | 'medium' | 'high';
  notes?: string;
}

export interface ClassifierInput {
  issues: IssueContext[];
  authoritativeEdges: AuthoritativeEdge[];
  confidenceThreshold?: number;
  modelsAvailable?: string[];
}

export interface ClassifierOutput {
  edges: ClassifierEdge[];
  triage: Triage[];
}

export interface ClassifierOptions {
  cliCmd?: string;
  templatePath?: string;
  repoDir?: string;
}

const FORBIDDEN_FIELDS = new Set(['waves', 'queues', 'order', 'schedule', 'sequence']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function parseStrictClassifierJson(raw: string): { edges: unknown[]; triage: unknown[] } {
  if (raw.startsWith('\uFEFF')) {
    throw new Error('Classifier output contains UTF-8 BOM');
  }
  const trimmed = raw.trim();
  if (trimmed.startsWith('```')) {
    throw new Error('Classifier output contains markdown fence');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Classifier output is not valid JSON: ${message}`);
  }

  if (!isRecord(parsed)) {
    throw new Error('Classifier output must be a JSON object');
  }

  const keys = Object.keys(parsed).sort();
  if (keys.length !== 2 || keys[0] !== 'edges' || keys[1] !== 'triage') {
    const forbidden = keys.find((key) => FORBIDDEN_FIELDS.has(key));
    if (forbidden) {
      throw new Error(`Classifier output contains forbidden ordering field: ${forbidden}`);
    }
    throw new Error('Classifier output must contain exactly: edges, triage');
  }

  const edges = parsed.edges;
  const triage = parsed.triage;

  if (!Array.isArray(edges) || !Array.isArray(triage)) {
    throw new Error('Classifier output fields edges and triage must be arrays');
  }

  return { edges, triage };
}

export function validateNoDriftFields(parsed: unknown): void {
  const scanObject = (value: unknown): void => {
    if (!isRecord(value)) return;

    for (const key of Object.keys(value)) {
      if (FORBIDDEN_FIELDS.has(key)) {
        throw new Error(`Classifier output contains forbidden ordering field: ${key}`);
      }
    }
  };

  if (!isRecord(parsed)) return;
  scanObject(parsed);

  const maybeEdges = parsed.edges;
  const maybeTriage = parsed.triage;

  if (Array.isArray(maybeEdges)) {
    for (const edge of maybeEdges) {
      scanObject(edge);
    }
  }

  if (Array.isArray(maybeTriage)) {
    for (const triage of maybeTriage) {
      scanObject(triage);
    }
  }
}

export function filterInvalidIdEdges(edges: ClassifierEdge[], validIds: Set<string>): ClassifierEdge[] {
  return edges.filter((edge) => validIds.has(edge.from) && validIds.has(edge.to));
}

export function filterLowConfidenceEdges(edges: ClassifierEdge[], threshold: number): ClassifierEdge[] {
  return edges.filter((edge) => {
    if (edge.source !== 'inferred') {
      return true;
    }
    return edge.confidence >= threshold;
  });
}

function edgeConfidence(edge: ClassifierEdge): number {
  return edge.source === 'inferred' ? edge.confidence : Number.POSITIVE_INFINITY;
}

export function dedupEdges(edges: ClassifierEdge[]): ClassifierEdge[] {
  const deduped = new Map<string, ClassifierEdge>();

  for (const edge of edges) {
    const key = `${edge.from}|${edge.to}|${edge.type}`;
    const existing = deduped.get(key);
    if (!existing) {
      deduped.set(key, edge);
      continue;
    }

    if (existing.source === 'linear' && edge.source === 'inferred') {
      continue;
    }
    if (existing.source === 'inferred' && edge.source === 'linear') {
      deduped.set(key, edge);
      continue;
    }

    if (edgeConfidence(edge) > edgeConfidence(existing)) {
      deduped.set(key, edge);
    }
  }

  return [...deduped.values()];
}

export function mergeEdges(authoritative: AuthoritativeEdge[], inferred: ClassifierEdge[]): ClassifierEdge[] {
  return dedupEdges([...authoritative, ...inferred]);
}

function toClassifierEdge(edge: unknown): ClassifierEdge | null {
  if (!isRecord(edge)) return null;
  if (typeof edge.from !== 'string' || typeof edge.to !== 'string' || typeof edge.type !== 'string') {
    return null;
  }

  if (edge.source === 'linear' && (edge.type === 'blocks' || edge.type === 'blocked_by')) {
    return {
      from: edge.from,
      to: edge.to,
      type: edge.type,
      source: 'linear',
    };
  }

  if (
    edge.source === 'inferred' &&
    (edge.type === 'blocks' || edge.type === 'blocked_by' || edge.type === 'shared_surface') &&
    typeof edge.confidence === 'number' &&
    Number.isFinite(edge.confidence)
  ) {
    return {
      from: edge.from,
      to: edge.to,
      type: edge.type,
      confidence: edge.confidence,
      rationale: typeof edge.rationale === 'string' ? edge.rationale : undefined,
      source: 'inferred',
    };
  }

  return null;
}

function toTriage(entry: unknown): Triage | null {
  if (!isRecord(entry) || typeof entry.id !== 'string') return null;

  const triage: Triage = { id: entry.id };
  if (entry.risk === 'low' || entry.risk === 'medium' || entry.risk === 'high') {
    triage.risk = entry.risk;
  }
  if (entry.complexity === 'low' || entry.complexity === 'medium' || entry.complexity === 'high') {
    triage.complexity = entry.complexity;
  }
  if (typeof entry.notes === 'string') {
    triage.notes = entry.notes;
  }

  return triage;
}

export async function classifyDependencies(
  input: ClassifierInput,
  options: ClassifierOptions = {}
): Promise<ClassifierOutput> {
  const threshold = input.confidenceThreshold ?? 0.7;
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new RangeError('confidenceThreshold must be between 0 and 1');
  }

  if (input.modelsAvailable?.length === 0) {
    throw new Error('No models available for dependency classification');
  }

  const templatePath = options.templatePath ?? resolveWavemillPromptPath('dependency-classifier.md');
  const template = await loadPromptTemplate(templatePath);
  const renderedPrompt = fillPromptTemplate(template, {
    ISSUES: JSON.stringify(input.issues),
    AUTHORITATIVE_EDGES: JSON.stringify(input.authoritativeEdges),
    CONFIDENCE_THRESHOLD: String(threshold),
  });

  const result = await callLLM(renderedPrompt, {
    taskType: 'classify',
    ...(options.cliCmd ? { cliCmd: options.cliCmd } : {}),
    ...(options.repoDir ? { repoDir: options.repoDir } : {}),
  });

  const parsed = parseStrictClassifierJson(result.text);
  validateNoDriftFields(parsed);

  const validIdSet = new Set(input.issues.map((issue) => issue.id));

  const parsedEdges = parsed.edges.map(toClassifierEdge).filter((edge): edge is ClassifierEdge => edge !== null);
  const validIdEdges = filterInvalidIdEdges(parsedEdges, validIdSet);
  const confidenceFiltered = filterLowConfidenceEdges(validIdEdges, threshold);
  const mergedEdges = mergeEdges(input.authoritativeEdges, dedupEdges(confidenceFiltered));

  const triage = parsed.triage
    .map(toTriage)
    .filter((entry): entry is Triage => entry !== null && validIdSet.has(entry.id));

  return {
    edges: mergedEdges,
    triage,
  };
}
