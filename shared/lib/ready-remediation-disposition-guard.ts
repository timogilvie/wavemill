// allow-ready-remediation-disposition: this is the invariant definition.
// allow-stage-agent-disposition: this guard definition carries the stage-agent patterns.
import type { GuardSpec, StructuralMatch } from '../../tools/lib/source-guard.ts';

// Settlement fields a private stage-agent in-flight decision reads. The
// task-progress primitive's own answer, `.agentBackgroundLive` (HOK-3101), is
// deliberately absent: reading it directly is the approved primitive read
// (blocked-completion handling in wavemill-monitor.sh does exactly that).
const SETTLEMENT_FIELD = /\.(?:agentIdle|stalled|agentProcessLive|terminalIdle|terminal|agentRecord\.state)\b/;
// One-line form, reported by the `private-task-progress-jq-filter` pattern.
const SINGLE_LINE_JQ_FILTER = /jq\s+-e[^\n]*\.(?:agentIdle|stalled|agentRecord\.state|terminal|agentProcessLive)\b/;

/**
 * The filter text a `jq -e` call actually evaluates: its quoted arguments (a
 * quoted filter may span lines) and, when it reads a program from a heredoc,
 * that heredoc body. Unquoted words, redirections and anything after the
 * command ends are not filter text, so a settlement field that merely appears
 * near a `jq -e` (a log line, another command) is not mistaken for one.
 */
function jqFilterText(source: string, start: number): string {
  const parts: string[] = [];
  let i = start;
  let heredocTag: string | null = null;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "'" || ch === '"') {
      const close = source.indexOf(ch, i + 1);
      if (close < 0) break;
      parts.push(source.slice(i + 1, close));
      i = close + 1;
      continue;
    }
    if (ch === '\n' || ch === ';' || ch === '|' || ch === ')' || ch === '&') break;
    if (source.startsWith('<<<', i)) { i += 3; continue; } // here-string input, not a heredoc program
    if (source.startsWith('<<', i)) {
      const tag = /^<<-?\s*['"]?(\w+)['"]?/.exec(source.slice(i));
      if (tag) { heredocTag = tag[1]; i += tag[0].length; continue; }
    }
    i += 1;
  }
  if (heredocTag) {
    const bodyStart = source.indexOf('\n', i);
    if (bodyStart >= 0) {
      const terminator = new RegExp(`^\\s*${heredocTag}\\s*$`, 'm');
      const rest = source.slice(bodyStart + 1);
      const end = terminator.exec(rest);
      parts.push(end ? rest.slice(0, end.index) : rest);
    }
  }
  return parts.join('\n');
}

function findSplitProgressPredicate(source: string): StructuralMatch[] {
  const lines = source.split(/\r?\n/);
  const lineStarts: number[] = [];
  for (let i = 0, offset = 0; i < lines.length; i += 1) {
    lineStarts.push(offset);
    offset += lines[i].length + 1;
  }
  const matches: StructuralMatch[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const jq = /\bjq\s+-e\b/.exec(lines[i]);
    if (!jq) continue;
    const filter = jqFilterText(source, lineStarts[i] + jq.index + jq[0].length);
    // A single-line filter is already reported by `private-task-progress-jq-filter`.
    if (!filter.includes('\n') && SINGLE_LINE_JQ_FILTER.test(lines[i])) continue;
    if (!SETTLEMENT_FIELD.test(filter)) continue;
    const context = lines.slice(Math.max(0, i - 15), i + 1).join('\n');
    if (/task_progress_json/.test(context) || /task_progress_json/.test(filter)) {
      matches.push({ line: i + 1, detail: 'split-line or heredoc task-progress settlement predicate' });
    }
  }
  return matches;
}

/**
 * HOK-3322 + HOK-3386: "is a stage's agent still in flight, or has it settled
 * without a result?" is decided only by:
 *
 *   - shared/lib/stage-agent-disposition.ts (the one generalised decision)
 *   - shell: ready_remediation_disposition, stage_agent_disposition
 *
 * The HOK-3386 patterns catch private re-derivation over `task_progress_json`
 * output and private stage-launch-identity reads outside `readStageAgentLaunch`.
 */
