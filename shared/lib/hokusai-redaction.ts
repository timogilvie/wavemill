/**
 * PII redaction for Hokusai submissions.
 *
 * Call `redactHokusaiSubmission()` after `toHokusaiSubmission()` and before any
 * submission data leaves the user's machine.
 *
 * @module hokusai-redaction
 */

import { createHmac, randomBytes } from 'node:crypto';
import { loadUserConfig, saveUserConfig, type HokusaiUserConfig } from './hokusai-consent.ts';
import type { HokusaiSubmission } from './hokusai-schema.ts';

export interface RedactionOptions {
  salt?: string;
  configDir?: string;
}

/**
 * Explicit default-deny audit fixture for the Arbiter privacy boundary
 * (HOK-2787). These are the protected values that must never transit any
 * Hokusai egress path: vendor telemetry identity fields (user email,
 * organization id, account UUID, raw session/account identifiers, transcript
 * paths, prompts, provider payloads) and reviewer evidence (raw review
 * prompts, source/diffs, structured findings, reproduction evidence,
 * remediation patches).
 *
 * Redaction is default-deny by construction — unlisted strings are blanked —
 * so this fixture exists to keep the September 2026 requirements pinned as
 * named regression tests rather than relying on the mechanism alone. Tests in
 * this repo assert none of these sentinel values survive redaction or appear
 * in queued contribution rows.
 */
export const PROTECTED_EGRESS_FIELD_FIXTURE = Object.freeze({
  user: Object.freeze({
    email: 'protected-user@example.com',
    account_uuid: 'protected-account-uuid-0000',
  }),
  organization: Object.freeze({ id: 'protected-org-id-0000' }),
  session_id: 'protected-session-id-0000',
  account_id: 'protected-raw-account-id-0000',
  transcript_path: '/Users/protected/.claude/projects/transcript.jsonl',
  prompt: 'protected raw prompt text',
  provider_payload: '{"messages":[{"role":"user","content":"protected"}]}',
  source_diff: 'diff --git a/protected.ts b/protected.ts',
  review_prompt: 'protected raw review prompt',
  review_findings: 'protected structured finding evidence',
  reproduction_evidence: 'protected reproduction transcript',
  remediation_patch: '--- a/protected.ts\n+++ b/protected.ts',
});

/**
 * Every protected sentinel string from {@link PROTECTED_EGRESS_FIELD_FIXTURE},
 * flattened for "does not transit" assertions against serialized payloads.
 */
export function protectedEgressSentinelValues(): string[] {
  const values: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      values.push(value);
    } else if (value && typeof value === 'object') {
      for (const child of Object.values(value)) {
        visit(child);
      }
    }
  };
  visit(PROTECTED_EGRESS_FIELD_FIXTURE);
  return values;
}

const HASHED_IDENTIFIER_PATHS = new Set(['run_id', 'task_id']);
const PRESERVED_STRING_PATHS = new Set([
  'schema_version',
  'route_taken.planner_model',
  'route_taken.coder_model',
  'route_taken.reviewer_model',
  'rubric_signals.determinative_boundary',
  'rubric_signals.rubric_provenance',
  'rubric_signals.rubric_version',
]);

function isNonEmptySalt(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
}

function hashIdentifier(value: string, salt: string): string {
  const digest = createHmac('sha256', salt)
    .update(value)
    .digest('hex')
    .slice(0, 16);

  return `redacted-${digest}`;
}

function redactSubmissionValue(value: unknown, path: string[], salt: string): unknown {
  const joinedPath = path.join('.');

  if (HASHED_IDENTIFIER_PATHS.has(joinedPath)) {
    return hashIdentifier(String(value), salt);
  }

  if (typeof value === 'string') {
    return PRESERVED_STRING_PATHS.has(joinedPath) ? value : '';
  }

  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      redactSubmissionValue(entry, [...path, String(index)], salt),
    );
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        redactSubmissionValue(entry, [...path, key], salt),
      ]),
    );
  }

  return value;
}

function withRedactionSalt(config: HokusaiUserConfig, salt: string): HokusaiUserConfig {
  return {
    ...config,
    hokusai: {
      ...(config.hokusai || {}),
      redactionSalt: salt,
    },
  };
}

/**
 * Load the user's persistent redaction salt, creating one on first use.
 */
export function getOrCreateRedactionSalt(configDir?: string): string {
  const config = loadUserConfig(configDir);
  const existingSalt = config.hokusai?.redactionSalt;

  if (isNonEmptySalt(existingSalt)) {
    return existingSalt;
  }

  const salt = randomBytes(32).toString('hex');
  saveUserConfig(withRedactionSalt(config, salt), configDir);
  return salt;
}

/**
 * A challenge pair's id as a v4 `comparison_group.id` (HOK-3415). Wavemill's
 * pair id is a task identifier (the primary's issue id), and the contract asks
 * for a minted UUID or ULID, so it leaves as an RFC 9562 version-8 UUID (the
 * custom layout) over HMAC-SHA256 with the contributor's salt: both arms of a
 * pair get the same id, and the raw identifier never leaves.
 */
export function redactPairId(pairId: string, options: RedactionOptions = {}): string {
  const salt = options.salt ?? getOrCreateRedactionSalt(options.configDir);
  const hex = createHmac('sha256', salt).update(`pair:${pairId}`).digest('hex').slice(0, 32).split('');
  hex[12] = '8';
  hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const h = hex.join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** Raw session identifiers never leave on an egress path; hash them with the salt. */
export function redactSessionIds(sessionIds: readonly string[], options: RedactionOptions = {}): string[] {
  const salt = options.salt ?? getOrCreateRedactionSalt(options.configDir);
  return sessionIds.map((id) => hashIdentifier(id, salt));
}

/**
 * Redact one stage's task-cost summary for a v4 row (HOK-3415). The meter's
 * SDK summary is keyed on the raw task id and names the owned sessions: the
 * task id becomes the row's already-hashed `task_id` (the v4 validator requires
 * they match). Session ids and event ids (provider message / request ids) are
 * hashed with the same salt, so the row still tells sessions and events apart
 * (and keeps `event_count === event_ids.length`) without a raw identifier.
 */
export function redactStageTaskCost<
  T extends { task_id: string; session_ids?: readonly string[]; event_ids?: readonly string[] },
>(
  summary: T,
  options: RedactionOptions & { taskId: string },
): T {
  const salt = options.salt ?? getOrCreateRedactionSalt(options.configDir);
  return {
    ...summary,
    task_id: options.taskId,
    ...(summary.session_ids ? { session_ids: redactSessionIds(summary.session_ids, { salt }) } : {}),
    ...(summary.event_ids ? { event_ids: summary.event_ids.map((id) => hashIdentifier(id, salt)) } : {}),
  };
}

/**
 * Redact a Hokusai submission so only training-relevant fields remain readable.
 *
 * Identifiers are deterministically hashed for deduplication. Known model
 * selection fields are preserved verbatim. Any other string field is stripped
 * entirely so schema growth does not silently leak new free-text data.
 */
export function redactHokusaiSubmission(
  submission: HokusaiSubmission,
  options: RedactionOptions = {},
): HokusaiSubmission {
  const salt = options.salt ?? getOrCreateRedactionSalt(options.configDir);
  return redactSubmissionValue(submission, [], salt) as HokusaiSubmission;
}
