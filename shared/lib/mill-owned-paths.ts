/** The sole inventory of paths written by Wavemill inside a task worktree. */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type MillOwnedDisposition = 'evidence' | 'telemetry' | 'runtime';
export interface MillOwnedPath { pattern: string; disposition: MillOwnedDisposition; destination?: string; gitignore?: boolean }
/** Stable evidence basenames consumed by taskEvidenceNames and archived before reap. */
export const TASK_EVIDENCE_NAMES = ['plan.md', 'task-packet.md', 'task-packet-header.md', 'task-packet-details.md',
  '.routing-complete', '.initial-route.json', '.post-expansion-route.json', 'routing.jsonl', '.coding-uncommitted-output.resolved.jsonl', '.operator-intervention.json', '.terminal-history.jsonl', '.operator-events.jsonl', '.session-ownership.jsonl', '.head-moves.jsonl', '.recovery-actions.jsonl', '.challenge-aborted.json', '.coding-failure-handoff.json', 'trace.jsonl', '.planning-result.json', '.coding-result.json', '.review-result.json', '.ready-result.json'] as const;

export const MILL_OWNED_PATHS: readonly MillOwnedPath[] = [
  { pattern: '.wavemill/observer-findings.jsonl', disposition: 'telemetry', destination: '.wavemill/observer-findings.jsonl', gitignore: true }, { pattern: '.wavemill/task-size-estimates.jsonl', disposition: 'telemetry', destination: '.wavemill/task-size-estimates.jsonl', gitignore: true }, { pattern: '.wavemill/evals/prompt-registry.jsonl', disposition: 'telemetry', destination: '.wavemill/evals/prompt-registry.jsonl', gitignore: true },
  { pattern: 'prompt-registry.jsonl', disposition: 'telemetry', destination: '.wavemill/evals/prompt-registry.jsonl' },
  // Existing eval output is disposable runtime state; the registry row above
  // wins first so its telemetry destination remains explicit.
  { pattern: '.wavemill/evals/**', disposition: 'runtime', gitignore: true },
  { pattern: '.wavemill/audits/**', disposition: 'runtime', gitignore: true },
  ...TASK_EVIDENCE_NAMES.map(pattern => ({ pattern: `features/*/${pattern}`, disposition: 'evidence' as const })), { pattern: 'features/*/.*-result.attempt-*.json', disposition: 'evidence' }, { pattern: 'features/*/.*', disposition: 'runtime' },
  ...['.needs-attention','.ready-bypass-warned','.coding-complete','.workflow-aborted','.coding-blocked-completion.json','.condition-reconcile.jsonl','.ready-waiting-on.json','.challenge-intent.json','challenge-intent.json','selected-task.json','.phase-config.json','.coding-uncommitted-output*','.coding-recovery-instruction.md','.blocked-completion-announced','.retry-coding-dirty-handoff-*','.plan-approved','.stale-artifacts/**','ready-checked-head','.*/**'].map(pattern => ({ pattern: `features/*/${pattern}`, disposition: 'runtime' as const })),
  { pattern: '.claude/settings.local.json', disposition: 'runtime' }, { pattern: '.wavemill-config.local.json', disposition: 'runtime' },
  ...['.wavemill/workflow-state.json','.wavemill/native-status.json','.wavemill/quota-state.json','.wavemill/quota-state.lock','.wavemill/project-context.md','.wavemill/merge-queue-selection.json','.wavemill/cache/**','.wavemill/logs/**','.wavemill/hokusai/**','.wavemill/state/**','.wavemill/locks/**','.wavemill/runs/**','.wavemill/session-events/**','.wavemill/artifacts/**','.wavemill/tool-decisions/**','.wavemill/merge-retry/**','.wavemill/runtime-env/**','.wavemill/linear-retry-drain.last-run','.wavemill/workflow-state.json.bak-*','.wavemill/ledger.sqlite*'].map(pattern => ({ pattern, disposition: 'runtime' as const, gitignore: true })),
] as const;

function globRegex(pattern: string): RegExp {
  if (pattern.endsWith('/**')) return new RegExp(`^${globRegex(pattern.slice(0, -3)).source.slice(1, -1)}(?:/.*)?$`);
  return new RegExp(`^${pattern.split('/').map(segment => segment === '**' ? '.*' : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '[^/]*')).join('/')}$`);
}
export function millOwnedEntry(path: string): MillOwnedPath | undefined {
  const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '');
  if (normalized.split('/').includes('..')) return undefined;
  return MILL_OWNED_PATHS.find(entry => globRegex(entry.pattern).test(normalized));
}
export function isMillOwnedDirtyLine(line: string): boolean {
  // Only untracked or ignored owned outputs may disappear from the dirty decision.
  // Every tracked change remains task work, regardless of its path.
  const match = /^([ MADRCU?!]{2}) (.+)$/.exec(line);
  return !!match && (match[1] === '??' || match[1] === '!!') && !!millOwnedEntry(match[2]);
}
export function filterMillOwnedDirtyStatus(raw: string): string[] {
  return raw.split('\n').filter(Boolean).filter(line => !isMillOwnedDirtyLine(line));
}

