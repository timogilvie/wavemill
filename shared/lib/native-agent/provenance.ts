export type ToolResultSourceKind =
  | 'file'
  | 'diff'
  | 'issue'
  | 'pull_request'
  | 'comment'
  | 'command_output'
  | 'provider_payload'
  | 'wavemill_artifact'
  | 'browser'
  | 'mcp_result'
  | 'unknown';

export type ToolResultTrustTier = 'trusted' | 'untrusted';

export type InjectionAttemptCategory =
  | 'phase_override'
  | 'path_override'
  | 'approval_override'
  | 'network_override'
  | 'completion_override';

export interface ToolInjectionDiagnostic {
  kind: 'prompt_injection_attempt';
  category: InjectionAttemptCategory;
  sourceKind: ToolResultSourceKind;
  message: string;
  excerpt: string;
}

export interface ToolTrustMetadata {
  sourceKind: ToolResultSourceKind;
  trust: ToolResultTrustTier;
  diagnostics: ToolInjectionDiagnostic[];
}

interface TrustMetadataInput {
  sourceKind?: string;
  content?: Array<{ type?: string; text?: string }>;
  details?: unknown;
}

interface InjectionRule {
  category: InjectionAttemptCategory;
  pattern: RegExp;
  message: string;
}

const TRUST_BY_SOURCE_KIND: Record<ToolResultSourceKind, ToolResultTrustTier> = {
  file: 'untrusted',
  diff: 'untrusted',
  issue: 'untrusted',
  pull_request: 'untrusted',
  comment: 'untrusted',
  command_output: 'untrusted',
  provider_payload: 'untrusted',
  wavemill_artifact: 'trusted',
  browser: 'untrusted',
  mcp_result: 'untrusted',
  unknown: 'untrusted',
};

const INJECTION_RULES: readonly InjectionRule[] = [
  {
    category: 'phase_override',
    pattern: /\b(ignore|override|switch|change)\b[\s\S]{0,80}\b(phase|planning|coding|review|ready)\b/i,
    message: 'Untrusted content attempted to override workflow phase policy.',
  },
  {
    category: 'path_override',
    pattern: /\b(ignore|bypass|allow|edit)\b[\s\S]{0,80}\b(path|paths|worktree|outside the worktree|allowlist)\b/i,
    message: 'Untrusted content attempted to override path scope policy.',
  },
  {
    category: 'approval_override',
    pattern: /\b(approval|approvals)\b[\s\S]{0,80}\b(not required|waived|granted|bypass|ignore)\b/i,
    message: 'Untrusted content attempted to override approval policy.',
  },
  {
    category: 'network_override',
    pattern: /\b(network|internet)\b[\s\S]{0,80}\b(enabled|allowed|grant|bypass|ignore)\b/i,
    message: 'Untrusted content attempted to override network policy.',
  },
  {
    category: 'completion_override',
    pattern: /\b(mark|consider|treat|declare)\b[\s\S]{0,80}\b(complete|completed|completion)\b[\s\S]{0,80}\b(without|skip|ignore|waive)\b/i,
    message: 'Untrusted content attempted to override completion requirements.',
  },
];

function normalizeSourceKind(sourceKind: string | undefined): ToolResultSourceKind {
  switch (sourceKind) {
    case 'file':
    case 'diff':
    case 'issue':
    case 'pull_request':
    case 'comment':
    case 'command_output':
    case 'provider_payload':
    case 'wavemill_artifact':
    case 'browser':
    case 'mcp_result':
      return sourceKind;
    default:
      return 'unknown';
  }
}

function collectStrings(value: unknown, acc: string[]): void {
  if (typeof value === 'string') {
    acc.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectStrings(item, acc);
    }
    return;
  }
  if (value && typeof value === 'object') {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      collectStrings(nested, acc);
    }
  }
}

function collectContentStrings(
  content: Array<{ type?: string; text?: string }> | undefined,
): string[] {
  if (!Array.isArray(content)) {
    return [];
  }
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string);
}

function excerptAround(text: string, match: RegExpExecArray): string {
  const start = Math.max(0, match.index - 30);
  const end = Math.min(text.length, match.index + match[0].length + 30);
  return text.slice(start, end).replace(/\s+/g, ' ').trim();
}

export function buildTrustMetadata(input: TrustMetadataInput): ToolTrustMetadata {
  const sourceKind = normalizeSourceKind(input.sourceKind);
  const trust = TRUST_BY_SOURCE_KIND[sourceKind];
  if (trust === 'trusted') {
    return { sourceKind, trust, diagnostics: [] };
  }

  const texts = collectContentStrings(input.content);
  collectStrings(input.details, texts);

  const diagnostics: ToolInjectionDiagnostic[] = [];
  const seen = new Set<string>();

  for (const text of texts) {
    for (const rule of INJECTION_RULES) {
      const match = rule.pattern.exec(text);
      if (!match) {
        continue;
      }
      const excerpt = excerptAround(text, match);
      const key = `${rule.category}:${excerpt}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      diagnostics.push({
        kind: 'prompt_injection_attempt',
        category: rule.category,
        sourceKind,
        message: rule.message,
        excerpt,
      });
    }
  }

  return { sourceKind, trust, diagnostics };
}

export function buildProviderPayloadTrustMetadata(payload: unknown): ToolTrustMetadata {
  return buildTrustMetadata({ sourceKind: 'provider_payload', details: payload });
}
