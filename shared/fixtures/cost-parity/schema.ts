/**
 * Wavemill Cost Parity Corpus Schema
 *
 * This schema defines the structure for cost-engine parity testing between the legacy
 * workflow-cost.ts engine and the Hokusai SDK. Each case contains sanitized, synthetic
 * session files that exercise specific scenarios (mixed models, caching, provider costs, etc).
 *
 * Privacy: No transcript text is stored. Session lines carry only usage metrics and a
 * "secret-token-should-not-persist" canary in structured fields.
 */

/**
 * Session location on disk: where the adapter will find the session file.
 * Adapters write to ~/. {claude,codex}/ or .wavemill/runs/<runId>/
 */
export type SessionLocation = "claude-projects" | "claude-deepseek-provider" | "codex-sessions" | "native-sessions";

/**
 * Represents one session file within a case, ready to be materialized.
 */
export interface CostParityCaseSession {
  location: SessionLocation;
  fileName: string;
  runId?: string; // required for native-sessions and claude-deepseek-provider
  lines: Record<string, unknown>[]; // raw JSONL objects; ${WORKTREE} placeholder substituted at materialization
}

/**
 * Represents the expected exact-pricing response (stub for OpenRouter).
 */
export interface ExactPricingResponse {
  responses: Record<string, { totalCostUsd: number } | null>;
}

/**
 * A single expected fix, mapping a defect to its treatment.
 */
export interface ExpectedFix {
  id: string; // EF-1, EF-2, etc
  path: string; // JSON path in the snapshot, e.g., "evalRecord.workflowCost" or "sync.coverage"
  legacy: unknown; // the value from the baseline (captured during --write)
  expected?: unknown; // corrected value, or { "decision": "HOK-3075" } if awaiting SDK decision
  rationale: string; // why this fix is needed
}

/**
 * Expectations for a case: which aspects must match strictly vs which allow fixes.
 */
export interface CostParityCaseExpectations {
  strictParity?: string[]; // informational: highlight list of paths that must match
  expectedFixes?: ExpectedFix[]; // defects allowed to differ in migration mode
}

/**
 * Pricing table for this case: models and their rates.
 */
export interface PricingTable {
  [modelId: string]: {
    inputCostPerMTok: number;
    outputCostPerMTok: number;
    cacheCreationTokens?: number; // per 1K cached, if different from input
    cacheReadTokens?: number;
  };
}

/**
 * A single cost-parity test case: inputs to the cost engine and expected outputs.
 */
export interface CostParityCase {
  id: string; // stable identifier, e.g., "claude-mixed-one-unpriced"
  description: string; // scenario description for humans
  tags: string[]; // coverage tags: claude-code, codex, native-pi, openrouter-exact, mixed-models, unknown-price, cache-explicit, cache-derived, cache-read, missing-session, known-zero, partial, replay/dedupe
  branch?: string; // synthetic branch name, e.g., "task/parity-case"
  issueId: string; // synthetic issue id, e.g., "HOK-0000"
  agentType: "claude" | "codex" | "native-pi";
  pricingTable: PricingTable; // explicit pricing for this case
  sessions: CostParityCaseSession[]; // session files to materialize
  exact?: ExactPricingResponse; // optional injected OpenRouter stub
  expectations: CostParityCaseExpectations;
}

/**
 * Function-level pricing test case (for computeModelCost, computeNormalizedEvaluationCost, etc).
 */
export interface PricingFunctionCase {
  id: string;
  description: string;
  functionName: "computeModelCost" | "computeNormalizedEvaluationCost" | "recalculateWorkflowCost";
  args: Record<string, unknown>;
  expectedResult: unknown;
  expectedFixes?: ExpectedFix[];
}

/**
 * Top-level manifest for the cost-parity corpus.
 */
export interface CostParityManifest {
  schemaVersion: "cost_parity_manifest/v1";
  capturedFrom: "wavemill workflow-cost.ts (legacy engine)";
  cases: CostParityCase[];
  pricingCases?: PricingFunctionCase[]; // function-level test cases
}

/**
 * Validation result.
 */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
  diagnostics: Record<string, unknown>;
}

/**
 * Validate a cost-parity manifest.
 * Checks:
 * - Unique case ids
 * - Known session locations
 * - Known tags
 * - ExpectedFix ids match /^EF-\d+$/
 * - No absolute paths or forbidden keys in session lines
 */
