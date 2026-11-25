#!/usr/bin/env -S npx tsx
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { runGuardCli, type GuardSpec } from './lib/source-guard.ts';

const spec: GuardSpec = {
  name: 'attempt-lineage',
  invariantDocs: ['docs/invariants/attempt-lineage.md'],
  findingNoun: 'attempt-lineage violation(s)',
  suppressionMarker: 'allow-attempt-lineage',
  allowlistFile: 'tools/attempt-lineage-allowlist.txt',
  invariantPaths: ['shared/lib/attempt-identity.ts', 'shared/lib/attempt-identity.sh', 'tools/check-attempt-lineage.ts'], // install-paths: allow repo-relative guard metadata
  patterns: [{
    name: 'inline-ref',
    description: 'construct SDK references with projectTaskAttemptRef',
    lang: 'both',
    re: /\btask_id\s*:\s*[^,}]+,\s*run_id\s*:/,
  }, {
    name: 'direct-write',
    description: 'write attempt references through the ownership or stage-result seam',
    lang: 'ts',
    re: /\.attemptRef\s*=(?!=)/,
    excludePaths: ['shared/lib/session-ownership.ts', 'shared/lib/stage-result.ts', 'tools/stage-result-cli.ts'], // install-paths: allow repo-relative guard metadata
  }],
  structuralChecks: [{
    name: 'object-ref',
    description: 'construct SDK references with projectTaskAttemptRef',
    find(source, file) {
      if (!/\.[cm]?[jt]sx?$/.test(file) || (!source.includes('attemptRef') && (!source.includes('task_id') || !source.includes('run_id')))) return [];
      const canWriteRef = ['shared/lib/session-ownership.ts', 'shared/lib/stage-result.ts', 'tools/stage-result-cli.ts'].includes(file); // install-paths: allow repo-relative guard metadata
      const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
      const findings: { line: number }[] = [];
      function visit(node: ts.Node): void {
        if (ts.isObjectLiteralExpression(node)) {
          const names = node.properties.flatMap(property => {
            const name = 'name' in property ? property.name : undefined;
            return name && (ts.isIdentifier(name) || ts.isStringLiteral(name)) ? [name.text] : [];
          });
          if ((names.includes('task_id') && names.includes('run_id')) || (!canWriteRef && names.includes('attemptRef'))) {
            findings.push({ line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1 });
          }
        }
        ts.forEachChild(node, visit);
      }
      visit(tree);
      return findings;
    },
  }],
  remediation: ['Use projectTaskAttemptRef (or its shell twin) to construct SDK attempt references.'],
};
const file = fileURLToPath(import.meta.url);
if (process.argv[1] === file) runGuardCli(spec, process.argv[2] ?? join(dirname(file), '..'));
