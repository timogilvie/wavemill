/**
 * PR state label writers (HOK-3181)
 *
 * Mechanical label mutation helpers. For wm:ready / wm:blocked writes, callers
 * MUST go through the reconciler in shared/lib/merge-labels.ts (see CLAUDE.md
 * for the merge label reconciler invariant). Direct writes of wm:ready /
 * wm:blocked are forbidden outside the reconciler.
 *
 * Lane progression labels (wm:merging, wm:merged, wm:superseded) are OUT OF
 * SCOPE for the reconciler — they are synchronous tend lifecycle transitions,
 * not latched blockers.
 */

import { type PullRequest, addLabelsToPullRequest, getPullRequest, removeLabelFromPullRequest, resolveOwnerRepo } from './github.ts';
import { escapeShellArg, execShellCommand } from './shell-utils.ts';
import { writeMarker, clearMarker, validateMarker, type MarkerHandle, type MarkerValidation, type MarkerPayload } from './transient-marker.ts';
import { join } from 'node:path';

export interface PrStateLabelOptions {
  repo?: string;
  markerRoot?: string;
}

export interface PrLabelWriteArgs {
  headSha?: string;
  reason?: string;
}

export interface LabelInitOptions {
  repo?: string;
}

export interface LabelInitResult {
  repo: string;
  created: string[];
  skipped: string[];
}

export const WM_LABELS = {
  wavemill: 'wavemill',
  ready: 'wm:ready',
  blocked: 'wm:blocked',
  merging: 'wm:merging',
  merged: 'wm:merged',
  superseded: 'wm:superseded',
  risky: 'wm:risky',
  migration: 'wm:migration',
  approved: 'wm:approved',
  wrongBase: 'wm:wrong-base',
  metadataInvalid: 'wm:metadata-invalid',
  migrationRequired: 'wm:migration-required',
  riskAcknowledged: 'wm:risk-acknowledged',
  challengeUnresolved: 'wm:challenge-unresolved',
} as const;

interface GithubLabelDefinition {
  name: string;
  color: string;
  description: string;
}

const WM_LABEL_DEFINITIONS: GithubLabelDefinition[] = [
  { name: WM_LABELS.wavemill, color: '#0075ca', description: 'Managed by Wavemill autonomous integration' },
  { name: WM_LABELS.ready, color: '#0e8a16', description: 'Ready for Wavemill merge' },
  { name: WM_LABELS.blocked, color: '#d93f0b', description: 'Blocked from merging' },
  { name: WM_LABELS.merging, color: '#e4e669', description: 'Wavemill merge in progress' },
  { name: WM_LABELS.merged, color: '#6f42c1', description: 'Merged by Wavemill' },
  { name: WM_LABELS.superseded, color: '#aaaaaa', description: 'Superseded by another branch' },
  { name: WM_LABELS.risky, color: '#ee0701', description: 'High-risk change requiring extra review' },
  { name: WM_LABELS.migration, color: '#f9d0c4', description: 'Contains a database migration' },
  { name: WM_LABELS.approved, color: '#0075ca', description: 'Reviewer approved for merge' },
  { name: WM_LABELS.wrongBase, color: '#b60205', description: 'Targets the wrong base branch for autonomous merge' },
  { name: WM_LABELS.metadataInvalid, color: '#d93f0b', description: 'PR metadata is missing or invalid' },
  { name: WM_LABELS.migrationRequired, color: '#fbca04', description: 'Database migration requires Wavemill migration label' },
  { name: WM_LABELS.riskAcknowledged, color: '#5319e7', description: 'High-risk PR has been explicitly acknowledged' },
  { name: WM_LABELS.challengeUnresolved, color: '#d73a4a', description: 'Challenge-mode PR is missing a resolved comparison pair' },
];

const ACTIVE_STATE_LABELS = [WM_LABELS.ready, WM_LABELS.blocked, WM_LABELS.merging];
const ALL_WM_LABELS = WM_LABEL_DEFINITIONS.map((definition) => definition.name);

export const prStateLabelDeps = {
  getPullRequest,
  addLabelsToPullRequest,
  removeLabelFromPullRequest,
  execShellCommand,
  resolveOwnerRepo,
};

export function initGithubLabels(options: LabelInitOptions = {}): LabelInitResult {
  const repo = options.repo || prStateLabelDeps.resolveOwnerRepo();

  if (!repo) {
    throw new Error('Unable to determine GitHub repository. Pass --repo owner/name or run from a GitHub checkout.');
  }

  const existingLabels = new Set(listRepositoryLabels(repo));
  const created: string[] = [];
  const skipped: string[] = [];

  for (const definition of WM_LABEL_DEFINITIONS) {
    if (existingLabels.has(definition.name)) {
      skipped.push(definition.name);
      continue;
    }

    createRepositoryLabel(repo, definition);
    created.push(definition.name);
  }

  return { repo, created, skipped };
}

