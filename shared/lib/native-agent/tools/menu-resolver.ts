// ---------------------------------------------------------------------------
// Per-turn tool menu resolver (HOK-3054 — Epic 10.2)
//
// Combines the pure eligibility calculator (`computeEligibility`, HOK-3053)
// with the Pi adapter to produce the two artifacts that make provider tool
// exposure auditable:
//
//   * `toolMenu`     — the logical policy-eligible menu (stable across
//                       provider wording churn)
//   * `providerTools` — the exact provider-visible schema list that will be
//                       sent this turn (byte-stable and matchable against
//                       what the agent loop actually hands the model)
//
// Both artifacts carry a canonical JSON representation and a SHA-256 digest,
// so a `model_request` event can record `toolMenuDigest` and
// `providerToolsDigest`, and drift between them and what the provider
// receives can be detected deterministically.
//
// Pure and synchronous: no disk, no env, no globals. Callers pass the config
// + certification + descriptors that were already assembled at launch time.
// ---------------------------------------------------------------------------

import type { WavemillConfig } from '../../config.ts';
import { canonicalJsonStringify } from '../../resource-registry.ts';
import { computeValueDigest } from '../session-stream.ts';
import type { WavemillLoopConfig } from '../loop.ts';
import {
  computeEligibility,
  type EligibilityDenial,
  type NativeCertificationSnapshot,
} from './exposure.ts';
import { toPiAgentTool, type AgentTool } from './pi-adapter.ts';
import { createToolRegistry } from './registry.ts';
import type {
  RegisteredToolMetadata,
  ToolDescriptor,
  ToolPhase,
} from './types.ts';
import type { TSchema } from 'typebox';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Logical view of a menu entry — no wording, no schema. */
export interface LogicalMenuEntry {
  name: string;
  family: string;
  logicalId: string;
  exposure: string;
  class: string;
  allowedPhases: readonly string[];
  provenance: string;
  certificationRequirement: string;
}

/** Provider-visible view of a menu entry — the JSON view of what Pi sends. */
export interface ProviderMenuEntry {
  name: string;
  description: string;
  label: string;
  executionMode: string;
  parameters: unknown;
}

export interface ResolvedToolMenu {
  /** Canonical JSON (sorted keys) of the logical entries. */
  canonical: string;
  /** SHA-256 of `canonical`. */
  digest: string;
  /** Names in registry registration order. */
  toolNames: readonly string[];
  /** Byte size of the canonical form (used for artifact spillover). */
  byteSize: number;
}

export interface ResolvedProviderTools {
  canonical: string;
  digest: string;
  toolCount: number;
  toolNames: readonly string[];
  byteSize: number;
}

export interface ResolvedTurnMenu {
  /** Policy-eligible descriptors, in registration order. */
  logical: readonly RegisteredToolMetadata[];
  /** Provider-facing tools that will be sent this turn. */
  provider: readonly AgentTool<TSchema, unknown>[];
  /** Pass-through denials from `computeEligibility`. */
  denials: readonly EligibilityDenial[];
  toolMenu: ResolvedToolMenu;
  providerTools: ResolvedProviderTools;
}

