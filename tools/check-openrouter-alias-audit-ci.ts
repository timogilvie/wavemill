import { readFileSync } from 'node:fs';
import path, { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const defaultRepoRoot = join(dirname(__filename), '..');

const REQUIRED_FILTER_PATHS = [
  'shared/fixtures/model-registry.v1.json',
  'shared/lib/disabled-models.ts',
  'tools/audit-openrouter-aliases.ts',
  'tools/check-openrouter-alias-audit-ci.ts',
  'tools/check-openrouter-alias-audit-ci.test.ts',
  '.github/workflows/ci.yml',
];

export interface OpenRouterAliasAuditCiResult {
  ok: boolean;
  problems: string[];
}

export function checkOpenRouterAliasAuditCi(repoDir = defaultRepoRoot): OpenRouterAliasAuditCiResult {
  const workflow = readFileSync(path.join(repoDir, '.github', 'workflows', 'ci.yml'), 'utf8');
  const problems: string[] = [];
  const checkPathsBlock = extractJobBlock(workflow, 'check-paths');
  const auditBlock = extractJobBlock(workflow, 'openrouter-alias-audit');

  if (!checkPathsBlock) {
    problems.push('job `check-paths` not found; OpenRouter alias audit relevance cannot be detected');
  } else {
    problems.push(...checkPathFilterContract(checkPathsBlock));
  }

  if (!auditBlock) {
    problems.push('job `openrouter-alias-audit` not found; nightly audit failures will not be visible');
  } else {
    problems.push(...checkAuditJobContract(auditBlock));
  }

  return { ok: problems.length === 0, problems };
}

export function formatOpenRouterAliasAuditCi(result: OpenRouterAliasAuditCiResult): string {
  if (result.ok) {
    return 'openrouter-alias-audit-ci: ok (PR-visible check, gated live audit, fail-closed path detection)';
  }

  return [
    'openrouter-alias-audit-ci: CI workflow contract violated:',
    ...result.problems.map((problem, index) => `${index + 1}. ${problem}`),
    '',
    'The OpenRouter Alias Audit job must report on PRs/protected-branch pushes,',
    'run the live audit for registry-adjacent changes and scheduled/manual runs,',
    'and fail closed when path detection cannot determine relevance.',
  ].join('\n');
}

function checkPathFilterContract(checkPathsBlock: string): string[] {
  const problems: string[] = [];

  if (!/^\s+openrouter_alias_audit:\s*\$\{\{\s*steps\.filter\.outputs\.openrouter_alias_audit\s*==\s*'true'\s*\}\}/m.test(checkPathsBlock)) {
    problems.push('`check-paths` does not expose an `openrouter_alias_audit` output from paths-filter');
  }

  const filterBlock = checkPathsBlock.match(/^\s{12}openrouter_alias_audit:\s*\n(?<body>(?:\s{14}.+\n)*)/m)?.groups?.body ?? '';
  for (const requiredPath of REQUIRED_FILTER_PATHS) {
    if (!filterBlock.includes(`'${requiredPath}'`) && !filterBlock.includes(`"${requiredPath}"`)) {
      problems.push(`OpenRouter alias audit path filter is missing ${requiredPath}`);
    }
  }

  return problems;
}

function checkAuditJobContract(auditBlock: string): string[] {
  const problems: string[] = [];
  const jobIf = auditBlock.match(/^    if:\s*(.+?)\s*$/m)?.[1] ?? '';
  const runEnv = auditBlock.match(/^\s+RUN_OPENROUTER_ALIAS_AUDIT:\s*(.+?)\s*$/m)?.[1] ?? '';
  const failStep = extractStepBlock(auditBlock, 'Fail if change detection did not succeed') ?? '';
  const skipStep = extractStepBlock(auditBlock, 'Report skip') ?? '';
  const auditStep = extractStepBlock(auditBlock, 'Audit OpenRouter aliases') ?? '';

  if (!auditBlock.includes('needs: check-paths')) {
    problems.push('OpenRouter alias audit job does not depend on `check-paths`');
  }

  if (jobIf !== 'always()') {
    problems.push('OpenRouter alias audit job is not step-gated with `if: always()`; PR checks may be skipped');
  }

  if (
    !runEnv.includes("github.event_name == 'schedule'")
    || !runEnv.includes("github.event_name == 'workflow_dispatch'")
    || !runEnv.includes("needs.check-paths.outputs.openrouter_alias_audit == 'true'")
  ) {
    problems.push('RUN_OPENROUTER_ALIAS_AUDIT does not run for schedule/manual events and matching path-filter output');
  }

  if (
    !failStep.includes("github.event_name == 'pull_request'")
    || !failStep.includes("github.event_name == 'push'")
    || !failStep.includes("needs.check-paths.result != 'success'")
  ) {
    problems.push('OpenRouter alias audit job does not fail closed when path detection fails on PR/push events');
  }

  if (!skipStep.includes("env.RUN_OPENROUTER_ALIAS_AUDIT != 'true'")) {
    problems.push('OpenRouter alias audit job does not report a successful skip for irrelevant PR/push changes');
  }

  if (!auditStep.includes("env.RUN_OPENROUTER_ALIAS_AUDIT == 'true'")) {
    problems.push('live OpenRouter alias audit step is not gated by RUN_OPENROUTER_ALIAS_AUDIT');
  }

  if (!auditStep.includes('npx tsx tools/audit-openrouter-aliases.ts --json --no-write')) {
    problems.push('live OpenRouter alias audit command is missing or changed');
  }

  return problems;
}

function extractJobBlock(workflow: string, jobKey: string): string | null {
  const jobsBlock = workflow.match(/^jobs:\n(?<body>[\s\S]*)$/m)?.groups?.body;
  if (!jobsBlock) {
    return null;
  }

  const jobMatches = [...jobsBlock.matchAll(/^  ([A-Za-z0-9_-]+):\s*$/gm)];
  for (let index = 0; index < jobMatches.length; index += 1) {
    if (jobMatches[index][1] !== jobKey) {
      continue;
    }
    const start = jobMatches[index].index ?? 0;
    const end = index + 1 < jobMatches.length ? jobMatches[index + 1].index ?? jobsBlock.length : jobsBlock.length;
    return jobsBlock.slice(start, end);
  }
  return null;
}

function extractStepBlock(jobBlock: string, stepName: string): string | null {
  const stepMatches = [...jobBlock.matchAll(/^      - name:\s*(.+?)\s*$/gm)];
  for (let index = 0; index < stepMatches.length; index += 1) {
    const rawName = stepMatches[index][1].replace(/^['"]|['"]$/g, '');
    if (rawName !== stepName) {
      continue;
    }
    const start = stepMatches[index].index ?? 0;
    const end = index + 1 < stepMatches.length ? stepMatches[index + 1].index ?? jobBlock.length : jobBlock.length;
    return jobBlock.slice(start, end);
  }
  return null;
}

if (process.argv[1] === __filename) {
  const result = checkOpenRouterAliasAuditCi(process.argv[2] ?? defaultRepoRoot);
  const message = formatOpenRouterAliasAuditCi(result);
  if (!result.ok) {
    console.error(message);
    process.exit(1);
  }
  console.log(message);
}
