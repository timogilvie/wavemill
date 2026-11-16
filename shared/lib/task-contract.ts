/**
 * Task Contract Builder
 *
 * Produces a deterministic, machine-readable task-contract.json projection
 * from existing task packet and plan artifacts. Never throws on missing or
 * malformed source files — absent fields are recorded explicitly.
 *
 * @module task-contract
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { extractReleaseReadiness, type ReleaseReadinessField } from './task-packet-utils.ts';

export const TASK_CONTRACT_SCHEMA_VERSION = '1.0.0';

// ── Types ──────────────────────────────────────────────────────────────────

/**
 * Wrapper for an extracted field that makes missing values explicit.
 * When present is false, value and source are null.
 */
export interface TaskContractField<T> {
  present: boolean;
  value: T | null;
  source: string | null;
  missingReason?: string;
}

/** A success criterion with a stable ID. */
export interface SuccessCriterion {
  /** Stable ID preserved from [REQ-FX] tags or synthesized as SC-001, SC-002. */
  id: string;
  text: string;
  checked: boolean;
}

/** A source artifact entry with its hash. */
export interface TaskContractSource {
  /** Feature-dir-relative path using /. */
  path: string;
  exists: boolean;
  /** Lowercase hex SHA-256 of raw file bytes, null when missing or unreadable. */
  sha256: string | null;
}

/** Release-readiness fields as individual wrapped values. */
export interface ReleaseReadinessProjection {
  databaseChangeRisk: TaskContractField<'none' | 'possible' | 'required'>;
  envChanges: TaskContractField<string[]>;
  configChanges: TaskContractField<string[]>;
  manualSteps: TaskContractField<string[]>;
}

/** All extractable structured fields. */
export interface TaskContractFields {
  objectiveSummary: TaskContractField<string>;
  taskType: TaskContractField<string>;
  subsystems: TaskContractField<string[]>;
  componentLabels: TaskContractField<string[]>;
  riskLevel: TaskContractField<string>;
  riskReasons: TaskContractField<string[]>;
  allowedPaths: TaskContractField<string[]>;
  expectedPaths: TaskContractField<string[]>;
  outOfScope: TaskContractField<string[]>;
  successCriteria: TaskContractField<SuccessCriterion[]>;
  verificationCommands: TaskContractField<string[]>;
  verificationScenarios: TaskContractField<string[]>;
  releaseReadiness: ReleaseReadinessProjection;
}

/** Summary of route artifact data for routing hints. */
export interface RouteArtifactSummary {
  initial: Record<string, unknown> | null;
  postExpansion: Record<string, unknown> | null;
}

/** Routing-relevant hints derived from extracted fields and route artifacts. */
export interface RoutingHints {
  taskType: string | null;
  riskLevel: string | null;
  riskFlags: string[];
  subsystems: string[];
  expectedFileTypes: string[];
  hasMigration: boolean;
  hasUi: boolean;
  requiresTests: boolean;
  routeArtifacts: RouteArtifactSummary | null;
}

/** The full task contract artifact. */
export interface TaskContract {
  schemaVersion: string;
  issueId: string | null;
  /** Always derived (from selected-task.json, override, or directory basename). */
  slug: string;
  sources: TaskContractSource[];
  fields: TaskContractFields;
  routingHints: RoutingHints;
  warnings: string[];
}

/** Options for building a task contract. */
export interface BuildTaskContractOptions {
  /** Absolute path to the feature directory. */
  featureDir: string;
  /** Optional slug override (derived from dir basename or selected-task.json if absent). */
  slug?: string;
}

/** Result of building a task contract. */
export interface BuildTaskContractResult {
  contract: TaskContract;
  warnings: string[];
}

// ── Internal Types ─────────────────────────────────────────────────────────

interface SourceText {
  path: string;
  text: string;
}

// ── Constants ──────────────────────────────────────────────────────────────

const CANDIDATE_SOURCE_PATHS = [
  'selected-task.json',
  'task-packet.md',
  'task-packet-header.md',
  'task-packet-details.md',
  'plan.md',
  '.initial-route.json',
  '.post-expansion-route.json',
] as const;

