/**
 * HOK-3128 dirty-handoff recovery guard (HOK-3145 enforcement).
 *
 * When wavemill's monitor relaunches the coding agent after a dirty tree with
 * ".coding-recovery-instruction.md" present, this guard restricts the model's
 * tool menu to: read tools (so it can inspect what's dirty), git_add/git_commit
 * on the listed paths, `run_tests` constrained to `git checkout`/`git restore`
 * on those paths (there is no git_checkout tool yet), the completion marker,
 * and status updates. Any other tool call is denied with a reason that names
 * the two legitimate paths out.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export interface CodingRecoveryGuard {
  dirtyPaths: string[];
  featureDir: string;
  worktreePath: string;
  evaluate(call: { name: string; args: Record<string, unknown> }): { allow: true } | { allow: false; reason: string };
}

/** Read tools, status, and the completion marker — never deny these. */
const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'read_file',
  'list_files',
  'search_text',
  'git_status',
  'git_diff',
  'git_diff_stat',
  'git_log',
  'update_status',
  'code_search',
  'ast_find',
]);

/** Commit-side tools: always allowed; `git_add` paths are checked below. */
const COMMIT_ALLOWED_TOOLS: ReadonlySet<string> = new Set(['git_commit', 'git_add']);

/** Allow-list used in the system prompt. */
export const RECOVERY_MODE_ALLOWED_TOOLS: readonly string[] = [
  'read_file', 'list_files', 'search_text', 'git_status', 'git_diff',
  'git_diff_stat', 'git_log', 'git_add', 'git_commit', 'run_tests',
  'create_marker', 'write_artifact', 'update_status',
];

const RECOVERY_INSTRUCTION_FILE = '.coding-recovery-instruction.md';

function denialReason(toolName: string): string {
  return (
    `recovery_mode_denied: ${toolName} is not allowed during dirty-handoff recovery. `
    + 'Commit (git_add + git_commit) or discard (run_tests "git checkout -- <path>") each listed path, '
    + 'then create_marker .coding-complete.'
  );
}

function normalizePath(raw: string): string {
  let p = raw.trim();
  if (p.startsWith('./')) p = p.slice(2);
  p = path.posix.normalize(p);
  return p;
}

