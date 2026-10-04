import { closeSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, resolve, sep } from 'node:path';
import type { JobStateDiagnostic } from './artifact-diagnostics.ts';
import {
  canonicalizeRootCauseClass,
  type IncidentRootCauseClass,
} from './wavemill-incident-model.ts';

// Fixed conservative caps. Not operator-configurable by design (HOK-3033): a
// tunable ceiling would defeat the "we cannot exceed X" guarantee that the
// bounded-diagnostics scope depends on. All values are inclusive maxima.
const MAX_READ_BYTES = 64 * 1024;
const MAX_HEAD_BYTES = 32 * 1024;
const MAX_TAIL_BYTES = 32 * 1024;
const MAX_HEAD_LINES = 20;
const MAX_TAIL_LINES = 40;
const MAX_SIGNATURE_LINES = 10;
const MAX_EXCERPT_LINES = 40;
const MAX_EXCERPT_CHARS = 1200;
const BINARY_SNIFF_BYTES = 4 * 1024;
const MAX_PERSISTED_INPUT = MAX_EXCERPT_CHARS * 4;

const TRANSCRIPT_HINT_PATTERN = /(?:transcript|prompt|message)s?[\/\\]|(?:transcript|prompt)s?[^\/\\]*\.(?:jsonl|json|log|md|txt)$/i;
const PROMPT_HEURISTIC_PATTERN = /\b(prompt|system|user|assistant|transcript)\b/i;

const ABSOLUTE_PATH_PATTERN = /\/(Users|home|root|private|tmp|var|opt)\/[A-Za-z0-9._\-\/]*/g;