export function setWavemillReady(
  prNumber: number | string,
  argsOrOptions: PrLabelWriteArgs | PrStateLabelOptions = {},
  maybeOptions: PrStateLabelOptions = {},
): PullRequest {
  const { args, options } = normalizeWriteArgs(argsOrOptions, maybeOptions);
  return transitionPullRequestLabels(prNumber, [WM_LABELS.ready], [WM_LABELS.blocked, WM_LABELS.merging], args, options);
}

export function setWavemillBlocked(
  prNumber: number | string,
  argsOrOptions: PrLabelWriteArgs | PrStateLabelOptions = {},
  maybeOptions: PrStateLabelOptions = {},
): PullRequest {
  const { args, options } = normalizeWriteArgs(argsOrOptions, maybeOptions);
  return transitionPullRequestLabels(prNumber, [WM_LABELS.blocked], [WM_LABELS.ready, WM_LABELS.merging], args, options);
}

export function setWavemillMerging(
  prNumber: number | string,
  argsOrOptions: PrLabelWriteArgs | PrStateLabelOptions = {},
  maybeOptions: PrStateLabelOptions = {},
): PullRequest {
  const { args, options } = normalizeWriteArgs(argsOrOptions, maybeOptions);
  return transitionPullRequestLabels(prNumber, [WM_LABELS.merging], [WM_LABELS.ready, WM_LABELS.blocked], args, options);
}

export function setWavemillMerged(
  prNumber: number | string,
  argsOrOptions: PrLabelWriteArgs | PrStateLabelOptions = {},
  maybeOptions: PrStateLabelOptions = {},
): PullRequest {
  const { args, options } = normalizeWriteArgs(argsOrOptions, maybeOptions);
  return transitionPullRequestLabels(prNumber, [WM_LABELS.merged], ACTIVE_STATE_LABELS, args, options);
}

export function setWavemillSuperseded(
  prNumber: number | string,
  argsOrOptions: PrLabelWriteArgs | PrStateLabelOptions = {},
  maybeOptions: PrStateLabelOptions = {},
): PullRequest {
  const { args, options } = normalizeWriteArgs(argsOrOptions, maybeOptions);
  return transitionPullRequestLabels(prNumber, [WM_LABELS.superseded], ACTIVE_STATE_LABELS, args, options);
}

export function addWavemillBase(prNumber: number | string, options: PrStateLabelOptions = {}): PullRequest {
  return transitionPullRequestLabels(prNumber, [WM_LABELS.wavemill], [], {}, options);
}

export function addWavemillRisky(prNumber: number | string, options: PrStateLabelOptions = {}): PullRequest {
  return transitionPullRequestLabels(prNumber, [WM_LABELS.risky], [], {}, options);
}

export function addWavemillMigration(prNumber: number | string, options: PrStateLabelOptions = {}): PullRequest {
  return transitionPullRequestLabels(prNumber, [WM_LABELS.migration], [], {}, options);
}

export function addWavemillApproved(prNumber: number | string, options: PrStateLabelOptions = {}): PullRequest {
  return transitionPullRequestLabels(prNumber, [WM_LABELS.approved], [], {}, options);
}

export function clearWavemillState(prNumber: number | string, options: PrStateLabelOptions = {}): PullRequest {
  const pr = prStateLabelDeps.getPullRequest(prNumber, options);
  clearPrStateMarker(pr.number, options.markerRoot);
  return transitionPullRequestLabels(prNumber, [], ALL_WM_LABELS, {}, options, pr);
}

function normalizeWriteArgs(
  argsOrOptions: PrLabelWriteArgs | PrStateLabelOptions,
  maybeOptions: PrStateLabelOptions,
): { args: PrLabelWriteArgs; options: PrStateLabelOptions } {
  if (isPrStateLabelOptions(argsOrOptions)) {
    return { args: {}, options: argsOrOptions };
  }

  return { args: argsOrOptions, options: maybeOptions };
}

function isPrStateLabelOptions(value: PrLabelWriteArgs | PrStateLabelOptions): value is PrStateLabelOptions {
  const keys = Object.keys(value);
  return keys.every((key) => key === 'repo' || key === 'markerRoot');
}