// ── Source Loading ─────────────────────────────────────────────────────────

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function loadSourceEntry(featureDir: string, sourcePath: string): TaskContractSource {
  const absPath = join(featureDir, sourcePath);
  try {
    if (!existsSync(absPath)) {
      return { path: sourcePath, exists: false, sha256: null };
    }
    const bytes = readFileSync(absPath);
    return { path: sourcePath, exists: true, sha256: sha256Hex(bytes) };
  } catch {
    return { path: sourcePath, exists: false, sha256: null };
  }
}

function loadSources(featureDir: string): TaskContractSource[] {
  return CANDIDATE_SOURCE_PATHS.map(p => loadSourceEntry(featureDir, p));
}

function readText(featureDir: string, sourcePath: string): string | null {
  const absPath = join(featureDir, sourcePath);
  try {
    if (!existsSync(absPath)) return null;
    const text = readFileSync(absPath, 'utf-8');
    return text.trim().length > 0 ? text : null;
  } catch {
    return null;
  }
}

// Load all candidate text files upfront
function loadAllTexts(featureDir: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const p of CANDIDATE_SOURCE_PATHS) {
    const text = readText(featureDir, p);
    if (text !== null) map.set(p, text);
  }
  return map;
}

// ── ID/Slug Resolution ─────────────────────────────────────────────────────

function resolveIdAndSlug(
  texts: Map<string, string>,
  featureDir: string,
  slugOverride?: string,
): { issueId: string | null; slug: string } {
  const selectedTaskText = texts.get('selected-task.json');
  if (selectedTaskText) {
    try {
      const parsed = JSON.parse(selectedTaskText) as Record<string, unknown>;
      const issueId = typeof parsed.taskId === 'string' && parsed.taskId ? parsed.taskId : null;
      const slug = slugOverride
        ?? (typeof parsed.featureName === 'string' && parsed.featureName ? parsed.featureName : null)
        ?? basename(featureDir);
      return { issueId, slug };
    } catch {
      // fall through
    }
  }

  return { issueId: null, slug: slugOverride ?? basename(featureDir) };
}

// ── Markdown Extraction Helpers ────────────────────────────────────────────

/**
 * Extract the content of a section identified by headingRegex.
 * Content extends from after the matched heading to before the next heading
 * at the same or higher level (fewer/equal # characters).
 */
