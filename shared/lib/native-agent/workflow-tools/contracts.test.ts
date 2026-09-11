import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import {
  WORKFLOW_TOOL_SCHEMA_VERSION,
  WORKFLOW_TOOL_NAMES,
  WORKFLOW_PHASES,
  WORKFLOW_MUTATION_ACTIONS,
  IDEMPOTENCY_OUTCOMES,
  RECORDING_REQUIREMENTS,
} from './contracts.ts';
import {
  githubCreatePrKey,
  githubAddLabelKey,
  linearCommentKey,
  writeStageResultKey,
} from './dedupe.ts';
import { isMutationAllowed } from './mutation-policy.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(
  readFileSync(join(__dirname, 'contracts.json'), 'utf-8'),
);

// ---------------------------------------------------------------------------
// Schema validator setup (Ajv 8 with draft-2020-12)
// ---------------------------------------------------------------------------

// Helper: validate a value against a named $def
function validateDef(defName: string, value: unknown): { valid: boolean; errors: unknown[] } {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const fn = ajv.compile({ ...schema, $ref: `#/$defs/${defName}` });
  const valid = fn(value);
  return { valid, errors: fn.errors ?? [] };
}

// ---------------------------------------------------------------------------
// Tool registry
// ---------------------------------------------------------------------------

describe('workflow-tools: tool registry', () => {
  it('exports exactly the eight required tool names', () => {
    assert.deepEqual([...WORKFLOW_TOOL_NAMES].sort(), [
      'expand_issue',
      'github_add_label',
      'github_create_pr',
      'linear_comment',
      'linear_get_issue',
      'review_changes',
      'route_task',
      'write_stage_result',
    ]);
  });

  it('schema tool name enum matches TypeScript WORKFLOW_TOOL_NAMES', () => {
    const schemaNames: string[] = schema.$defs.workflowToolName.enum;
    assert.deepEqual([...schemaNames].sort(), [...WORKFLOW_TOOL_NAMES].sort());
  });

  it('schema version matches TypeScript constant', () => {
    assert.equal(schema['x-schema-version'], WORKFLOW_TOOL_SCHEMA_VERSION);
  });

  it('schema version is 1.3.0 (additive bump for review executed-identity fields)', () => {
    assert.equal(WORKFLOW_TOOL_SCHEMA_VERSION, '1.3.0');
    assert.equal(schema['x-schema-version'], '1.3.0');
  });

  it('schema phase enum matches TypeScript WORKFLOW_PHASES', () => {
    const schemaPhases: string[] = schema.$defs.workflowPhase.enum;
    assert.deepEqual([...schemaPhases].sort(), [...WORKFLOW_PHASES].sort());
  });

  it('schema mutation action enum matches TypeScript WORKFLOW_MUTATION_ACTIONS', () => {
    const schemaActions: string[] = schema.$defs.workflowMutationAction.enum;
    assert.deepEqual([...schemaActions].sort(), [...WORKFLOW_MUTATION_ACTIONS].sort());
  });

  it('schema idempotency outcome enum matches TypeScript IDEMPOTENCY_OUTCOMES', () => {
    const schemaOutcomes: string[] = schema.$defs.idempotencyOutcome.enum;
    assert.deepEqual([...schemaOutcomes].sort(), [...IDEMPOTENCY_OUTCOMES].sort());
  });
});

// ---------------------------------------------------------------------------
// Idempotency schema validation
// ---------------------------------------------------------------------------