const SIGNATURE_LINE_PATTERNS: RegExp[] = [
  /SyntaxError:.*does not provide an export named/i,
  /SyntaxError:/i,
  /TypeError:.*Cannot (?:read|find|call).*of (?:undefined|null)/i,
  /ReferenceError:/i,
  /Error:/,
  /Unhandled(?:Promise)?Rejection/i,
  /\bat\s+[A-Za-z_$][\w$.]*\s*\(.*:\d+/,
];

const CLASSIFIER_ORDER: Array<{
  pattern: RegExp;
  className: IncidentRootCauseClass;
}> = [
  {
    pattern: /SyntaxError:.*does not provide an export named|does not provide an export named/i,
    className: 'module_export_contract_mismatch',
  },
  {
    pattern: /SyntaxError:|Unexpected token|Failed to parse|Malformed JSON/i,
    className: 'local_parse_failure',
  },
  {
    pattern: /TypeError:.*Cannot (?:read|find|call).*of (?:undefined|null)/i,
    className: 'local_parse_failure',
  },
];

export type LogExcerptSource = 'persisted_error' | 'log_head_tail' | 'unavailable';

export interface LogExcerptEvidence {
  redactedText: string;
  key: string;
  diagnosedClass: IncidentRootCauseClass | null;
  observedSymptom: string;
  source: LogExcerptSource;
  /** Basename of the log file when we actually read from it; undefined otherwise. */
  logFileBasename?: string;
}

export function readIncidentLogExcerpt(
  job: JobStateDiagnostic,
  repoDir: string,
  observedSymptom: string,
): LogExcerptEvidence {
  const unavailable: LogExcerptEvidence = {
    redactedText: '',
    key: `observed:${observedSymptom}`,
    diagnosedClass: null,
    observedSymptom,
    source: 'unavailable',
  };

  const persisted = typeof job.error === 'string' ? job.error.trim() : '';
  if (persisted.length > 0) {
    return finalizeExcerpt(persisted.slice(0, MAX_PERSISTED_INPUT), observedSymptom, 'persisted_error', unavailable);
  }

  const rawLogPath = typeof job.logPath === 'string' ? job.logPath.trim() : '';
  if (!rawLogPath) return unavailable;

  const safePath = resolveSafeLogPath(rawLogPath, repoDir);
  if (!safePath) return unavailable;

  const raw = safeBoundedRead(safePath);
  if (raw === null) return unavailable;

  const combined = selectBoundedLines(raw);
  if (!combined) return unavailable;

  return {
    ...finalizeExcerpt(combined, observedSymptom, 'log_head_tail', unavailable),
    logFileBasename: basename(safePath),
  };
}

function finalizeExcerpt(
  text: string,
  observedSymptom: string,
  source: Exclude<LogExcerptSource, 'unavailable'>,
  unavailable: LogExcerptEvidence,
): LogExcerptEvidence {
  const inboundRedacted = redactInbound(text);
  if (!inboundRedacted) return unavailable;

  // Second-line defense: if this still resembles prompt/transcript content
  // despite path-based rejection, collapse it and mark unavailable so no
  // conversational bytes escape into persisted evidence.
  if (inboundRedacted.length > 800 && PROMPT_HEURISTIC_PATTERN.test(inboundRedacted)) {
    return unavailable;
  }

  const truncated = clampCharsFromTail(inboundRedacted, MAX_EXCERPT_CHARS);
  const diagnosed = classifyExcerpt(truncated);
  const key = diagnosed
    ? `diag:${diagnosed}`
    : `observed:${observedSymptom}`;

  return {
    redactedText: truncated,
    key,
    diagnosedClass: diagnosed,
    observedSymptom,
    source,
  };
}

function classifyExcerpt(text: string): IncidentRootCauseClass | null {
  for (const { pattern, className } of CLASSIFIER_ORDER) {
    if (pattern.test(text)) return className;
  }
  const canonical = canonicalizeRootCauseClass(text);
  if (canonical === 'module_export_contract_mismatch' || canonical === 'local_parse_failure') {
    return canonical;
  }
  return null;
}

function resolveSafeLogPath(rawLogPath: string, repoDir: string): string | null {
  if (rawLogPath.includes('\0')) return null;
  if (!isAbsolute(rawLogPath)) return null;
  const resolved = resolve(rawLogPath);
  if (resolved.split(sep).includes('..')) return null;

  let realRepo: string;
  let realLog: string;
  try {
    realRepo = realpathSync(resolve(repoDir));
    realLog = realpathSync(resolved);
  } catch {
    return null;
  }
  const repoWithSep = realRepo.endsWith(sep) ? realRepo : realRepo + sep;
  if (realLog !== realRepo && !realLog.startsWith(repoWithSep)) return null;

  // Transcripts, prompts, and message archives are out of scope even when they
  // sit under the repo (`.wavemill/transcripts/…`).
  const relative = realLog.slice(realRepo.length);
  if (TRANSCRIPT_HINT_PATTERN.test(relative)) return null;

  let stat;
  try {
    stat = statSync(realLog);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  return realLog;
}

function safeBoundedRead(path: string): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, 'r');
    const stat = statSync(path);
    const size = stat.size;

    // Binary sniff: read a small head window first and reject on NUL.
    const sniffLen = Math.min(size, BINARY_SNIFF_BYTES);
    const sniff = Buffer.alloc(sniffLen);
    if (sniffLen > 0) {
      readSync(fd, sniff, 0, sniffLen, 0);
      if (sniff.includes(0)) return null;
    }

    if (size <= MAX_READ_BYTES) {
      const buf = Buffer.alloc(size);
      readSync(fd, buf, 0, size, 0);
      return decodeUtf8Safe(buf);
    }

    const headBuf = Buffer.alloc(MAX_HEAD_BYTES);
    readSync(fd, headBuf, 0, MAX_HEAD_BYTES, 0);
    const tailBuf = Buffer.alloc(MAX_TAIL_BYTES);
    readSync(fd, tailBuf, 0, MAX_TAIL_BYTES, size - MAX_TAIL_BYTES);
    return `${decodeUtf8Safe(headBuf)}\n${decodeUtf8Safe(tailBuf)}`;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

function decodeUtf8Safe(buf: Buffer): string {
  try {
    return buf.toString('utf8');
  } catch {
    return '';
  }
}

function selectBoundedLines(raw: string): string | null {
  const rawLines = raw.split(/\r?\n/).map((line) => line.replace(/\r+$/, ''));
  if (rawLines.length === 0) return null;

  const head = rawLines.slice(0, MAX_HEAD_LINES);
  const tail = rawLines.slice(Math.max(rawLines.length - MAX_TAIL_LINES, 0));

  const signature: string[] = [];
  for (const line of rawLines) {
    if (signature.length >= MAX_SIGNATURE_LINES) break;
    if (SIGNATURE_LINE_PATTERNS.some((pattern) => pattern.test(line))) {
      signature.push(line);
    }
  }

  const combined: string[] = [];
  const seen = new Set<string>();
  for (const line of [...signature, ...head, ...tail]) {
    if (!line) continue;
    if (seen.has(line)) continue;
    seen.add(line);
    combined.push(line);
    if (combined.length >= MAX_EXCERPT_LINES) break;
  }
  if (combined.length === 0) return null;
  return combined.join('\n');
}

function redactInbound(text: string): string {
  // Same secret patterns as the shared redactor, minus the 500-char outbound
  // truncation (the outbound redactor still applies before Linear payloads).
  return text
    .replace(/Authorization:\s*[^\r\n]+/gi, 'Authorization: [REDACTED]')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [REDACTED]')
    .replace(/\b(sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,})\b/g, '[REDACTED_TOKEN]')
    .replace(/\b([A-Z0-9_]*(?:API_)?KEY|TOKEN|SECRET|PASSWORD)\s*=\s*\S{12,}/gi, '$1=[REDACTED]')
    .replace(/\b(key|token|secret|password)\s*[:=]\s*\S{20,}/gi, '$1=[REDACTED]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[REDACTED_EMAIL]')
    .replace(ABSOLUTE_PATH_PATTERN, '[PATH]');
}

function clampCharsFromTail(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(-max);
}

export const _internals = {
  MAX_READ_BYTES,
  MAX_HEAD_BYTES,
  MAX_TAIL_BYTES,
  MAX_EXCERPT_LINES,
  MAX_EXCERPT_CHARS,
  BINARY_SNIFF_BYTES,
};