function extractSection(markdown: string, headingRegex: RegExp): string | null {
  const match = headingRegex.exec(markdown);
  if (!match) return null;

  const levelMatch = match[0].match(/^(#+)/);
  const headingLevel = levelMatch ? levelMatch[1].length : 2;
  const sectionStart = match.index + match[0].length;
  const rest = markdown.substring(sectionStart);

  // Stop at next heading with same or fewer # characters
  const stopRegex = new RegExp(`^#{1,${headingLevel}}\\s`, 'm');
  const stopMatch = stopRegex.exec(rest);
  const raw = stopMatch ? rest.substring(0, stopMatch.index) : rest;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Extract list items from a text block, returning item text without leading markers. */
function extractListItems(text: string): string[] {
  const items: string[] = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*[-*+]\s+(.+)|^\s*\d+\.\s+(.+)/);
    if (m) {
      const itemText = (m[1] ?? m[2]).trim();
      if (itemText) items.push(itemText);
    }
  }
  return items;
}

/** Extract fenced code block contents from a text block. */
function extractFencedCodeBlocks(text: string): string[] {
  const blocks: string[] = [];
  const fenceRe = /^```[^\n]*\n([\s\S]*?)^```/gm;
  let match: RegExpExecArray | null;
  while ((match = fenceRe.exec(text)) !== null) {
    const content = match[1].trim();
    if (content) blocks.push(content);
  }
  return blocks;
}

/**
 * Extract shell-like commands from text.
 * Collects non-comment lines from fenced code blocks, plus inline backtick
 * spans that start with common CLI prefixes.
 */
function extractCommands(text: string): string[] {
  const commands: string[] = [];
  const seen = new Set<string>();

  for (const block of extractFencedCodeBlocks(text)) {
    for (const line of block.split('\n')) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#') && !seen.has(trimmed)) {
        seen.add(trimmed);
        commands.push(trimmed);
      }
    }
  }

  // Inline backtick commands
  const cliPrefixes = /^(npx|node|npm|bash|sh|tsx|pnpm|yarn|curl|gh)\s/;
  const backtickRe = /`([^`]+)`/g;
  let m: RegExpExecArray | null;
  while ((m = backtickRe.exec(text)) !== null) {
    const inner = m[1].trim();
    if (cliPrefixes.test(inner) && !seen.has(inner)) {
      seen.add(inner);
      commands.push(inner);
    }
  }

  return commands;
}

/**
 * Parse success criteria checklist items.
 * Preserves explicit [REQ-FX] IDs; synthesizes SC-001, SC-002, etc. for unnamed
 * items. The synthesized counter advances only across unnamed items, so SC-001
 * is always the first unnamed criterion regardless of position relative to
 * explicitly-tagged items.
 */
function parseSuccessCriteria(text: string): SuccessCriterion[] {
  const criteria: SuccessCriterion[] = [];
  let unnamedCounter = 1;

  for (const line of text.split('\n')) {
    const m = line.match(/^\s*[-*]\s+\[([ xX])\]\s*(.+)/);
    if (!m) continue;

    const checked = m[1].toLowerCase() === 'x';
    const rawText = m[2].trim();

    // Match [REQ-F1] or **[REQ-F1]** (bold-wrapped) at the start of the item text
    const idMatch = rawText.match(/^\*{0,2}\[([A-Z]+-[A-Z0-9]+)\]\*{0,2}\s*/);
    let id: string;
    let criterionText: string;

    if (idMatch) {
      id = idMatch[1];
      criterionText = rawText.substring(idMatch[0].length).trim();
    } else {
      id = `SC-${String(unnamedCounter).padStart(3, '0')}`;
      criterionText = rawText;
      unnamedCounter++;
    }

    criteria.push({ id, text: criterionText, checked });
  }

  return criteria;
}

// ── Field Wrapper Constructors ─────────────────────────────────────────────

function absent<T>(missingReason?: string): TaskContractField<T> {
  if (missingReason) {
    return { present: false, value: null, source: null, missingReason };
  }
  return { present: false, value: null, source: null };
}

function present<T>(value: T, source: string): TaskContractField<T> {
  return { present: true, value, source };
}

// ── Section-Aware Field Extractors ─────────────────────────────────────────

function extractObjectiveSummary(sources: SourceText[]): TaskContractField<string> {
  for (const { path, text } of sources) {
    // Try "## Objective", "## 1. Objective", or header-style
    let sectionText = extractSection(text, /^#{2,3}\s+(?:\d+\.\s+)?Objective\s*$/im);
    if (sectionText) {
      // Look for "### What" sub-section first
      const whatText = extractSection(sectionText, /^###\s+What\s*$/im);
      const raw = (whatText ?? sectionText).trim();
      // Take first non-empty paragraph
      const firstPara = raw.split(/\n{2,}/)[0]?.trim();
      if (firstPara && firstPara.length > 5) {
        return present(firstPara, path);
      }
    }
  }
  return absent('no Objective section found');
}

function extractTaskType(
  sources: SourceText[],
  selectedTaskText: string | undefined,
): TaskContractField<string> {
  // Prefer workflowType from selected-task.json
  if (selectedTaskText) {
    try {
      const parsed = JSON.parse(selectedTaskText) as Record<string, unknown>;
      if (typeof parsed.workflowType === 'string' && parsed.workflowType) {
        return present(parsed.workflowType, 'selected-task.json');
      }
    } catch {
      // ignore
    }
  }

  // Try route artifact signals
  for (const routePath of ['.post-expansion-route.json', '.initial-route.json']) {
    const src = sources.find(s => s.path === routePath);
    if (src) {
      try {
        const parsed = JSON.parse(src.text) as Record<string, unknown>;
        const signals = parsed.signals as Record<string, unknown> | undefined;
        if (signals && typeof signals.taskType === 'string' && signals.taskType) {
          return present(signals.taskType, routePath);
        }
      } catch {
        // ignore
      }
    }
  }

  // Infer from markdown text
  const taskTypeSources = sources.filter(s => s.path.endsWith('.md'));
  for (const { path, text } of taskTypeSources) {
    const m = text.match(/\*\*(?:task\s+)?type\*\*:\s*(\w+)/i)
      ?? text.match(/\bworkflow[_\s]+type\s*:\s*(\w+)/i);
    if (m) {
      return present(m[1].toLowerCase(), path);
    }
  }

  return absent('task type not found in selected-task.json, route artifacts, or packet');
}

function extractSubsystems(sources: SourceText[]): TaskContractField<string[]> {
  for (const { path, text } of sources) {
    const sectionText = extractSection(text, /^#{2,4}\s+Subsystems?\s*$/im);
    if (sectionText) {
      const items = extractListItems(sectionText);
      if (items.length > 0) return present(items, path);
    }
  }
  return absent('no Subsystems section found');
}

function extractComponentLabels(selectedTaskText: string | undefined): TaskContractField<string[]> {
  if (!selectedTaskText) return absent('selected-task.json not found');
  try {
    const parsed = JSON.parse(selectedTaskText) as Record<string, unknown>;
    if (Array.isArray(parsed.labels)) {
      const labels = (parsed.labels as unknown[]).filter((l): l is string => typeof l === 'string');
      // Always return present even if labels is empty — the field exists
      return present(labels, 'selected-task.json');
    }
  } catch {
    // ignore
  }
  return absent('labels field not found in selected-task.json');
}

function extractRiskLevelAndReasons(sources: SourceText[]): {
  level: TaskContractField<string>;
  reasons: TaskContractField<string[]>;
} {
  for (const { path, text } of sources) {
    // Try dedicated Risk section
    const riskText = extractSection(text, /^#{2,4}\s+(?:Risk|Risks?|Risk\s+Level)\s*$/im);
    if (riskText) {
      const levelMatch = riskText.match(/\b(Critical|High|Medium|Low|None)\b/i);
      const level = levelMatch ? levelMatch[1] : null;
      const items = extractListItems(riskText);

      return {
        level: level ? present(level, path) : absent('no risk level keyword in Risk section'),
        reasons: items.length > 0 ? present(items, path) : absent('no risk reason list in Risk section'),
      };
    }

    // Try inline "Risk: Medium" or "**Risk**: Medium" patterns
    const inlineMatch = text.match(/\*\*[Rr]isk(?:\s+[Ll]evel)?\*\*:\s*(\w+)|^[Rr]isk(?:\s+[Ll]evel)?:\s*(\w+)/m);
    if (inlineMatch) {
      const level = (inlineMatch[1] ?? inlineMatch[2]).trim();
      return {
        level: present(level, path),
        reasons: absent('no risk reasons found'),
      };
    }
  }

  return {
    level: absent('no risk level found'),
    reasons: absent('no risk reasons found'),
  };
}

function extractAllowedPaths(sources: SourceText[]): TaskContractField<string[]> {
  for (const { path, text } of sources) {
    const filesToModifyText = extractSection(text, /^#{2,4}\s+(?:\d+\.\s+)?Files\s+to\s+Modify\s*$/im);
    if (filesToModifyText) {
      const items = extractListItems(filesToModifyText);
      if (items.length > 0) return present(items, `${path}#Files to Modify`);
    }
  }

  for (const { path, text } of sources) {
    const sectionText = extractSection(text, /^#{2,4}\s+Scope\s+In\s*$/im);
    if (sectionText) {
      const items = extractListItems(sectionText);
      if (items.length > 0) return present(items, path);
    }
  }
  return absent('no Scope In section found');
}

