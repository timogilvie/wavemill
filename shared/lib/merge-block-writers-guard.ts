// allow-merge-block-writer: this file *is* the merge-block guard; its pattern
// table names every forbidden shape. It is auto-excluded from its own scan
// (see invariantPaths); the marker above is defensive.
/**
 * Preflight guard for the one-merge-block-decision invariant (HOK-3316,
 * completing HOK-3181): `deriveMergeLabel()` in shared/lib/merge-labels.ts is
 * the only code that decides whether a PR carries `wm:blocked`.
 *
 * Tend used to keep a private block writer (`releaseToBlocked` →
 * `setWavemillBlocked`) and a private clearer (`resolveBlockedLabelReason` /
 * `clearGuardBlockedLabel`) next to the reconciler; the two disagreed every
 * poll on PR #1697. A merge-blocking outcome is now recorded as a fact the
 * reconciler reads (`shared/lib/tend-attempt-fact.ts`), and its PR comment is
 * posted once per condition by the side-effect-ledger-backed
 * `shared/lib/merge-status-comment.ts`.
 *
 * Forbidden outside the invariant source:
 *
 * - any `setWavemillBlocked` call or a `releaseToBlocked` dependency;
 * - a direct `wm:blocked` clear (`removeLabelFromPullRequest(…blocked…)`,
 *   `--remove-label wm:blocked`);
 * - `gh pr comment` outside the merge-status poster. Pre-existing comment
 *   sites (challenge comparison, challenge recovery) are held by a count
 *   ratchet in tools/merge-block-writers-allowlist.txt.
 */
import type { GuardSpec, StructuralMatch } from '../../tools/lib/source-guard.ts';

