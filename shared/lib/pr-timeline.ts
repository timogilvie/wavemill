/**
 * HOK-3182 — GitHub PR timeline reader for the reliability report.
 *
 * One paginated `gh api …/issues/<pr>/timeline` call per PR yields every
 * GitHub-side touch source the report needs: label edits, the merge event,
 * and the commits pushed to the branch. Timelines of merged/closed PRs are
 * final, so they are cached under `.wavemill/cache/pr-timeline/` and repeat
 * reports make no network calls for them.
 *
 * @module pr-timeline
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

import { resolveOwnerRepo } from './github.ts';
import { errorMessage } from './error-utils.ts';

export type PrTimelineEventName =
  | 'labeled'
  | 'unlabeled'
  | 'merged'
  | 'closed'
  | 'committed'
  | 'head_ref_force_pushed';

export interface PrTimelineEvent {
  event: PrTimelineEventName;
  at: string;
  actor?: string | null;
  label?: string | null;
  sha?: string | null;
  message?: string | null;
  author?: string | null;
}

const TIMELINE_JQ = '.[] | select(.event == "labeled" or .event == "unlabeled" or .event == "merged"'
  + ' or .event == "closed" or .event == "committed" or .event == "head_ref_force_pushed")'
  + ' | {event, at: (.created_at // .author.date // .committer.date), actor: (.actor.login // null),'
  + ' label: (.label.name // null), sha: (.sha // null), message: (.message // null), author: (.author.name // null)}';

/** Runs `gh` with the given args and returns stdout. Injectable for tests. */
export type GhRunner = (args: string[], cwd: string) => string;

const defaultGhRunner: GhRunner = (args, cwd) => execFileSync('gh', args, {
  cwd,
  encoding: 'utf-8',
  timeout: 30_000,
  stdio: ['ignore', 'pipe', 'ignore'],
  maxBuffer: 16 * 1024 * 1024,
});

export interface FetchPrTimelineOptions {
  repoDir: string;
  nwo?: string;
  gh?: GhRunner;
  /** Cache directory; defaults to `<repoDir>/.wavemill/cache/pr-timeline`. Pass `null` to disable. */
  cacheDir?: string | null;
}

export function prTimelineCacheDir(repoDir: string): string {
  return join(resolve(repoDir), '.wavemill', 'cache', 'pr-timeline');
}

/** Parse the newline-delimited objects `gh api --paginate --jq` prints. */
export function parsePrTimelineOutput(raw: string): PrTimelineEvent[] {
  const events: PrTimelineEvent[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as PrTimelineEvent;
      if (parsed && typeof parsed.event === 'string' && typeof parsed.at === 'string') events.push(parsed);
    } catch {
      continue;
    }
  }
  return events;
}

function isFinal(events: PrTimelineEvent[]): boolean {
  return events.some((e) => e.event === 'merged' || e.event === 'closed');
}

/**
 * Fetch a PR's timeline (cached once the PR is merged or closed). Returns
 * `null` when GitHub is unreachable or the repo cannot be resolved, so the
 * caller can report the gap instead of counting zero touches.
 */
export function fetchPrTimeline(prNumber: string | number, opts: FetchPrTimelineOptions): PrTimelineEvent[] | null {
  const pr = String(prNumber);
  const cacheDir = opts.cacheDir === undefined ? prTimelineCacheDir(opts.repoDir) : opts.cacheDir;
  const cachePath = cacheDir ? join(cacheDir, `${pr}.json`) : null;
  if (cachePath && existsSync(cachePath)) {
    try {
      const cached = JSON.parse(readFileSync(cachePath, 'utf-8')) as PrTimelineEvent[];
      if (Array.isArray(cached)) return cached;
    } catch {
      // Fall through to a fresh fetch.
    }
  }

  const nwo = opts.nwo ?? resolveOwnerRepo(opts.repoDir);
  if (!nwo) return null;
  let events: PrTimelineEvent[];
  try {
    const raw = (opts.gh ?? defaultGhRunner)(
      ['api', `repos/${nwo}/issues/${pr}/timeline`, '--paginate', '--jq', TIMELINE_JQ],
      opts.repoDir,
    );
    events = parsePrTimelineOutput(raw);
  } catch (err) {
    console.warn(`[pr-timeline] Failed to fetch timeline for PR #${pr}: ${errorMessage(err)}`);
    return null;
  }

  if (cachePath && isFinal(events)) {
    try {
      mkdirSync(cacheDir!, { recursive: true });
      const tmp = `${cachePath}.tmp.${process.pid}`;
      writeFileSync(tmp, JSON.stringify(events));
      renameSync(tmp, cachePath);
    } catch {
      // Cache is an optimisation only.
    }
  }
  return events;
}
