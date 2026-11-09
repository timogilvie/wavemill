#!/usr/bin/env -S npx tsx
/**
 * Unit tests for the HOK-3325 defect-escalation preflight guard.
 *
 * protects: a regression reintroduces a raw issueCreate/createIssue/generateIssueBody
 * site and the guard fails to surface it.
 */
import assert from 'node:assert/strict';
import { checkGuardSource, parseGuardAllowlist } from './lib/source-guard.ts';
import { DEFECT_ESCALATION_GUARD } from '../shared/lib/defect-escalation-guard.ts';

function findingsFor(source: string, fileName = 'test.ts') {
  return checkGuardSource(DEFECT_ESCALATION_GUARD, fileName, source);
}

function patterns(found: ReturnType<typeof findingsFor>) {
  return found.map((f) => f.pattern).sort();
}

// protects: raw issueCreate mutation outside shared/lib/linear.ts
assert.deepEqual(
  patterns(findingsFor(`const data = await linearGraphql<{ issueCreate: { issue: { url: string } } }>(
    apiKey,
    \`mutation CreateIssue($input: IssueCreateInput!) { issueCreate(input: $input) { issue { url } } }\`,
    { input: { teamId, title } },
  );`)),
  ['raw-issueCreate-mutation'],
);

// protects: raw createIssue call outside the authorised transport
assert.deepEqual(
  patterns(findingsFor(`await createIssue({ title: 'x', teamId: 't' });`)),
  ['raw-createIssue-call'],
);
assert.deepEqual(
  patterns(findingsFor(`await client.createIssue({ title: 'x', teamId: 't' });`)),
  ['raw-createIssue-call'],
);

// protects: reference to deleted symptom-body renderer
assert.deepEqual(
  patterns(findingsFor(`import { generateIssueBody } from './incident-to-linear-synchronizer.ts';
const body = generateIssueBody(incident, config, rev, now);`)),
  ['generateIssueBody-reference', 'generateIssueBody-reference'],
);

// protects: a suppressed line is ignored
assert.deepEqual(
  patterns(findingsFor(`// allow-defect-escalation: test suppression
await createIssue({ title: 'x' });`)),
  [],
);

// protects: the authorised transport is allowed to call createIssue
assert.deepEqual(
  patterns(findingsFor(`await client.createIssue({ title: 'x', teamId: 't' });`, 'shared/lib/incident-to-linear-synchronizer.ts')),
  [],
);

// protects: allowlist entries require a reason
const parsed = parseGuardAllowlist(`tools/observer.ts 1 # with reason
shared/lib/bad.ts`, true);
assert.equal(parsed.missingReason.length, 1);
assert.equal(parsed.missingReason[0].path, 'shared/lib/bad.ts');
assert.equal(parsed.entries.length, 1);
assert.equal(parsed.entries[0].path, 'tools/observer.ts');

console.log('defect-escalation guard: ok');

// protects: an already-linked incident bypassing investigation through comments
assert.deepEqual(patterns(findingsFor('const body = generateCommentBody(incident, config, rev, now);')), ['generateCommentBody-reference']);