describe('workflow-tools: idempotency result schema', () => {
  it('validates created outcome with ref', () => {
    const { valid, errors } = validateDef('idempotencyResult', {
      key: 'github_create_pr:owner/repo:feat:main:abc123',
      outcome: 'created',
      ref: { system: 'github', kind: 'pull_request', id: '42', url: 'https://github.com/owner/repo/pull/42' },
    });
    assert.equal(valid, true, `validation errors: ${JSON.stringify(errors)}`);
  });

  it('validates reused outcome with ref', () => {
    const { valid } = validateDef('idempotencyResult', {
      key: 'github_create_pr:owner/repo:feat:main:abc123',
      outcome: 'reused',
      ref: { system: 'github', kind: 'pull_request', id: '42' },
    });
    assert.equal(valid, true);
  });

  it('validates updated outcome', () => {
    const { valid } = validateDef('idempotencyResult', {
      key: 'write_stage_result:HOK-1:coding:completed',
      outcome: 'updated',
      ref: { system: 'wavemill', kind: 'stage_result', id: 'HOK-1/coding' },
    });
    assert.equal(valid, true);
  });

  it('validates skipped outcome with null ref', () => {
    const { valid } = validateDef('idempotencyResult', {
      key: 'github_add_label:owner/repo:pull_request:10:bug',
      outcome: 'skipped',
      ref: null,
      reason: 'label already applied',
    });
    assert.equal(valid, true);
  });

  it('rejects unknown outcome value', () => {
    const { valid } = validateDef('idempotencyResult', {
      key: 'github_create_pr:owner/repo:feat:main:abc123',
      outcome: 'merged',
      ref: null,
    });
    assert.equal(valid, false);
  });

  it('rejects missing key field', () => {
    const { valid } = validateDef('idempotencyResult', {
      outcome: 'created',
      ref: { system: 'github', kind: 'pull_request', id: '1' },
    });
    assert.equal(valid, false);
  });

  it('rejects malformed external ref (missing id)', () => {
    const { valid } = validateDef('externalRef', {
      system: 'github',
      kind: 'pull_request',
    });
    assert.equal(valid, false);
  });

  it('rejects external ref with unknown system', () => {
    const { valid } = validateDef('externalRef', {
      system: 'jira',
      kind: 'issue',
      id: '123',
    });
    assert.equal(valid, false);
  });
});

// ---------------------------------------------------------------------------
// Dedupe key determinism
// ---------------------------------------------------------------------------