function extractOutOfScope(sources: SourceText[]): TaskContractField<string[]> {
  for (const { path, text } of sources) {
    const sectionText = extractSection(text, /^#{2,4}\s+(?:Scope\s+Out|Out[\s-]of[\s-]Scope|Non-?[Gg]oals?)\s*$/im);
    if (sectionText) {
      const items = extractListItems(sectionText);
      if (items.length > 0) return present(items, path);
    }
  }
  return absent('no Scope Out or Non-goals section found');
}

function extractSuccessCriteria(sources: SourceText[]): TaskContractField<SuccessCriterion[]> {
  for (const { path, text } of sources) {
    // Try "## 4. Success Criteria", "## Success Criteria", or sub-sections
    const sectionText = extractSection(text, /^#{2,3}\s+(?:\d+\.\s+)?Success\s+Criteria\s*$/im);
    if (sectionText) {
      // Also check for "### Functional Requirements" sub-section
      const funcText = extractSection(sectionText, /^###\s+Functional\s+Requirements?\s*$/im);
      const criteriaText = funcText ?? sectionText;
      const criteria = parseSuccessCriteria(criteriaText);
      if (criteria.length > 0) return present(criteria, path);
    }

    // Try a "### Functional Requirements" section directly
    const funcText = extractSection(text, /^###\s+Functional\s+Requirements?\s*$/im);
    if (funcText) {
      const criteria = parseSuccessCriteria(funcText);
      if (criteria.length > 0) return present(criteria, path);
    }
  }
  return absent('no Success Criteria checklist items found');
}

function extractVerificationItems(sources: SourceText[]): {
  commands: TaskContractField<string[]>;
  scenarios: TaskContractField<string[]>;
} {
  for (const { path, text } of sources) {
    // Try "## 6. Validation Steps", "## Validation Steps", "## Final Verification"
    const sectionText = extractSection(
      text,
      /^#{2,3}\s+(?:\d+\.\s+)?(?:Validation\s+Steps?|Final\s+Verification)\s*$/im,
    );
    if (!sectionText) continue;

    const commands = extractCommands(sectionText);
    const allItems = extractListItems(sectionText);
    // Scenarios = prose list items (not CLI commands)
    const cliPrefixRe = /^(npx|node|npm|bash|sh|tsx|pnpm|yarn|curl|gh)\s/;
    const scenarios = allItems.filter(item => !cliPrefixRe.test(item) && item.length > 5);

    const commandField: TaskContractField<string[]> = commands.length > 0
      ? present(commands, path)
      : absent('no verification commands found in section');
    const scenarioField: TaskContractField<string[]> = scenarios.length > 0
      ? present(scenarios, path)
      : absent('no verification scenarios found in section');

    // Return as soon as we find a section that yields at least one field; an
    // empty section falls through so later source files can supply content.
    if (commands.length > 0 || scenarios.length > 0) {
      return { commands: commandField, scenarios: scenarioField };
    }
  }

  return {
    commands: absent('no Validation Steps or Final Verification section found'),
    scenarios: absent('no Validation Steps or Final Verification section found'),
  };
}

function extractReleaseReadinessProjection(
  sources: SourceText[],
): ReleaseReadinessProjection {
  // Try each source file with the single HOK-3499 Release Readiness parser.
  for (const { path, text } of sources) {
    const readiness = extractReleaseReadiness(text);
    if (!readiness) continue;

    // A required field the section does not declare is absent, not a default.
    const missing = new Set<string>(readiness.missingFields);
    const project = <T>(field: ReleaseReadinessField, value: T): TaskContractField<T> => (
      missing.has(field)
        ? absent<T>(`${field} not found in Release Readiness`)
        : present(value, path)
    );
    return {
      databaseChangeRisk: readiness.databaseChangeRisk === undefined
        ? absent('database_change_risk not found in Release Readiness')
        : present(readiness.databaseChangeRisk, path),
      envChanges: project('env_changes', readiness.envChanges),
      configChanges: project('config_changes', readiness.configChanges),
      manualSteps: project('manual_steps', readiness.manualSteps),
    };
  }

  const reason = 'no Release Readiness section found';
  return {
    databaseChangeRisk: absent(reason),
    envChanges: absent(reason),
    configChanges: absent(reason),
    manualSteps: absent(reason),
  };
}

// ── Route Artifact Helpers ─────────────────────────────────────────────────

function parseRouteJson(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Extract only non-path, stable fields from a route artifact for the summary. */
function sanitizeRouteArtifact(obj: Record<string, unknown>): Record<string, unknown> | null {
  const safe: Record<string, unknown> = {};
  const safeKeys = ['coder', 'codeDepth', 'reviewer', 'reviewMode', 'planDepth', 'planner', 'routingMode', 'harnessId'] as const;
  for (const key of safeKeys) {
    if (typeof obj[key] === 'string' && obj[key]) safe[key] = obj[key];
  }
  // Include signals sub-object if present and simple
  if (obj.signals && typeof obj.signals === 'object' && !Array.isArray(obj.signals)) {
    safe.signals = obj.signals;
  }
  return Object.keys(safe).length > 0 ? safe : null;
}

function buildRouteArtifactSummary(texts: Map<string, string>): RouteArtifactSummary | null {
  const initialText = texts.get('.initial-route.json');
  const postText = texts.get('.post-expansion-route.json');

  const initialJson = initialText ? parseRouteJson(initialText) : null;
  const postJson = postText ? parseRouteJson(postText) : null;

  if (!initialJson && !postJson) return null;

  return {
    initial: initialJson ? sanitizeRouteArtifact(initialJson) : null,
    postExpansion: postJson ? sanitizeRouteArtifact(postJson) : null,
  };
}

// ── Routing Hints Builder ──────────────────────────────────────────────────

function buildRoutingHints(fields: TaskContractFields, texts: Map<string, string>): RoutingHints {
  const taskType = fields.taskType.present ? fields.taskType.value : null;
  const riskLevel = fields.riskLevel.present ? fields.riskLevel.value : null;
  const riskFlags = fields.riskReasons.present && fields.riskReasons.value
    ? fields.riskReasons.value : [];
  const subsystems = fields.subsystems.present && fields.subsystems.value
    ? fields.subsystems.value : [];

  // Derive expected file types from all text content
  const allText = [
    fields.objectiveSummary.value ?? '',
    ...(fields.successCriteria.value?.map(c => c.text) ?? []),
    ...(fields.verificationCommands.value ?? []),
    ...(fields.allowedPaths.value ?? []),
  ].join(' ');

  const fileTypeChecks: Array<[string, string]> = [
    ['typescript', '.ts'],
    ['tsx', '.tsx'],
    ['javascript', '.js'],
    ['json', '.json'],
    ['shell', '.sh'],
    ['markdown', '.md'],
  ];
  const expectedFileTypes = fileTypeChecks
    .filter(([, ext]) => allText.includes(ext))
    .map(([label]) => label);

  const allTextLower = allText.toLowerCase();
  const hasMigration = allTextLower.includes('migration') || allTextLower.includes('migrate');
  const hasUi = allTextLower.includes(' ui') || allTextLower.includes('frontend')
    || allTextLower.includes('component') || allTextLower.includes('react');
  const requiresTests = allTextLower.includes('test') || allTextLower.includes('spec')
    || fields.verificationCommands.present;

  const routeArtifacts = buildRouteArtifactSummary(texts);

  return {
    taskType,
    riskLevel,
    riskFlags,
    subsystems,
    expectedFileTypes,
    hasMigration,
    hasUi,
    requiresTests,
    routeArtifacts,
  };
}

// ── Warning Collection ─────────────────────────────────────────────────────

function collectWarnings(fields: TaskContractFields): string[] {
  const warnings: string[] = [];

  const checks: Array<[string, { present: boolean; missingReason?: string }]> = [
    ['objectiveSummary', fields.objectiveSummary],
    ['taskType', fields.taskType],
    ['subsystems', fields.subsystems],
    ['componentLabels', fields.componentLabels],
    ['riskLevel', fields.riskLevel],
    ['riskReasons', fields.riskReasons],
    ['allowedPaths', fields.allowedPaths],
    ['outOfScope', fields.outOfScope],
    ['successCriteria', fields.successCriteria],
    ['verificationCommands', fields.verificationCommands],
    ['verificationScenarios', fields.verificationScenarios],
    ['releaseReadiness.databaseChangeRisk', fields.releaseReadiness.databaseChangeRisk],
  ];

  for (const [name, field] of checks) {
    if (!field.present) {
      const detail = field.missingReason ? `: ${field.missingReason}` : '';
      warnings.push(`missing field: ${name}${detail}`);
    }
  }

  return warnings;
}

// ── Deterministic Serialization ────────────────────────────────────────────

function sortKeysDeep(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  const obj = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    result[key] = sortKeysDeep(obj[key]);
  }
  return result;
}

/**
 * Serialize a TaskContract to a deterministic JSON string with trailing newline.
 * Keys are recursively sorted alphabetically. No absolute paths, timestamps,
 * or environment-specific values appear in the output.
 */
export function serializeTaskContract(contract: TaskContract): string {
  return `${JSON.stringify(sortKeysDeep(contract), null, 2)}\n`;
}

// ── Main Builder ───────────────────────────────────────────────────────────

/**
 * Build a TaskContract projection from existing task packet and plan artifacts.
 *
 * Never throws — missing or malformed source files are recorded as absent.
 * Returns the contract and a list of warnings for missing expected fields.
 */
export function buildTaskContract(options: BuildTaskContractOptions): BuildTaskContractResult {
  const { featureDir, slug: slugOverride } = options;

  const sources = loadSources(featureDir);
  const texts = loadAllTexts(featureDir);

  const { issueId, slug } = resolveIdAndSlug(texts, featureDir, slugOverride);

  // Build ordered source list for extraction (priority: details > full > header > plan)
  const orderedMdSources: SourceText[] = [];
  for (const path of ['task-packet-details.md', 'task-packet.md', 'task-packet-header.md', 'plan.md'] as const) {
    const text = texts.get(path);
    if (text) orderedMdSources.push({ path, text });
  }

  const selectedTaskText = texts.get('selected-task.json');

  // Extract fields
  const objectiveSummary = extractObjectiveSummary(orderedMdSources);
  const taskType = extractTaskType(
    [...orderedMdSources, ...buildRouteSourceTexts(texts)],
    selectedTaskText,
  );
  const subsystems = extractSubsystems(orderedMdSources);
  const componentLabels = extractComponentLabels(selectedTaskText);
  const { level: riskLevel, reasons: riskReasons } = extractRiskLevelAndReasons(orderedMdSources);
  const allowedPaths = extractAllowedPaths(orderedMdSources);
  const expectedPaths: TaskContractField<string[]> = absent('expected paths not separately tracked');
  const outOfScope = extractOutOfScope(orderedMdSources);
  const successCriteria = extractSuccessCriteria(orderedMdSources);
  const { commands: verificationCommands, scenarios: verificationScenarios } =
    extractVerificationItems([...orderedMdSources]);
  const releaseReadiness = extractReleaseReadinessProjection(orderedMdSources);

  const fields: TaskContractFields = {
    objectiveSummary,
    taskType,
    subsystems,
    componentLabels,
    riskLevel,
    riskReasons,
    allowedPaths,
    expectedPaths,
    outOfScope,
    successCriteria,
    verificationCommands,
    verificationScenarios,
    releaseReadiness,
  };

  const routingHints = buildRoutingHints(fields, texts);
  const warnings = collectWarnings(fields);

  const contract: TaskContract = {
    schemaVersion: TASK_CONTRACT_SCHEMA_VERSION,
    issueId,
    slug,
    sources,
    fields,
    routingHints,
    warnings,
  };

  return { contract, warnings };
}

function buildRouteSourceTexts(texts: Map<string, string>): SourceText[] {
  const routePaths = ['.post-expansion-route.json', '.initial-route.json'] as const;
  const result: SourceText[] = [];
  for (const path of routePaths) {
    const text = texts.get(path);
    if (text) result.push({ path, text });
  }
  return result;
}
