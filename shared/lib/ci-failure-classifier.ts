export type CiFailureCategory = 'deterministic-local' | 'transient-infra' | 'github-only' | 'unknown';

export interface CiFailureCheckInput {
  name: string;
  rawStatus?: string;
  status?: string;
  text?: string;
  annotations?: string[];
  details?: unknown;
}

export interface CiFailureClassification {
  category: CiFailureCategory;
  failingJob: string;
  localCommand?: string;
  logExcerpt: string;
  reason: string;
}

export interface CiFailureClassifierOptions {
  localCommandMap?: Record<string, string>;
  logMaxBytes?: number;
}

const DEFAULT_LOG_MAX_BYTES = 20_000;

const TRANSIENT_PATTERNS = [
  /\bnot acquired by Runner\b/i,
  /hosted runner encountered an error/i,
  /runner (?:lost|has lost|was lost|disconnected)/i,
  /^The (?:job|run|workflow|operation) was cancelled\b/im,
  /^\s*CANCELLED\s*$/im,
  /setup timed out/i,
  /workflow timed out/i,
  /\bECONNRESET\b/,
  /\bETIMEDOUT\b/,
  /\bEAI_AGAIN\b/,
  /connection (?:reset|refused|closed)/i,
];

const GITHUB_ONLY_PATTERNS = [
  /required approval/i,
  /review required/i,
  /code scanning/i,
  /secret scanning/i,
  /dependabot/i,
  /security/i,
  /branch protection/i,
  /deployment protection/i,
  /manual approval/i,
  /github[- ]hosted only/i,
];

const DETERMINISTIC_PATTERNS = [
  /\bconfig validation failed\b/i,
  /\bERR_TEST_FAILURE\b/,
  /\bdrift found\b/i,
  /^FAIL(?:\s|$)/m,
  /\b\d+\s*passed,\s*[1-9]\d*\s*failed\b/i,
  /^not ok \d+/m,
  /\btest(?:s)?\s+timed out\b/i,
  /assert(?:ion)? failed/i,
  /\bexpected\b.*\bactual\b/i,
  /\btest(?:s)? failed\b/i,
  /\bfailing tests?\b/i,
  /\blint (?:error|violation|failed)\b/i,
  /\btype(?:script)? error\b/i,
  /\btsc\b/i,
  /\beslint\b/i,
  /\bprettier\b/i,
  /\bshellcheck\b/i,
  /\bexit code 1\b/i,
];

export function classifyCiFailure(
  check: CiFailureCheckInput,
  options: CiFailureClassifierOptions = {},
): CiFailureClassification {
  const failingJob = String(check.name || 'unknown check');
  const haystack = buildHaystack(check);
  const logExcerpt = tailBytes(haystack, normalizeLogMaxBytes(options.logMaxBytes));
  const localCommand = lookupLocalCommand(failingJob, options.localCommandMap ?? {});

  const deterministicMatch = firstMatch(haystack, DETERMINISTIC_PATTERNS);
  if (deterministicMatch) {
    if (localCommand) {
      return {
        category: 'deterministic-local',
        failingJob,
        localCommand,
        logExcerpt,
        reason: `Classified ${failingJob} as locally replayable (${deterministicMatch}); recipe: ${localCommand}.`,
      };
    }
    return {
      category: 'unknown',
      failingJob,
      localCommand,
      logExcerpt,
      reason: `Check ${failingJob} shows a code-failure signature (${deterministicMatch}) but no configured local recipe.`,
    };
  }

  const transientMatch = firstMatch(haystack, TRANSIENT_PATTERNS);
  if (transientMatch) {
    return {
      category: 'transient-infra',
      failingJob,
      localCommand,
      logExcerpt,
      reason: `Classified ${failingJob} as transient infrastructure failure (${transientMatch}).`,
    };
  }

  const githubOnlyMatch = firstMatch(haystack, GITHUB_ONLY_PATTERNS);
  if (githubOnlyMatch) {
    return {
      category: 'github-only',
      failingJob,
      localCommand,
      logExcerpt,
      reason: `Classified ${failingJob} as GitHub-only or approval/security gated (${githubOnlyMatch}).`,
    };
  }

  if (localCommand) {
    return {
      category: 'unknown',
      failingJob,
      localCommand,
      logExcerpt,
      reason: `Check ${failingJob} has a local recipe but no deterministic failure signature.`,
    };
  }

  return {
    category: 'unknown',
    failingJob,
    logExcerpt,
    reason: `Check ${failingJob} has no configured local recipe and no safe automatic classification.`,
  };
}

function normalizeLogMaxBytes(value: number | undefined): number {
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_LOG_MAX_BYTES;
}

function buildHaystack(check: CiFailureCheckInput): string {
  const parts = [
    check.name,
    check.rawStatus,
    check.status,
    ...(check.annotations ?? []),
    stringifyDetails(check.details),
    check.text,
  ];
  return parts.filter((part): part is string => typeof part === 'string' && part.length > 0).join('\n');
}

function stringifyDetails(details: unknown): string {
  if (details === null || details === undefined) {
    return '';
  }
  if (typeof details === 'string') {
    return details;
  }
  try {
    return JSON.stringify(details);
  } catch {
    return String(details);
  }
}

function firstMatch(text: string, patterns: RegExp[]): string | null {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match?.[0]) {
      return match[0];
    }
  }
  return null;
}

export function lookupLocalCommand(jobName: string, localCommandMap: Record<string, string>): string | undefined {
  const exact = localCommandMap[jobName];
  if (typeof exact === 'string' && exact.trim()) {
    return exact.trim();
  }
  const normalizedJob = normalizeKey(jobName);
  const normalizedUnshardedJob = normalizeKey(stripShardSuffix(jobName));
  for (const [key, command] of Object.entries(localCommandMap)) {
    if ((normalizeKey(key) === normalizedJob || normalizeKey(key) === normalizedUnshardedJob) && command.trim()) {
      return command.trim();
    }
  }
  return undefined;
}

function stripShardSuffix(value: string): string {
  return value.replace(/\s*\(shard\s+\d+\s*\/\s*\d+\)\s*$/i, '');
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function tailBytes(value: string, maxBytes: number): string {
  const bytes = Buffer.byteLength(value, 'utf-8');
  if (bytes <= maxBytes) {
    return value;
  }

  let result = '';
  let used = 0;
  for (let i = value.length - 1; i >= 0; i -= 1) {
    const char = value[i];
    const charBytes = Buffer.byteLength(char, 'utf-8');
    if (used + charBytes > maxBytes) {
      break;
    }
    result = char + result;
    used += charBytes;
  }
  return `[...truncated...]\n${result}`;
}