describe('workflow-tools: dedupe key determinism', () => {
  it('github_create_pr: identical inputs produce identical keys', () => {
    const input = { repo: 'owner/repo', head: 'feat', base: 'main', headSha: 'abc123' };
    assert.equal(githubCreatePrKey(input), githubCreatePrKey(input));
  });

  it('github_create_pr: changing headSha changes the key', () => {
    const base = { repo: 'owner/repo', head: 'feat', base: 'main', headSha: 'abc123' };
    assert.notEqual(githubCreatePrKey(base), githubCreatePrKey({ ...base, headSha: 'def456' }));
  });

  it('github_create_pr: changing head branch changes the key', () => {
    const base = { repo: 'owner/repo', head: 'feat', base: 'main', headSha: 'abc123' };
    assert.notEqual(githubCreatePrKey(base), githubCreatePrKey({ ...base, head: 'other' }));
  });

  it('github_create_pr: changing base branch changes the key', () => {
    const base = { repo: 'owner/repo', head: 'feat', base: 'main', headSha: 'abc123' };
    assert.notEqual(githubCreatePrKey(base), githubCreatePrKey({ ...base, base: 'develop' }));
  });

  it('github_create_pr: repo is normalized to lower-case', () => {
    const a = githubCreatePrKey({ repo: 'Owner/Repo', head: 'feat', base: 'main', headSha: 'abc' });
    const b = githubCreatePrKey({ repo: 'owner/repo', head: 'feat', base: 'main', headSha: 'abc' });
    assert.equal(a, b);
  });

  it('github_add_label: identical inputs produce identical keys', () => {
    const input = { repo: 'owner/repo', targetKind: 'pull_request' as const, targetNumber: 10, label: 'bug' };
    assert.equal(githubAddLabelKey(input), githubAddLabelKey(input));
  });

  it('github_add_label: label normalization prevents case-only duplicates', () => {
    const a = githubAddLabelKey({ repo: 'owner/repo', targetKind: 'pull_request', targetNumber: 10, label: 'Bug' });
    const b = githubAddLabelKey({ repo: 'owner/repo', targetKind: 'pull_request', targetNumber: 10, label: 'bug' });
    assert.equal(a, b);
  });

  it('github_add_label: changing target number changes the key', () => {
    const a = githubAddLabelKey({ repo: 'owner/repo', targetKind: 'pull_request', targetNumber: 10, label: 'bug' });
    const b = githubAddLabelKey({ repo: 'owner/repo', targetKind: 'pull_request', targetNumber: 11, label: 'bug' });
    assert.notEqual(a, b);
  });

  it('linear_comment: identical inputs produce identical keys', () => {
    const input = { issue: 'HOK-1', phase: 'coding' as const, sessionId: 'sess-1', body: 'hello world' };
    assert.equal(linearCommentKey(input), linearCommentKey(input));
  });

  it('linear_comment: changing body changes the key', () => {
    const base = { issue: 'HOK-1', phase: 'coding' as const, sessionId: 'sess-1', body: 'hello world' };
    assert.notEqual(
      linearCommentKey(base),
      linearCommentKey({ ...base, body: 'different content' }),
    );
  });

  it('linear_comment: key does not contain the raw body text', () => {
    const key = linearCommentKey({ issue: 'HOK-1', phase: 'coding', sessionId: 's', body: 'secret body content' });
    assert.equal(key.includes('secret body content'), false);
  });

  it('write_stage_result: identical inputs produce identical keys', () => {
    const input = { issueOrFeature: 'HOK-1', stage: 'coding', status: 'completed' };
    assert.equal(writeStageResultKey(input), writeStageResultKey(input));
  });

  it('write_stage_result: changing status changes the key', () => {
    const a = writeStageResultKey({ issueOrFeature: 'HOK-1', stage: 'coding', status: 'completed' });
    const b = writeStageResultKey({ issueOrFeature: 'HOK-1', stage: 'coding', status: 'failed' });
    assert.notEqual(a, b);
  });

  it('write_stage_result: key format is stable', () => {
    const key = writeStageResultKey({ issueOrFeature: 'HOK-1234', stage: 'review', status: 'completed' });
    assert.equal(key, 'write_stage_result:HOK-1234:review:completed');
  });

  it('github_create_pr: key format is stable', () => {
    const key = githubCreatePrKey({ repo: 'owner/repo', head: 'feat', base: 'main', headSha: 'abc' });
    assert.equal(key, 'github_create_pr:owner/repo:feat:main:abc');
  });
});

// ---------------------------------------------------------------------------
// Mutation policy gates
// ---------------------------------------------------------------------------