export interface ResolveTurnMenuInput {
  phase: ToolPhase;
  config: WavemillConfig;
  certification: NativeCertificationSnapshot;
  descriptors: readonly ToolDescriptor[];
  /**
   * Override the provider list — the terminal-synthesis turn passes `[]` so
   * `providerTools` reflects the empty schema list actually sent even though
   * the logical menu still describes the exposed set.
   */
  overrideProviderTools?: readonly AgentTool<TSchema, unknown>[];
  /** Injectable adapter (for tests). Defaults to `toPiAgentTool`. */
  toPiAgentToolFn?: typeof toPiAgentTool;
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

/**
 * Materialize a resolved menu for one turn. Pure function.
 *
 * The returned `logical`/`provider` collections are in *registration order*
 * so per-turn digest comparisons are stable across calls.
 */
export function resolveTurnMenu(input: ResolveTurnMenuInput): ResolvedTurnMenu {
  const registry = createToolRegistry(input.descriptors);
  const registered = registry.list();
  const eligibility = computeEligibility({
    phase: input.phase,
    config: input.config,
    certification: input.certification,
    registry: registered,
  });

  const eligibleNameSet = new Set(eligibility.eligibleNames);
  const logical = registered.filter((meta) => eligibleNameSet.has(meta.name));
  const eligibleDescriptors = registry.getTools({
    names: eligibility.eligibleNames as string[],
  });

  const toPi = input.toPiAgentToolFn ?? toPiAgentTool;
  const providerFromEligible = eligibleDescriptors.map((descriptor) => toPi(descriptor));
  const provider = input.overrideProviderTools ?? providerFromEligible;

  const toolMenu = buildLogicalMenuArtifact(logical);
  const providerTools = buildProviderMenuArtifact(provider);

  return {
    logical,
    provider,
    denials: eligibility.denials,
    toolMenu,
    providerTools,
  };
}

// ---------------------------------------------------------------------------
// Launch integration
// ---------------------------------------------------------------------------

export interface LaunchMenuProvider {
  /**
   * Resolved menu for the initial provider request. Callers set this as
   * `AgentContext.tools` and read the digests for the first model request.
   */
  readonly initialMenu: ResolvedTurnMenu;
  /**
   * Provider-facing tool list to seat in `AgentContext.tools`. This is the
   * source of truth the loop hands to Pi.
   */
  readonly providerToolsForContext: AgentTool<TSchema, unknown>[];
  /** Loop-facing menu provider — one per launch, closes over resolver state. */
  readonly menuProvider: NonNullable<WavemillLoopConfig['menuProvider']>;
}

export interface CreateLaunchMenuProviderInput {
  phase: ToolPhase;
  config: WavemillConfig;
  certification: NativeCertificationSnapshot;
  descriptors: readonly ToolDescriptor[];
  /** Injectable Pi adapter for tests. */
  toPiAgentToolFn?: typeof toPiAgentTool;
}

/**
 * Wire one resolver behind the loop's `menuProvider` seam. Every non-terminal
 * turn returns the same digests; terminal-synthesis re-resolves with an empty
 * provider override so the digest reflects the tool-free request that Pi
 * actually receives.
 */
export function createLaunchMenuProvider(
  input: CreateLaunchMenuProviderInput,
): LaunchMenuProvider {
  const initialMenu = resolveTurnMenu({
    phase: input.phase,
    config: input.config,
    certification: input.certification,
    descriptors: input.descriptors,
    toPiAgentToolFn: input.toPiAgentToolFn,
  });

  const providerToolsForContext = [...initialMenu.provider];

  let terminalMenu: ResolvedTurnMenu | undefined;

  const menuProvider: NonNullable<WavemillLoopConfig['menuProvider']> = {
    resolveForTurn(turnInput) {
      if (turnInput.terminalSynthesis) {
        if (!terminalMenu) {
          terminalMenu = resolveTurnMenu({
            phase: input.phase,
            config: input.config,
            certification: input.certification,
            descriptors: input.descriptors,
            overrideProviderTools: [],
            toPiAgentToolFn: input.toPiAgentToolFn,
          });
        }
        return terminalMenu;
      }
      return initialMenu;
    },
  };

  return { initialMenu, providerToolsForContext, menuProvider };
}

// ---------------------------------------------------------------------------
// Denial logging helper
// ---------------------------------------------------------------------------

/**
 * Render denials as a stable, single-line-per-entry string suitable for
 * appending to launch logs. Contains no PII: just family, logicalId, and
 * denial reason plus the specific fields that reason carries.
 */
export function formatMenuDenials(denials: readonly EligibilityDenial[]): string {
  if (denials.length === 0) return '';
  return denials
    .map((denial) => {
      switch (denial.reason) {
        case 'family_not_enabled':
          return `family_not_enabled family=${denial.family} logicalId=${denial.logicalId} tool=${denial.toolName}`;
        case 'phase_not_allowed':
          return `phase_not_allowed family=${denial.family} logicalId=${denial.logicalId} tool=${denial.toolName} phase=${denial.phase}`;
        case 'certification_missing':
          return `certification_missing family=${denial.family} logicalId=${denial.logicalId} tool=${denial.toolName} required=${denial.requirement} actual=${denial.actual}`;
        case 'logical_id_not_allowlisted':
          return `logical_id_not_allowlisted family=${denial.family} logicalId=${denial.logicalId} tool=${denial.toolName}`;
        case 'unknown_family':
          return `unknown_family family=${denial.family}`;
        case 'unknown_logical_id':
          return `unknown_logical_id family=${denial.family} logicalId=${denial.logicalId}`;
        case 'invalid_phase':
          return `invalid_phase phase=${denial.phase}`;
        default: {
          // Exhaustive-check assurance.
          const _exhaustive: never = denial;
          return String(_exhaustive);
        }
      }
    })
    .join('\n');
}

// ---------------------------------------------------------------------------
// Internal artifact construction
// ---------------------------------------------------------------------------

function buildLogicalMenuArtifact(
  logical: readonly RegisteredToolMetadata[],
): ResolvedToolMenu {
  const entries: LogicalMenuEntry[] = logical.map((meta) => ({
    name: meta.name,
    family: meta.family,
    logicalId: meta.logicalId,
    exposure: meta.exposure,
    class: meta.class,
    allowedPhases: [...meta.allowedPhases],
    provenance: meta.provenance,
    certificationRequirement: meta.certificationRequirement,
  }));
  const canonical = canonicalJsonStringify(entries);
  return {
    canonical,
    digest: computeValueDigest(entries),
    toolNames: logical.map((meta) => meta.name),
    byteSize: Buffer.byteLength(canonical, 'utf-8'),
  };
}

function buildProviderMenuArtifact(
  provider: readonly AgentTool<TSchema, unknown>[],
): ResolvedProviderTools {
  const entries: ProviderMenuEntry[] = provider.map((tool) => ({
    name: String(tool.name),
    description: String(tool.description ?? ''),
    label: String(tool.label ?? tool.name),
    executionMode: String(tool.executionMode ?? 'sequential'),
    parameters: serializeParameters(tool.parameters),
  }));
  const canonical = canonicalJsonStringify(entries);
  return {
    canonical,
    digest: computeValueDigest(entries),
    toolCount: provider.length,
    toolNames: provider.map((tool) => String(tool.name)),
    byteSize: Buffer.byteLength(canonical, 'utf-8'),
  };
}

/**
 * Pi/typebox schemas are usually plain JSON objects, but the type is opaque
 * to keep vendor imports out of shared code. We serialise defensively so a
 * schema whose values are not JSON-safe still yields a deterministic string
 * rather than throwing.
 */
function serializeParameters(parameters: unknown): unknown {
  if (parameters === undefined || parameters === null) {
    return parameters;
  }
  try {
    // JSON.stringify → parse yields a canonical plain-object copy; downstream
    // `canonicalizeValue` then sorts keys.
    return JSON.parse(JSON.stringify(parameters));
  } catch {
    return String(parameters);
  }
}