function transitionPullRequestLabels(
  prNumber: number | string,
  labelsToEnsure: string[],
  labelsToClear: string[],
  args: PrLabelWriteArgs,
  options: PrStateLabelOptions,
  initialPr?: PullRequest,
): PullRequest {
  const pr = initialPr ?? prStateLabelDeps.getPullRequest(prNumber, options);
  const existingLabels = new Set(pr.labels.map((label) => label.name));
  const labelsToAdd = labelsToEnsure.filter((label, index, all) => all.indexOf(label) === index && !existingLabels.has(label));
  const labelsToRemove = labelsToClear.filter((label, index, all) => all.indexOf(label) === index && existingLabels.has(label));

  let currentPr = pr;

  for (const label of labelsToRemove) {
    currentPr = prStateLabelDeps.removeLabelFromPullRequest(pr.number, label, options);
  }

  if (labelsToAdd.length > 0) {
    currentPr = prStateLabelDeps.addLabelsToPullRequest(pr.number, labelsToAdd, options);
  }

  const writesTransientState = labelsToEnsure.some((label) => ACTIVE_STATE_LABELS.includes(label));
  const clearsTransientState = labelsToClear.some((label) => ACTIVE_STATE_LABELS.includes(label));

  if (clearsTransientState && !writesTransientState) {
    clearPrStateMarker(pr.number, options.markerRoot);
    return currentPr;
  }

  if (writesTransientState || clearsTransientState || args.headSha) {
    const headSha = args.headSha?.trim() || resolvePullRequestHeadSha(pr, options);
    if (!headSha) {
      return currentPr;
    }
    const activeLabels = currentPr.labels.map((label) => label.name);
    writePrStateMarker(pr.number, {
      headSha,
      reason: args.reason,
      activeLabels,
      markerRoot: options.markerRoot,
    });
  }

  return currentPr;
}

function resolvePullRequestHeadSha(pr: PullRequest, options: PrStateLabelOptions): string {
  const embeddedSha = (pr as PullRequest & { headRefOid?: string }).headRefOid?.trim();
  if (embeddedSha) {
    return embeddedSha;
  }

  try {
    const command = [
      'gh',
      'pr',
      'view',
      escapeShellArg(String(pr.number)),
      '--json',
      'headRefOid',
      '--jq',
      escapeShellArg('.headRefOid'),
      ...(options.repo ? ['--repo', escapeShellArg(options.repo)] : []),
    ].join(' ');
    return prStateLabelDeps.execShellCommand(command, { encoding: 'utf-8' }).trim();
  } catch {
    return '';
  }
}

export async function readPrStateMarker(
  prNumber: number | string,
  args: {
    currentHead: string;
    deriveCondition: (payload: MarkerPayload) => Promise<boolean> | boolean;
    markerRoot?: string;
  },
): Promise<MarkerValidation<boolean>> {
  const markerHandle = getPrStateMarkerHandle(prNumber, args.markerRoot);
  return validateMarker(markerHandle, {
    currentHead: args.currentHead,
    deriveCondition: args.deriveCondition,
  });
}

export function writePrStateMarker(
  prNumber: number | string,
  args: { headSha: string; activeLabels: string[]; reason?: string; markerRoot?: string },
): void {
  writeMarker(getPrStateMarkerHandle(prNumber, args.markerRoot), {
    headSha: args.headSha,
    reason: args.reason,
    detail: { activeLabels: args.activeLabels },
  });
}

export function clearPrStateMarker(prNumber: number | string, markerRoot?: string): void {
  clearMarker(getPrStateMarkerHandle(prNumber, markerRoot));
}

export function getPrStateMarkerHandle(prNumber: number | string, markerRoot = process.cwd()): MarkerHandle {
  return {
    path: join(markerRoot, '.wavemill', 'pr-state', `${prNumber}.json`),
    kind: 'pr-label',
  };
}

function listRepositoryLabels(repo: string): string[] {
  const output = prStateLabelDeps.execShellCommand(
    `gh api --paginate ${escapeShellArg(`repos/${repo}/labels`)} --jq '.[].name'`,
    { encoding: 'utf-8' },
  ).trim();

  if (!output) {
    return [];
  }

  return output
    .split('\n')
    .map((label) => label.trim())
    .filter((label) => label.length > 0);
}

function createRepositoryLabel(repo: string, definition: GithubLabelDefinition): void {
  const color = definition.color.replace(/^#/, '');
  prStateLabelDeps.execShellCommand(
    [
      'gh',
      'api',
      '--method',
      'POST',
      escapeShellArg(`repos/${repo}/labels`),
      '-f',
      `name=${escapeShellArg(definition.name)}`,
      '-f',
      `color=${escapeShellArg(color)}`,
      '-f',
      `description=${escapeShellArg(definition.description)}`,
    ].join(' '),
    { encoding: 'utf-8' },
  );
}