describe('workflow-tools: mutation policy gates', () => {
  it('denies merge in review phase for every tool', () => {
    for (const tool of WORKFLOW_TOOL_NAMES) {
      const result = isMutationAllowed('review', tool, 'merge');
      assert.equal(result.allowed, false, `expected merge denied for tool=${tool}`);
      assert.match(result.reason, /merge/, `reason should mention merge for tool=${tool}`);
    }
  });

  it('denies merge in every phase', () => {
    for (const phase of WORKFLOW_PHASES) {
      for (const tool of WORKFLOW_TOOL_NAMES) {
        const result = isMutationAllowed(phase, tool, 'merge');
        assert.equal(result.allowed, false, `expected merge denied for phase=${phase} tool=${tool}`);
      }
    }
  });

  it('allows review phase to create PR artifacts', () => {
    const result = isMutationAllowed('review', 'github_create_pr', 'create_pr');
    assert.equal(result.allowed, true, result.reason);
  });

  it('allows review phase to update PR artifacts', () => {
    const result = isMutationAllowed('review', 'github_create_pr', 'update_pr');
    assert.equal(result.allowed, true, result.reason);
  });

  it('allows review phase to add labels', () => {
    const result = isMutationAllowed('review', 'github_add_label', 'add_label');
    assert.equal(result.allowed, true, result.reason);
  });

  it('allows ready phase stale_base remediation', () => {
    const result = isMutationAllowed('ready', 'github_create_pr', 'stale_base');
    assert.equal(result.allowed, true, result.reason);
  });

  it('allows ready phase merge_conflict remediation', () => {
    const result = isMutationAllowed('ready', 'github_create_pr', 'merge_conflict');
    assert.equal(result.allowed, true, result.reason);
  });

  it('denies ready phase general PR creation', () => {
    const result = isMutationAllowed('ready', 'github_create_pr', 'create_pr');
    assert.equal(result.allowed, false, result.reason);
    assert.equal(result.code, 'ready_mutation_denied');
  });

  it('denies ready phase feature comment', () => {
    const result = isMutationAllowed('ready', 'linear_comment', 'comment');
    assert.equal(result.allowed, false, result.reason);
    assert.equal(result.code, 'ready_mutation_denied');
  });

  it('denies ready phase add_label', () => {
    const result = isMutationAllowed('ready', 'github_add_label', 'add_label');
    assert.equal(result.allowed, false, result.reason);
  });

  it('allows write_stage_result recording in ready phase', () => {
    const result = isMutationAllowed('ready', 'write_stage_result', 'write_stage_result');
    assert.equal(result.allowed, true, result.reason);
  });

  it('allows read-only tools in planning phase', () => {
    const result = isMutationAllowed('planning', 'linear_get_issue', 'read');
    assert.equal(result.allowed, true, result.reason);
  });

  it('allows read-only tools in review phase', () => {
    const result = isMutationAllowed('review', 'linear_get_issue', 'read');
    assert.equal(result.allowed, true, result.reason);
  });

  it('allows read-only tools in ready phase', () => {
    const result = isMutationAllowed('ready', 'linear_get_issue', 'read');
    assert.equal(result.allowed, true, result.reason);
  });

  it('denies unknown tool/action combination by default', () => {
    // @ts-expect-error testing unknown combination
    const result = isMutationAllowed('review', 'linear_get_issue', 'teleport');
    assert.equal(result.allowed, false);
    assert.equal(result.code, 'unknown_combination');
    assert.match(result.reason, /unknown_combination/);
  });

  it('isMutationAllowed returns stable reason string for review merge denial', () => {
    const result = isMutationAllowed('review', 'github_create_pr', 'merge');
    assert.equal(result.code, 'review_cannot_merge');
    assert.equal(result.reason, 'review_cannot_merge: merge is never an allowed workflow tool action');
  });

  it('limits review-phase mutations to review workflow actions and recording', () => {
    assert.equal(isMutationAllowed('review', 'github_create_pr', 'create_pr').allowed, true);
    assert.equal(isMutationAllowed('review', 'github_create_pr', 'update_pr').allowed, true);
    assert.equal(isMutationAllowed('review', 'github_add_label', 'add_label').allowed, true);
    assert.equal(isMutationAllowed('review', 'linear_comment', 'comment').allowed, true);
    assert.equal(isMutationAllowed('review', 'write_stage_result', 'write_stage_result').allowed, true);
    assert.equal(isMutationAllowed('review', 'github_create_pr', 'stale_base').allowed, false);
    assert.equal(isMutationAllowed('review', 'github_create_pr', 'merge_conflict').allowed, false);
  });

  it('limits ready-phase mutations to remediation work and recording', () => {
    assert.equal(isMutationAllowed('ready', 'github_create_pr', 'stale_base').allowed, true);
    assert.equal(isMutationAllowed('ready', 'github_create_pr', 'merge_conflict').allowed, true);
    assert.equal(isMutationAllowed('ready', 'write_stage_result', 'write_stage_result').allowed, true);
    assert.equal(isMutationAllowed('ready', 'github_create_pr', 'create_pr').allowed, false);
    assert.equal(isMutationAllowed('ready', 'github_create_pr', 'update_pr').allowed, false);
    assert.equal(isMutationAllowed('ready', 'github_add_label', 'add_label').allowed, false);
    assert.equal(isMutationAllowed('ready', 'linear_comment', 'comment').allowed, false);
  });
});

// ---------------------------------------------------------------------------
// Recording requirements
// ---------------------------------------------------------------------------