function parseDirtyPaths(contents: string): string[] {
  const paths: string[] = [];
  const re = /^- `([^`]+)`$/;
  for (const line of contents.split(/\r?\n/)) {
    const match = re.exec(line.trim());
    if (match && match[1]) {
      paths.push(normalizePath(match[1]));
    }
  }
  return paths;
}

export function readCodingRecoveryGuard(
  featureDir: string,
  worktreePath: string,
): CodingRecoveryGuard | null {
  const instructionPath = path.join(featureDir, RECOVERY_INSTRUCTION_FILE);
  if (!existsSync(instructionPath)) return null;
  let contents: string;
  try {
    contents = readFileSync(instructionPath, 'utf-8');
  } catch {
    return null;
  }
  const dirtyPaths = parseDirtyPaths(contents);
  return buildGuard({ featureDir, worktreePath, dirtyPaths });
}

export function buildGuard(input: {
  featureDir: string;
  worktreePath: string;
  dirtyPaths: readonly string[];
}): CodingRecoveryGuard {
  const dirty = [...input.dirtyPaths];
  const dirtySet = new Set(dirty);
  const featureDir = input.featureDir;
  const worktreePath = input.worktreePath;

  const resolveWorktreeRelative = (candidate: string): string | null => {
    const abs = path.isAbsolute(candidate) ? candidate : path.resolve(worktreePath, candidate);
    const rel = path.relative(worktreePath, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return rel.split(path.sep).join('/');
  };

  const isCompletionMarkerPath = (rawPath: string): boolean => {
    const rel = resolveWorktreeRelative(rawPath);
    if (!rel) return false;
    const abs = path.resolve(worktreePath, rel);
    const featureRel = path.relative(worktreePath, featureDir).split(path.sep).join('/');
    const completionCandidates = [
      path.join(featureDir, '.coding-complete'),
      path.join(featureDir, '.coding-blocked-completion.json'),
    ].map((p) => path.resolve(p));
    if (completionCandidates.includes(abs)) return true;
    const relativeNames = [
      `${featureRel}/.coding-complete`,
      `${featureRel}/.coding-blocked-completion.json`,
    ];
    return relativeNames.includes(rel);
  };

  const pathsFromArgs = (args: Record<string, unknown>, field: string): string[] => {
    const value = args[field];
    if (Array.isArray(value)) {
      return value.filter((v): v is string => typeof v === 'string');
    }
    if (typeof value === 'string') return [value];
    return [];
  };

  const everyPathAllowed = (paths: readonly string[]): boolean => {
    if (dirty.length === 0) return false;
    if (paths.length === 0) return false;
    return paths.every((p) => dirtySet.has(normalizePath(p)));
  };

  const parseRunTestsArgv = (command: unknown): string[] | null => {
    if (typeof command !== 'string') return null;
    const trimmed = command.trim();
    if (!trimmed) return null;
    // Minimal argv split: whitespace, respecting double quotes.
    const argv: string[] = [];
    let cur = '';
    let inQuote: '"' | "'" | null = null;
    for (const ch of trimmed) {
      if (inQuote) {
        if (ch === inQuote) { inQuote = null; continue; }
        cur += ch;
        continue;
      }
      if (ch === '"' || ch === "'") { inQuote = ch; continue; }
      if (ch === ' ' || ch === '\t') {
        if (cur) { argv.push(cur); cur = ''; }
        continue;
      }
      cur += ch;
    }
    if (cur) argv.push(cur);
    return argv;
  };

  const isGitDiscardCommand = (argv: readonly string[]): { ok: boolean; paths: string[] } => {
    if (argv[0] !== 'git') return { ok: false, paths: [] };
    const sub = argv[1];
    if (sub !== 'checkout' && sub !== 'restore') return { ok: false, paths: [] };
    const paths: string[] = [];
    let seenDashDash = false;
    let i = 2;
    for (; i < argv.length; i += 1) {
      const token = argv[i]!;
      if (token === '--') { seenDashDash = true; i += 1; break; }
      // Allow a handful of safe git-restore flags.
      if (token === '--staged' || token === '--worktree' || token === '--source' || token === '-s') {
        if (token === '--source' || token === '-s') { i += 1; }
        continue;
      }
      if (token.startsWith('-')) {
        // Unknown flag → deny.
        return { ok: false, paths: [] };
      }
      paths.push(token);
    }
    if (seenDashDash) {
      for (; i < argv.length; i += 1) {
        paths.push(argv[i]!);
      }
    }
    return { ok: paths.length > 0, paths };
  };

  return {
    dirtyPaths: dirty,
    featureDir,
    worktreePath,
    evaluate(call) {
      const name = call.name;
      const args = (call.args ?? {}) as Record<string, unknown>;

      if (READ_ONLY_TOOLS.has(name)) return { allow: true };

      if (COMMIT_ALLOWED_TOOLS.has(name)) {
        if (name === 'git_add') {
          const paths = pathsFromArgs(args, 'paths');
          const singlePath = pathsFromArgs(args, 'path');
          const effective = paths.length > 0 ? paths : singlePath;
          if (dirty.length === 0) {
            // Instruction had no parseable bullets — still allow `git_add -A`-like commits.
            return { allow: true };
          }
          if (!everyPathAllowed(effective)) {
            return {
              allow: false,
              reason: `recovery_mode_denied: git_add paths must be in the recovery list. Allowed: ${dirty.join(', ')}.`,
            };
          }
          return { allow: true };
        }
        return { allow: true };
      }

      if (name === 'run_tests') {
        const argv = parseRunTestsArgv(args.command);
        if (!argv) {
          return { allow: false, reason: denialReason('run_tests') };
        }
        const parsed = isGitDiscardCommand(argv);
        if (!parsed.ok) {
          return {
            allow: false,
            reason:
              `recovery_mode_denied: run_tests is restricted to \`git checkout -- <path>\` or `
              + `\`git restore [--staged] [--] <path>\` during dirty-handoff recovery.`,
          };
        }
        if (dirty.length === 0) return { allow: true };
        if (!parsed.paths.every((p) => dirtySet.has(normalizePath(p)))) {
          return {
            allow: false,
            reason:
              `recovery_mode_denied: discard target must be a listed path. `
              + `Allowed: ${dirty.join(', ')}.`,
          };
        }
        return { allow: true };
      }

      if (name === 'create_marker' || name === 'write_artifact') {
        const rawPath = typeof args.path === 'string' ? args.path : '';
        if (!rawPath) return { allow: false, reason: denialReason(name) };
        if (isCompletionMarkerPath(rawPath)) return { allow: true };
        return {
          allow: false,
          reason:
            `recovery_mode_denied: ${name} is only allowed for `
            + `.coding-complete or .coding-blocked-completion.json during recovery.`,
        };
      }

      return { allow: false, reason: denialReason(name) };
    },
  };
}