export function renderMillOwnedShell(): string {
  const rows = MILL_OWNED_PATHS.map(entry => `${entry.pattern}|${entry.destination ?? ''}`).join(' ');
  const arg = '$' + '{1:-}';
  const normalizedArg = '$' + '{1#./}';
  const status = '$' + '{1:0:2}';
  const linePath = '$' + '{1:3}';
  const extractedPath = '$' + '{line:3}';
  const telemetryPath = '$' + '{telemetry_path#"$wt_dir"/}';
  const repo = '$' + '{REPO_DIR:-}';
  const repoValue = '$' + '{REPO_DIR}';
  const observer = MILL_OWNED_PATHS.find(e => e.pattern === '.wavemill/observer-findings.jsonl')!.pattern;
  return `# Generated by tools/check-mill-owned-paths.ts from mill-owned-paths.ts.\n`+
`MILL_OWNED_PATH_ROWS='${rows}'\n`+
`WAVEMILL_CONTROLLER_OBSERVER_ARTIFACT="${observer}"\n`+
`wavemill_mill_owned_path() { local path="${normalizedArg}" row pattern destination tail; for row in $MILL_OWNED_PATH_ROWS; do IFS='|' read -r pattern destination <<< "$row"; if [[ "$pattern" == features/* ]]; then tail="${'$'}{path#features/}"; [[ "$tail" == */* ]] || continue; tail="${'$'}{tail#*/}"; [[ "$tail" != */* || "$pattern" == *'/**' ]] || continue; case "$tail" in ${'$'}{pattern#features/*/}) return 0 ;; esac; continue; fi; case "$path" in $pattern) return 0 ;; esac; done; return 1; }\n`+
`wavemill_mill_owned_telemetry_destination() { local path="${arg}" row pattern destination; for row in $MILL_OWNED_PATH_ROWS; do IFS='|' read -r pattern destination <<< "$row"; if [[ "$path" == "$pattern" && -n "$destination" ]]; then printf '%s\n' "$destination"; return 0; fi; done; return 1; }\n`+
`wavemill_mill_owned_dirty_line() { [[ "${status}" == '??' || "${status}" == '!!' ]] && wavemill_mill_owned_path "${linePath}"; }\n`+
`wavemill_worktree_dirty_status() { local wt_dir="${arg}" raw_status line; raw_status="$(git -C "$wt_dir" status --porcelain --untracked-files=all 2>/dev/null)" || return 1; while IFS= read -r line; do [[ -z "$line" ]] && continue; wavemill_mill_owned_dirty_line "$line" || printf '%s\n' "$line"; done <<< "$raw_status"; }\n`+
`wavemill_discard_mill_owned_untracked() { local wt_dir="${arg}" line path destination telemetry_path migration_failed; [[ -n "$wt_dir" && -d "$wt_dir" ]] || return 0; while IFS= read -r line; do wavemill_mill_owned_dirty_line "$line" || continue; path="${extractedPath}"; [[ "$path" != /* && "$path" != *../* ]] || continue; git -C "$wt_dir" ls-files --error-unmatch -- "$path" >/dev/null 2>&1 && continue; migration_failed=false; if [[ -d "$wt_dir/$path" ]]; then while IFS= read -r -d '' telemetry_path; do destination="$(wavemill_mill_owned_telemetry_destination "${telemetryPath}" 2>/dev/null || true)"; [[ -z "$destination" ]] && continue; if [[ -z "${repo}" || ! -d "${repo}" ]] || ! mkdir -p "${repoValue}/$(dirname "$destination")" || ! cat "$telemetry_path" >> "${repoValue}/$destination"; then printf '[warn] mill-owned: could not migrate %s to %s\\n' "${telemetryPath}" "${repoValue}/$destination" >&2; migration_failed=true; fi; done < <(find "$wt_dir/$path" -type f -print0); fi; destination="$(wavemill_mill_owned_telemetry_destination "$path" 2>/dev/null || true)"; if [[ -n "$destination" ]] && { [[ -z "${repo}" || ! -d "${repo}" ]] || ! mkdir -p "${repoValue}/$(dirname "$destination")" || ! cat "$wt_dir/$path" >> "${repoValue}/$destination"; }; then printf '[warn] mill-owned: could not migrate %s to %s\\n' "$path" "${repoValue}/$destination" >&2; migration_failed=true; fi; [[ "$migration_failed" == true ]] && continue; rm -rf -- "$wt_dir/$path" 2>/dev/null || return 1; done < <(git -C "$wt_dir" status --porcelain --untracked-files=all --ignored=traditional); }\n`;
}
export function renderMillOwnedGitignore(): string {
  return MILL_OWNED_PATHS.filter(e => e.gitignore).map(e => e.pattern.replace(/\*\*$/, '')).join('\n') + '\n';
}
export function updateMillOwnedGeneratedFiles(repoDir: string): void {
  writeFileSync(join(repoDir, 'shared/lib/mill-owned-paths.sh'), renderMillOwnedShell()); // install-paths: allow generated Bash twin
  const file = join(repoDir, '.gitignore');
  const source = readFileSync(file, 'utf8');
  const block = `# BEGIN GENERATED MILL-OWNED PATHS\n${renderMillOwnedGitignore()}# END GENERATED MILL-OWNED PATHS`;
  const next = /# BEGIN GENERATED MILL-OWNED PATHS[\s\S]*?# END GENERATED MILL-OWNED PATHS/.test(source)
    ? source.replace(/# BEGIN GENERATED MILL-OWNED PATHS[\s\S]*?# END GENERATED MILL-OWNED PATHS/, block)
    : `${source.trimEnd()}\n\n${block}\n`;
  writeFileSync(file, next);
}
