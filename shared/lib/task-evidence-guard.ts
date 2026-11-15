import type { GuardSpec } from '../../tools/lib/source-guard.ts';

export const TASK_EVIDENCE_GUARD: GuardSpec = {
  name: 'task-evidence',
  findingNoun: 'private task-evidence inventories',
  suppressionMarker: 'allow-task-evidence',
  allowlistFile: 'tools/task-evidence-allowlist.txt',
  invariantPaths: ['shared/lib/task-artifact-lookup.ts', 'shared/lib/task-evidence-archive.ts', 'shared/lib/task-evidence-guard.ts'],
  invariantDocs: ['docs/invariants/task-evidence.md'],
  patterns: [
    { name: 'retired-copy', lang: 'both', re: /_wavemill_archive_(?:json_)?copy\b/,
      description: 'retired shell inventory: use archiveTaskEvidence and taskEvidenceNames' },
    { name: 'shell-stage-inventory', lang: 'sh', re: /for\s+\w+\s+in\s+planning\s+coding\s+review/,
      scopedPaths: ['shared/lib/wavemill-common.sh'], description: 'stage inventory belongs to TASK_RESULT_STAGES' },
  ],
  structuralChecks: [{
    name: 'json-path-guesser', description: 'JSON strings are not transcript ownership; use discoverOwnedSessionEvidence',
    paths: ['shared/lib/wavemill-common.sh', 'shared/lib/task-evidence-archive.ts'],
    find: source => /\.jsonl/.test(source) && /(?:\.\.\s*\||walk\(|def\s+walk|def\s+visit)/.test(source)
      ? [{ line: 1 }] : [],
  }],
  remediation: ['Keep artifact names in taskEvidenceNames and transcript selection in discoverOwnedSessionEvidence.',
    'Cleanup must preserve that inventory before releasing resources; readers consume verified retained roots.'],
};