describe('workflow-tools: recording requirements', () => {
  it('every mutating tool requires transcript and stage artifact recording', () => {
    const mutatingTools = ['linear_comment', 'github_create_pr', 'github_add_label', 'write_stage_result'];
    for (const tool of mutatingTools) {
      const req = RECORDING_REQUIREMENTS.find(r => r.tool === tool);
      assert.ok(req, `missing recording requirement for ${tool}`);
      assert.equal(req.requiresTranscriptRecord, true, `${tool} must require transcript record`);
      assert.equal(req.requiresStageArtifactRecord, true, `${tool} must require stage artifact record`);
    }
  });

  it('required recorded fields include tool, phase, and idempotency fields for mutating tools', () => {
    const mutatingTools = ['linear_comment', 'github_create_pr', 'github_add_label', 'write_stage_result'];
    const requiredFields = ['tool', 'phase', 'idempotency.key', 'idempotency.outcome', 'idempotency.ref'];
    for (const tool of mutatingTools) {
      const req = RECORDING_REQUIREMENTS.find(r => r.tool === tool);
      assert.ok(req);
      for (const field of requiredFields) {
        assert.ok(
          req.requiredRecordedFields.includes(field),
          `${tool} should require field ${field}`,
        );
      }
    }
  });

  it('read-only tools do not require stage artifact recording', () => {
    const readOnlyTools = ['linear_get_issue', 'review_changes', 'route_task', 'expand_issue'];
    for (const tool of readOnlyTools) {
      const req = RECORDING_REQUIREMENTS.find(r => r.tool === tool);
      assert.ok(req, `missing recording requirement for ${tool}`);
      assert.equal(req.requiresStageArtifactRecord, false, `${tool} should not require stage artifact record`);
    }
  });

  it('all eight tools have recording requirements', () => {
    const tools = new Set(RECORDING_REQUIREMENTS.map(r => r.tool));
    for (const tool of WORKFLOW_TOOL_NAMES) {
      assert.ok(tools.has(tool), `missing recording requirement entry for ${tool}`);
    }
  });
});

// ---------------------------------------------------------------------------
// expandIssueSuccess: optional idempotency field (HOK-2356)
// ---------------------------------------------------------------------------

describe('workflow-tools: expandIssueSuccess optional idempotency field', () => {
  it('validates expandIssueSuccess without optional idempotency field (backward compat)', () => {
    const { valid, errors } = validateDef('expandIssueSuccess', {
      ok: true,
      tool: 'expand_issue',
      taskPacketPath: '/features/hok-1/task-packet.md',
    });
    assert.equal(valid, true, `validation errors: ${JSON.stringify(errors)}`);
  });

  it('validates expandIssueSuccess with optional idempotency field present', () => {
    const { valid, errors } = validateDef('expandIssueSuccess', {
      ok: true,
      tool: 'expand_issue',
      taskPacketPath: '/features/hok-1/task-packet.md',
      idempotency: {
        key: 'expand_issue:HOK-1:planning:sess-1:',
        outcome: 'created',
        ref: { system: 'wavemill', kind: 'task_packet', id: '/features/hok-1/task-packet.md' },
      },
    });
    assert.equal(valid, true, `validation errors: ${JSON.stringify(errors)}`);
  });

  it('validates expandIssueSuccess with idempotency outcome = reused', () => {
    const { valid } = validateDef('expandIssueSuccess', {
      ok: true,
      tool: 'expand_issue',
      taskPacketPath: '/features/hok-1/task-packet.md',
      idempotency: {
        key: 'expand_issue:HOK-1:planning:sess-1:',
        outcome: 'reused',
        ref: { system: 'wavemill', kind: 'task_packet', id: '/features/hok-1/task-packet.md' },
      },
    });
    assert.equal(valid, true);
  });

  it('rejects expandIssueSuccess with invalid idempotency outcome', () => {
    const { valid } = validateDef('expandIssueSuccess', {
      ok: true,
      tool: 'expand_issue',
      taskPacketPath: '/features/hok-1/task-packet.md',
      idempotency: {
        key: 'expand_issue:HOK-1:planning:sess-1:',
        outcome: 'denied',
        ref: null,
      },
    });
    assert.equal(valid, false, 'denied is not a valid idempotency outcome');
  });
});
