import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ResourceRef } from '../resource-registry.ts';
import { logPromptUsage } from '../prompt-registry.ts';
import { registerNativeRuntime } from '../resource-adapters/native-runtime-adapter.ts';
import { recordUse } from '../resource-manifest.ts';
import type { ToolMetadata, ToolPhase } from './tools/types.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const NATIVE_PHASE_PROMPT_PATH = resolve(__dirname, '../../../tools/prompts/native-read-only-phase.md');

const FALLBACK_NATIVE_PROMPT = [
  'You are a read-only native planning agent.',
  'Investigate the codebase using read-only tools and produce an implementation plan.',
  'Do not modify any files.',
].join('\n');

const TOOL_CATALOG_PLACEHOLDER = '{{TOOL_CATALOG}}';
const PHASE_ROLE_PLACEHOLDER = '{{PHASE_ROLE}}';
const PHASE_OBJECTIVE_PLACEHOLDER = '{{PHASE_OBJECTIVE}}';
const PHASE_OUTPUT_PLACEHOLDER = '{{PHASE_OUTPUT}}';

/**
 * Per-phase prose for the shared native read-only template.
 *
 * This template is the system prompt for native planning, review, and the
 * read-only smoke. Without per-phase text every phase inherited the planning
 * wording, so a review agent was told to produce an implementation plan.
 */
interface PhaseProfile {
  role: string;
  objective: string;
  output: string;
}

const DEFAULT_PHASE_PROFILE: PhaseProfile = {
  role: 'read-only native agent',
  objective: 'investigate the codebase and complete the task described in your instructions',
  output: [
    'Produce a clear, structured response that covers:',
    '- The evidence you gathered and where it came from',
    '- Your conclusions and their rationale',
    '- Open questions, risks, and edge cases',
  ].join('\n'),
};

const PHASE_PROFILES: Readonly<Record<ToolPhase, PhaseProfile>> = {
  planning: {
    role: 'read-only native planning agent',
    objective:
      'investigate the codebase, understand the task requirements, and produce a detailed implementation plan',
    output: [
      'Produce a clear, structured implementation plan that covers:',
      '- Files to modify and the nature of each change',
      '- Architectural decisions and their rationale',
      '- Dependencies, risks, and edge cases',
      '- Concrete step-by-step implementation approach',
    ].join('\n'),
  },
  coding: {
    role: 'native coding agent',
    objective: 'implement the approved plan within the worktree',
    output: [
      'Produce the code changes the plan calls for, and report:',
      '- Which files you changed and why',
      '- How you verified the change',
      '- Anything the plan called for that you did not do, and why',
    ].join('\n'),
  },
  review: {
    role: 'read-only native review agent',
    objective:
      'investigate the changes under review, verify them against the stated requirements, and report what you find',
    output: [
      'Produce a clear, structured review that covers:',
      '- Correctness problems, each tied to specific evidence in the diff',
      '- Whether the change satisfies its stated requirements',
      '- Risks, edge cases, and missing test coverage',
      'Follow the response format required by your review instructions.',
    ].join('\n'),
  },
};

/**
 * Catalog text used when a caller does not supply registry metadata. It stays
 * true regardless of which tools are registered, so an un-wired call site
 * degrades to a vague-but-accurate statement rather than a stale hardcoded list.
 */
const TOOL_CATALOG_FALLBACK =
  "Your available tools are supplied in this session's tool schemas. Use only those.";

/**
 * First sentence of a tool description, for the compact prompt catalog. Full
 * descriptions already reach the model through the tool schemas, so repeating
 * them verbatim in the system prompt would only cost tokens.
 */
function firstSentence(description: string): string {
  const trimmed = description.trim();
  const match = /^([\s\S]*?[.!?])(?:\s|$)/.exec(trimmed);
  return (match ? match[1] : trimmed).trim();
}

/**
 * Render the phase tool catalog from registry metadata.
 *
 * Pass the result of `registry.list({ phase })` so the prompt can never drift
 * from the tools the phase actually exposes.
 */
export function renderToolCatalog(tools: readonly ToolMetadata[]): string {
  if (tools.length === 0) {
    return '- (no tools are registered for this phase)';
  }
  return tools
    .map((tool) => `- \`${tool.name}\` (${tool.class}) — ${firstSentence(tool.description)}`)
    .join('\n');
}

export interface NativePhasePromptOptions {
  /** Registry metadata for the phase, from `registry.list({ phase })`. */
  tools?: readonly ToolMetadata[];
  /** Phase this prompt is rendered for; selects the agent role line. */
  phase?: ToolPhase;
}

/**
 * Substitute the phase role and tool catalog into a native phase template.
 * Templates without the placeholders pass through unchanged.
 */
export function renderNativePhasePrompt(
  template: string,
  options: NativePhasePromptOptions = {},
): string {
  const profile = (options.phase && PHASE_PROFILES[options.phase]) || DEFAULT_PHASE_PROFILE;
  const catalog = options.tools ? renderToolCatalog(options.tools) : TOOL_CATALOG_FALLBACK;
  return template
    .split(PHASE_ROLE_PLACEHOLDER)
    .join(profile.role)
    .split(PHASE_OBJECTIVE_PLACEHOLDER)
    .join(profile.objective)
    .split(PHASE_OUTPUT_PLACEHOLDER)
    .join(profile.output)
    .split(TOOL_CATALOG_PLACEHOLDER)
    .join(catalog);
}

export function loadNativePhasePrompt(
  repoDir?: string,
  options: NativePhasePromptOptions = {},
): {
  content: string;
  promptRef: ResourceRef | null;
} {
  let template = FALLBACK_NATIVE_PROMPT;

  try {
    if (existsSync(NATIVE_PHASE_PROMPT_PATH)) {
      template = readFileSync(NATIVE_PHASE_PROMPT_PATH, 'utf-8');
    }
  } catch (err) {
    console.warn(`[native-prompts] Failed to read native phase prompt template: ${(err as Error).message}`);
  }

  // Log the unrendered template so the prompt hash tracks the template version
  // rather than the per-phase tool list rendered into it.
  const promptRef = logPromptUsage(NATIVE_PHASE_PROMPT_PATH, template, { repoDir });
  return { content: renderNativePhasePrompt(template, options), promptRef };
}

export function registerAndRecordNativeProvenance(options: {
  sessionId: string;
  phase: string;
  provider: string;
  model: string;
  api: string;
  tools: readonly { name: string; class: string }[];
  promptRef: ResourceRef | null | undefined;
  repoDir?: string;
}): void {
  try {
    const refs = registerNativeRuntime({
      phase: options.phase,
      provider: options.provider,
      model: options.model,
      api: options.api,
      tools: options.tools,
      promptRef: options.promptRef,
      repoDir: options.repoDir,
    });
    if (refs.runtime) recordUse(options.sessionId, options.phase, refs.runtime, options.repoDir);
    if (refs.toolSet) recordUse(options.sessionId, options.phase, refs.toolSet, options.repoDir);
  } catch (err) {
    console.warn(`[native-prompts] Failed to record native provenance: ${(err as Error).message}`);
  }
}