export const MERGE_BLOCK_WRITERS_GUARD: GuardSpec = {
  name: 'merge-block-writers',
  invariantDocs: ['docs/invariants/merge-labels.md'],
  findingNoun: 'merge-block decision site(s) outside deriveMergeLabel',
  suppressionMarker: 'allow-merge-block-writer',
  allowlistFile: 'tools/merge-block-writers-allowlist.txt',
  invariantPaths: [
    'shared/lib/merge-labels.ts',
    'shared/lib/pr-state-labels.ts',
    'shared/lib/merge-status-comment.ts',
    'shared/lib/merge-block-writers-guard.ts',
  ],
  patterns: [
    {
      name: 'set-wavemill-blocked',
      description: '`setWavemillBlocked` outside the reconciler — record the blocking fact (e.g. writeTendAttemptFact) and let deriveMergeLabel render wm:blocked',
      lang: 'ts',
      re: /\bsetWavemillBlocked\b/,
    },
    {
      name: 'release-to-blocked',
      description: '`releaseToBlocked` — a private wm:blocked writer; release wm:merging only and record the outcome as a fact',
      lang: 'both',
      re: /\breleaseToBlocked\b/,
    },
    {
      name: 'blocked-label-clear',
      description: 'direct `wm:blocked` clear — a private clearer; the reconciler drops wm:blocked once its inputs stop deciding it',
      lang: 'both',
      // allow-side-effect-ledger: pattern text naming the forbidden clear, not a label write
      re: /removeLabelFromPullRequest\([^)]*(?:WM_LABELS\.blocked|['"`]wm:blocked['"`])|--remove-label[\s=]+["']?wm:blocked/,
    },
    {
      name: 'gh-pr-comment',
      description: '`gh pr comment` outside shared/lib/merge-status-comment.ts — post through postMergeStatusComment (one standing comment, one write per condition)',
      lang: 'both',
      re: /\bgh\s+pr\s+comment\b|\[\s*['"]pr['"]\s*,\s*['"]comment['"]/,
    },
  ],
  remediation: [
    'deriveMergeLabel() (shared/lib/merge-labels.ts) is the only decider of wm:blocked (HOK-3316).',
    'Record a merge-blocking outcome as a condition-keyed fact it reads, never as a label write or clear,',
    'and post PR comments through postMergeStatusComment (shared/lib/merge-status-comment.ts).',
  ],
};

/**
 * One write scope (HOK-3449): the reconciler's only label writer is
 * `setMergeLabel`, and it changes only `wm:ready` / `wm:blocked`.
 *
 * Separate from {@link MERGE_BLOCK_WRITERS_GUARD} because `merge-labels.ts` is
 * an invariant path of that guard and is therefore never scanned by it. Here
 * the scoped patterns target `merge-labels.ts` directly; the structural check
 * holds the writer itself (`pr-state-labels.ts`) to the two-label scope.
 */
export const RECONCILER_LABEL_SCOPE_GUARD: GuardSpec = {
  name: 'reconciler-label-scope',
  invariantDocs: ['docs/invariants/merge-labels.md'],
  findingNoun: 'reconciler write(s) outside wm:ready / wm:blocked',
  suppressionMarker: 'allow-reconciler-label-write',
  allowlistFile: 'tools/reconciler-label-scope-allowlist.txt',
  invariantPaths: ['shared/lib/merge-block-writers-guard.ts'],
  patterns: [
    {
      name: 'reconciler-label-helper',
      description: 'a label helper other than setMergeLabel in the reconciler — render the decision through writeMergeLabel',
      lang: 'both',
      scopedPaths: ['shared/lib/merge-labels.ts'],
      re: /\b(setWavemill\w+|addWavemill\w+|clearWavemillState)\b/,
    },
    {
      name: 'reconciler-raw-label-write',
      description: 'a raw label write in the reconciler — route it through setMergeLabel, which only touches wm:ready / wm:blocked',
      lang: 'both',
      scopedPaths: ['shared/lib/merge-labels.ts'],
      re: /\b(addLabelsToPullRequest|removeLabelFromPullRequest|transitionPullRequestLabels)\b|\bgh\s+pr\s+edit\b|--(add|remove)-label/,
    },
    {
      name: 'reconciler-foreign-label',
      description: 'the reconciler names a label outside wm:ready / wm:blocked — check wm:merging through holdsMergeLaneLock and leave other labels to their owners',
      lang: 'ts',
      scopedPaths: ['shared/lib/merge-labels.ts'],
      // allow-reconciler-label-write: pattern text naming the forbidden shapes, not a label write
      re: /\bWM_LABELS\.(?!ready\b|blocked\b)\w+|[`'"](?:wm:(?!ready['"`]|blocked['"`])\w[^`'"]*|wavemill)[`'"]/,
    },
  ],
  structuralChecks: [
    {
      name: 'merge-label-write-scope',
      description: 'setMergeLabel may change only wm:ready / wm:blocked (HOK-3449)',
      paths: ['shared/lib/pr-state-labels.ts'],
      find: findMergeLabelWriteScope,
    },
  ],
  remediation: [
    'The reconciler writes labels only through writeMergeLabel -> setMergeLabel (HOK-3449).',
    'setMergeLabel changes only MERGE_LABEL_WRITE_SCOPE = [WM_LABELS.ready, WM_LABELS.blocked];',
    'wm:merging is read through holdsMergeLaneLock and never written; other labels belong to tend or the operator.',
  ],
};

const SCOPE_DECL = /MERGE_LABEL_WRITE_SCOPE\s*(?::[^=]+)?=\s*(\[[^\]]*\])/;

function lineAt(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}

/** The `setMergeLabel` function body, delimited by its braces. */
function setMergeLabelBody(text: string): { start: number; end: number } | null {
  const start = text.search(/\bexport\s+function\s+setMergeLabel\b/);
  if (start === -1) return null;
  const open = text.indexOf('{', start);
  if (open === -1) return null;
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === '{') depth += 1;
    else if (text[index] === '}') {
      depth -= 1;
      if (depth === 0) return { start, end: index + 1 };
    }
  }
  return null;
}

/** Structural check: the scope constant and the setter body stay within two labels. */
export function findMergeLabelWriteScope(sourceText: string): StructuralMatch[] {
  const findings: StructuralMatch[] = [];
  const declaration = sourceText.search(/\bMERGE_LABEL_WRITE_SCOPE\b/);
  if (declaration === -1) {
    return [{ line: 1, detail: 'MERGE_LABEL_WRITE_SCOPE is missing' }];
  }

  const scope = SCOPE_DECL.exec(sourceText);
  const members = scope
    ? scope[1].replace(/[\s,]/g, '')
    : '';
  if (members !== '[WM_LABELS.ready,WM_LABELS.blocked]'.replace(/[\s,]/g, '')) {
    findings.push({
      line: lineAt(sourceText, declaration),
      detail: 'MERGE_LABEL_WRITE_SCOPE must be exactly [WM_LABELS.ready, WM_LABELS.blocked]',
    });
  }

  const body = setMergeLabelBody(sourceText);
  if (!body) {
    findings.push({ line: lineAt(sourceText, declaration), detail: 'setMergeLabel is missing' });
    return findings;
  }
  const bodyText = sourceText.slice(body.start, body.end);
  const allowedMembers = new Set(['ready', 'blocked', 'merging']);

  for (const match of bodyText.matchAll(/\bWM_LABELS\.(\w+)/g)) {
    if (!allowedMembers.has(match[1])) {
      findings.push({
        line: lineAt(sourceText, body.start + (match.index ?? 0)),
        detail: `setMergeLabel references WM_LABELS.${match[1]}`,
      });
    }
  }

  for (const match of bodyText.matchAll(/['"`](wm:[^'"`]+|wavemill)['"`]/g)) {
    const label = match[1];
    if (label === 'wm:ready' || label === 'wm:blocked' || label === 'wm:merging') continue;
    findings.push({
      line: lineAt(sourceText, body.start + (match.index ?? 0)),
      detail: `setMergeLabel references the label "${label}"`,
    });
  }

  return findings;
}