export const READY_REMEDIATION_DISPOSITION_GUARD: GuardSpec = {
  name: 'ready-remediation-disposition',
  invariantDocs: [
    'docs/invariants/ready-remediation-disposition.md',
    'docs/invariants/stage-agent-disposition.md',
  ],
  findingNoun: 'private stage-agent / Ready in-flight decision(s)',
  suppressionMarker: 'allow-ready-remediation-disposition',
  allowlistFile: 'tools/ready-remediation-disposition-allowlist.txt',
  invariantPaths: [
    'shared/lib/ready-remediation-disposition-guard.ts',
    'shared/lib/stage-agent-disposition.ts',
    'shared/lib/stage-agent-disposition.test.ts',
    'tools/stage-agent-disposition.ts', // install-paths: allow invariant-path list entry, not an argv/exec literal
  ],
  patterns: [
    // ── HOK-3322: Ready remediation specific ─────────────────────────────
    { name: 'same-head-hold', lang: 'sh',
      re: /\$\{?\w*launch_head\}?"?\s*[!=]=\s*"?\$\{?\w*current_head|\$\{?\w*current_head\}?"?\s*[!=]=\s*"?\$\{?\w*launch_head/,
      description: 'Comparing a remediation launch head with HEAD is the retired same-head hold; read ready_remediation_disposition.' },
    { name: 'retired-shell-predicate', lang: 'sh', re: /\b(?:ready_remediation_launch_head|conflict_remediation_in_flight)\b/,
      description: 'Retired private in-flight predicate; call ready_remediation_disposition.' },
    { name: 'private-launch-identity', lang: 'sh', re: /\.detail\.launchHead\b|bounded_retry_head\b[^#]*ready-remediation/,
      description: 'Remediation launch identity is read only by readReadyRemediationLaunch.' },
    { name: 'launch-head-equality', lang: 'ts',
      re: /\b(?:remediationLaunchHead|launchHead)\s*[!=]==|[!=]==\s*[\w.?]*\b(?:remediationLaunchHead|launchHead)\b/,
      description: 'Comparing a remediation launch head with HEAD re-derives in-flight; read the ReadyRemediationDisposition.' },
    { name: 'pane-activity-in-flight', lang: 'ts', re: /\bremediationPaneActive\b/,
      description: 'Pane activity is not liveness (HOK-3101); read the ReadyRemediationDisposition.' },
    { name: 'private-launch-bucket', lang: 'ts', re: /createStateDirRetry\(\s*['"]ready-remediation['"]/,
      description: 'The ready-remediation bucket head is launch identity; read it through readReadyRemediationLaunch.' },
    // ── HOK-3386: stage-agent disposition ────────────────────────────────
    // Patterns run one line at a time; multi-line filters and heredoc
    // programs are the structural check below.
    { name: 'private-task-progress-jq-filter', lang: 'sh',
      re: SINGLE_LINE_JQ_FILTER,
      description: 'Private jq filter over task_progress_json output; consume stage_agent_disposition instead (HOK-3386).' },
    { name: 'retired-coding-stage-stalled', lang: 'sh', re: /\bcoding_stage_stalled\b/,
      description: 'coding_stage_stalled was retired by HOK-3386; the shared stage-agent disposition owns the decision.' },
  ],
  structuralChecks: [
    {
      name: 'split-private-task-progress-jq-filter',
      description: 'Split-line and heredoc task-progress predicates must consume stage_agent_disposition',
      find: findSplitProgressPredicate,
    },
  ],
  remediation: [
    'Ready remediation in-flight/completion is the stage-agent decision (HOK-3322, HOK-3386):',
    '  TS: evaluateReadyRemediationDisposition (shared/lib/stage-agent-disposition.ts) — Ready launch identity and prompt mapping over the shared disposition',
    '  shell: ready_remediation_disposition <issue> <state_dir> <wt_dir> <current_head>',
    'Per-stage agent in-flight/settled decision (HOK-3386):',
    '  TS: evaluateStageAgentDisposition / decideStageAgentDisposition (shared/lib/stage-agent-disposition.ts)',
    '  shell: stage_agent_disposition <issue> <state_dir> <wt_dir> <current_head> <stage>',
  ],
};
