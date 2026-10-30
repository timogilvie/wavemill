// allow-stage-artifact-lookup: this file *is* the stage-artifact-lookup
// guard spec; it necessarily contains every forbidden shape as a literal. The
// invariant source list auto-excludes it from its own scan.
/**
 * Preflight guard (HOK-2891): every reader of stage results and sibling
 * route/intervention artifacts goes through the one lookup in
 * `shared/lib/task-artifact-lookup.ts` / `shared/lib/stage-result.ts`, so a
 * new reader cannot drift back to a private live→archive fallback.
 */
import {
  type GuardPattern,
  type GuardSpec,
} from '../../tools/lib/source-guard.ts';

const PATTERNS: GuardPattern[] = [
  // --- Stage-result path join outside invariant source ---------------------
  {
    name: 'ts-dot-stage-result',
    description:
      'inline `.<stage>-result.json` literal — read through readStageResult/resolveTaskArtifact',
    lang: 'ts',
    re: /['"`]\.(planning|coding|review|ready)-result\.json['"`]/,
  },
  {
    name: 'sh-dot-stage-result',
    description:
      'inline `.<stage>-result.json` literal — resolve via resolve_stage_artifact_path',
    lang: 'sh',
    re: /\.(planning|coding|review|ready)-result\.json\b/,
  },
  // --- Dot-less stage-result basename (the pre-HOK-2891 archive name) ------
  {
    name: 'dot-less-stage-result',
    description:
      '`<stage>-result.json` (no leading dot) — the archiver now writes the dot name; readers must use it too',
    lang: 'both',
    re: /(?<![.\/\\A-Za-z0-9_-])(planning|coding|review|ready)-result\.json\b/,
  },
  // --- Private archive-dir fallback ----------------------------------------
  {
    name: 'ts-evals-artifacts-join',
    description:
      '`evals/artifacts/` path joined manually — go through resolveTaskArtifact / resolveRouteArtifactArchiveDir',
    lang: 'ts',
    re: /['"`]evals[\/'"`]artifacts/,
  },
  {
    name: 'sh-evals-artifacts-join',
    description:
      '`evals/artifacts/` path joined manually in shell — use resolve_task_artifact_path',
    lang: 'sh',
    re: /\.wavemill\/evals\/artifacts\//,
  },
  // --- Sibling artifact dot-less names (pre-HOK-2891 archive names) --------
  {
    name: 'dot-less-sibling-artifact',
    description:
      'dot-less sibling artifact name (`routing-complete.json`, `initial-route.json`, `post-expansion-route.json`, `operator-intervention.json`) — the archive now keeps the dot',
    lang: 'both',
    re: /['"`](routing-complete|initial-route|post-expansion-route|operator-intervention)\.(json|jsonl)?['"`]/,
  },
];

export const STAGE_ARTIFACT_LOOKUP_GUARD: GuardSpec = {
  name: 'stage-artifact-lookup',
  findingNoun: 'private stage-artifact lookup(s)',
  suppressionMarker: 'allow-stage-artifact-lookup',
  allowlistFile: 'tools/stage-artifact-lookup-allowlist.txt',
  // The invariant source and this guard necessarily hold every forbidden shape.
  invariantPaths: [
    'shared/lib/task-artifact-lookup.ts',
    'shared/lib/stage-result.ts',
    'shared/lib/evals-paths.ts',
    'shared/lib/wavemill-common.sh',
    'shared/lib/stage-artifact-lookup-guard.ts',
    'tools/migrate-archived-stage-artifacts.ts',
  ],
  patterns: PATTERNS,
  remediation: [
    'Route stage result reads through readStageResult({ issueId, slug, stage, ... }) or',
    'resolveTaskArtifact({ issueId, slug, artifactName, ... }). The shell twins are',
    'resolve_stage_artifact_path and resolve_task_artifact_path.',
  ],
};