export function validateManifest(manifest: CostParityManifest): ValidationResult {
  const errors: string[] = [];
  const diagnostics: Record<string, unknown> = {
    totalCases: 0,
    totalSessions: 0,
    validSessions: 0,
    tagCoverage: new Set<string>(),
    requiredTags: [
      "claude-code",
      "codex",
      "native-pi",
      "openrouter-exact",
      "mixed-models",
      "unknown-price",
      "cache-explicit",
      "cache-derived",
      "cache-read",
      "missing-session",
      "known-zero",
      "partial",
      "replay/dedupe",
    ],
  };

  const knownLocations = new Set<SessionLocation>(["claude-projects", "claude-deepseek-provider", "codex-sessions", "native-sessions"]);
  const knownTags = new Set(diagnostics.requiredTags as string[]);
  const caseIds = new Set<string>();

  // Validate schema version
  if (manifest.schemaVersion !== "cost_parity_manifest/v1") {
    errors.push(`Invalid schemaVersion: "${manifest.schemaVersion}"`);
  }

  if (!manifest.cases || !Array.isArray(manifest.cases)) {
    errors.push("Manifest missing or invalid cases array");
    return { valid: false, errors, diagnostics };
  }

  // Validate each case
  for (const caseItem of manifest.cases) {
    diagnostics.totalCases = (diagnostics.totalCases as number) + 1;

    // Check case id uniqueness
    if (!caseItem.id || typeof caseItem.id !== "string") {
      errors.push("Case missing or invalid id");
    } else if (caseIds.has(caseItem.id)) {
      errors.push(`Duplicate case id: "${caseItem.id}"`);
    } else {
      caseIds.add(caseItem.id);
    }

    // Check required fields
    if (!caseItem.description || typeof caseItem.description !== "string") {
      errors.push(`Case ${caseItem.id}: invalid description`);
    }
    if (!Array.isArray(caseItem.tags) || caseItem.tags.length === 0) {
      errors.push(`Case ${caseItem.id}: missing or empty tags`);
    } else {
      for (const tag of caseItem.tags) {
        (diagnostics.tagCoverage as Set<string>).add(tag);
        if (!knownTags.has(tag)) {
          errors.push(`Case ${caseItem.id}: unknown tag "${tag}"`);
        }
      }
    }

    if (!caseItem.agentType || !["claude", "codex", "native-pi"].includes(caseItem.agentType)) {
      errors.push(`Case ${caseItem.id}: invalid agentType`);
    }

    if (!caseItem.pricingTable || typeof caseItem.pricingTable !== "object") {
      errors.push(`Case ${caseItem.id}: missing or invalid pricingTable`);
    }

    if (!caseItem.expectations || typeof caseItem.expectations !== "object") {
      errors.push(`Case ${caseItem.id}: missing or invalid expectations`);
    }

    // Validate sessions
    if (!Array.isArray(caseItem.sessions)) {
      errors.push(`Case ${caseItem.id}: missing or invalid sessions array`);
    } else {
      for (let i = 0; i < caseItem.sessions.length; i++) {
        const session = caseItem.sessions[i];
        diagnostics.totalSessions = (diagnostics.totalSessions as number) + 1;

        if (!session.location || !knownLocations.has(session.location)) {
          errors.push(`Case ${caseItem.id}, session ${i}: invalid location "${session.location}"`);
        }

        if (!session.fileName || typeof session.fileName !== "string") {
          errors.push(`Case ${caseItem.id}, session ${i}: invalid fileName`);
        }

        // native-sessions and claude-deepseek-provider require runId
        if (["native-sessions", "claude-deepseek-provider"].includes(session.location) && !session.runId) {
          errors.push(`Case ${caseItem.id}, session ${i} (${session.location}): missing runId`);
        }

        // Validate session lines
        if (!Array.isArray(session.lines)) {
          errors.push(`Case ${caseItem.id}, session ${i}: invalid lines array`);
        } else {
          for (let j = 0; j < session.lines.length; j++) {
            const line = session.lines[j];
            const jsonStr = JSON.stringify(line);

            // Check for absolute paths (privacy violation)
            if (/^\/Users\/|^\/home\/|^\/tmp\//.test(jsonStr)) {
              errors.push(
                `Case ${caseItem.id}, session ${i}, line ${j}: contains absolute path (privacy violation). Use ${WORKTREE} placeholder.`
              );
            }

            // Check for forbidden keys (rawContent, replayContent should only appear in canary)
            if ("rawContent" in line || "replayContent" in line) {
              const content = (line as Record<string, unknown>).rawContent ||
                (line as Record<string, unknown>).replayContent;
              if (typeof content === "string" && !content.includes("secret-token-should-not-persist")) {
                errors.push(`Case ${caseItem.id}, session ${i}, line ${j}: ${
                  "rawContent" in line ? "rawContent" : "replayContent"
                } found but missing canary`);
              }
            }

            diagnostics.validSessions = (diagnostics.validSessions as number) + 1;
          }
        }
      }
    }

    // Validate expectations
    if (caseItem.expectations && Array.isArray(caseItem.expectations.expectedFixes)) {
      for (const fix of caseItem.expectations.expectedFixes) {
        if (!fix.id || !/^EF-\d+$/.test(fix.id)) {
          errors.push(`Case ${caseItem.id}: expectedFix has invalid id "${fix.id}". Must match /^EF-\\d+$/`);
        }
        if (!fix.path || typeof fix.path !== "string") {
          errors.push(`Case ${caseItem.id}: expectedFix ${fix.id} has invalid path`);
        }
        if (!fix.rationale || typeof fix.rationale !== "string") {
          errors.push(`Case ${caseItem.id}: expectedFix ${fix.id} missing rationale`);
        }
      }
    }
  }

  // Check required tag coverage
  const coverageSet = diagnostics.tagCoverage as Set<string>;
  const missingTags = (diagnostics.requiredTags as string[]).filter((tag) => !coverageSet.has(tag));
  if (missingTags.length > 0) {
    errors.push(`Missing coverage for required tags: ${missingTags.join(", ")}`);
    (diagnostics.missingTags as string[]) = missingTags;
  }

  return {
    valid: errors.length === 0,
    errors,
    diagnostics,
  };
}
