import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import {
  codingMutationAfterToolCall,
  codingMutationPolicyConfig,
  createCodingMutationTools,
  createCreateMarkerTool,
  createUpdateStatusTool,
  createWriteArtifactTool,
  type CreateMarkerDetails,
  type UpdateStatusDetails,
  type WriteArtifactDetails,
} from './mutation-tools.ts';
import { createCleanupTracker } from '../cleanup.ts';
import { clearConfigCache } from '../../config.ts';

const dirsToClean = new Set<string>();

after(() => {
  for (const dir of dirsToClean) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('native-agent mutation tools', () => {
  it('exposes all coding mutation tools and path policy metadata', () => {
    const tools = createCodingMutationTools('/repo');
    assert.deepEqual(tools.map((tool) => tool.metadata.name), [
      'apply_patch',
      'write_artifact',
      'create_marker',
      'update_status',
    ]);
    assert.deepEqual(codingMutationPolicyConfig, {
      pathFieldsByTool: {
        write_artifact: ['path'],
        create_marker: ['path'],
      },
    });
  });

  it('writes artifacts to allowlisted paths', async () => {
    const repo = createRepo('mutation-artifact-success-');
    const tracker = createCleanupTracker();
    const tool = createWriteArtifactTool(repo, { recorder: tracker });

    const result = await tool.execute('call-1', {
      path: 'features/demo/output.json',
      content: '{"ok":true}\n',
    });

    const details = result.details as WriteArtifactDetails;
    assert.equal(details.ok, true);
    if (details.ok) {
      assert.equal(details.resolvedPath, 'features/demo/output.json');
      assert.equal(details.bytesWritten, Buffer.byteLength('{"ok":true}\n', 'utf-8'));
      assert.equal(readFileSync(path.join(repo, details.resolvedPath), 'utf-8'), '{"ok":true}\n');
      assert.deepEqual(tracker.mutations, [{
        tool: 'write_artifact',
        status: 'completed',
        path: 'features/demo/output.json',
      }]);
    }
  });

  it('rejects whole-file writes to source paths with a retry hint', async () => {
    const repo = createRepo('mutation-artifact-source-denied-');
    const tool = createWriteArtifactTool(repo);

    const result = await tool.execute('call-2', {
      path: 'src/app.ts',
      content: 'export const value = 1;\n',
    });

    const details = result.details as WriteArtifactDetails;
    assert.equal(details.ok, false);
    if (!details.ok) {
      assert.equal(details.error, 'whole_file_source_write_denied');
      assert.equal(details.retryHint, 'use apply_patch for source edits');
      assert.match(details.message, /not generated or Wavemill-owned/);
    }
  });

  it('rejects artifact writes outside the worktree', async () => {
    const repo = createRepo('mutation-artifact-path-denied-');
    const tool = createWriteArtifactTool(repo);

    const result = await tool.execute('call-3', {
      path: '../secret.txt',
      content: 'secret\n',
    });

    const details = result.details as WriteArtifactDetails;
    assert.equal(details.ok, false);
    if (!details.ok) {
      assert.equal(details.error, 'path_denied');
      assert.match(details.message, /outside the active worktree/);
    }

    const afterCall = await codingMutationAfterToolCall({
      toolCall: { name: 'write_artifact' },
      result,
    });
    assert.deepEqual(afterCall, { isError: true });
  });

  it('creates marker files in allowlisted locations', async () => {
    const repo = createRepo('mutation-marker-success-');
    const tool = createCreateMarkerTool(repo);

    const result = await tool.execute('call-4', {
      path: 'features/demo/.coding-complete',
      content: '{"stage":"coding","confidence":"high"}\n',
    });

    const details = result.details as CreateMarkerDetails;
    assert.equal(details.ok, true);
    if (details.ok) {
      assert.equal(details.resolvedPath, 'features/demo/.coding-complete');
      assert.equal(readFileSync(path.join(repo, details.resolvedPath), 'utf-8'), '{\n  "stage": "coding",\n  "confidence": "high"\n}\n');
    }
  });

  // protects: HOK-3514 — the one completion gate refuses .coding-complete on a dirty task tree.
  it('refuses .coding-complete while a task path is dirty and lists every path', async () => {
    const repo = createRepo('mutation-marker-dirty-');
    mkdirSync(path.join(repo, 'shared/lib'), { recursive: true });
    writeFileSync(path.join(repo, 'shared/lib/scratch.txt'), 'scratch\n');
    writeFileSync(path.join(repo, 'fixture.json'), '{}\n');
    const tool = createCreateMarkerTool(repo);

    const result = await tool.execute('call-dirty', {
      path: 'features/demo/.coding-complete',
      content: '{"stage":"coding","confidence":"high"}\n',
    });

    const details = result.details as CreateMarkerDetails;
    assert.equal(details.ok, false);
    if (!details.ok) {
      assert.equal(details.error, 'completion_blocked');
      assert.match(details.message, /fixture\.json, shared\/lib\/scratch\.txt/);
      assert.match(details.message, /discard_owned_path/);
      assert.deepEqual(details.diagnostics, { dirtyPaths: ['fixture.json', 'shared/lib/scratch.txt'] });
    }
    assert.equal(existsSync(path.join(repo, 'features/demo/.coding-complete')), false);
  });

  it('accepts .coding-complete when only Wavemill-owned output is dirty', async () => {
    const repo = createRepo('mutation-marker-owned-');
    mkdirSync(path.join(repo, 'features/demo'), { recursive: true });
    mkdirSync(path.join(repo, '.wavemill'), { recursive: true });
    writeFileSync(path.join(repo, 'features/demo/.native-intended-files.json'), '{}\n');
    writeFileSync(path.join(repo, 'features/demo/plan.md'), '# plan\n');
    writeFileSync(path.join(repo, '.wavemill/native-status.json'), '{}\n');
    writeFileSync(path.join(repo, 'prompt-registry.jsonl'), '\n');

    const result = await createCreateMarkerTool(repo).execute('call-owned', {
      path: 'features/demo/.coding-complete',
      content: '{"stage":"coding","confidence":"high"}\n',
    });
    assert.equal((result.details as CreateMarkerDetails).ok, true);
  });

  it('fails closed when git status cannot be read', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mutation-marker-nogit-'));
    dirsToClean.add(dir);
    const result = await createCreateMarkerTool(dir, {
      readTaskDirtyPaths: () => ({ state: 'unreadable', paths: [] }),
    }).execute('call-nogit', {
      path: 'features/demo/.coding-complete',
      content: '{"stage":"coding","confidence":"high"}\n',
    });
    const details = result.details as CreateMarkerDetails;
    assert.equal(details.ok, false);
    if (!details.ok) assert.equal(details.error, 'completion_blocked');
  });

  it('normalizes YAML blocked-completion writes to canonical JSON', async () => {
    const repo = createRepo('mutation-blocked-normalize-');
    const tool = createWriteArtifactTool(repo);

    const result = await tool.execute('call-blocked-yaml', {
      path: 'features/demo/.coding-blocked-completion.json',
      content: [
        'stage: coding',
        'implementationComplete: true',
        'committed: true',
        'commit: abc1234',
        'passingChecks:',
        '  - node --test shared/lib/example.test.ts',
        'blockingChecks: [npm test]',
        'blockingReason: baseline_tests_failing',
        'evidence: Scoped tests passed.',
        'recommendedAction: advance_to_review',
        '',
      ].join('\n'),
    });

    const details = result.details as WriteArtifactDetails;
    assert.equal(details.ok, true);
    assert.match(result.content[0]!.text, /normalized flat YAML payload/);
    const saved = JSON.parse(readFileSync(path.join(repo, 'features/demo/.coding-blocked-completion.json'), 'utf-8'));
    assert.equal(saved.stage, 'coding');
    assert.deepEqual(saved.passingChecks, ['node --test shared/lib/example.test.ts']);
  });

  it('rejects empty .coding-complete markers with retry guidance', async () => {
    const repo = createRepo('mutation-marker-invalid-complete-');
    const tool = createCreateMarkerTool(repo);

    const result = await tool.execute('call-empty-complete', {
      path: 'features/demo/.coding-complete',
    });

    const details = result.details as CreateMarkerDetails;
    assert.equal(details.ok, false);
    if (!details.ok) {
      assert.equal(details.error, 'completion_artifact_validation_failed');
      assert.match(details.message, /MALFORMED_JSON/);
      assert.match(details.retryHint ?? '', /"confidence"/);
    }
    assert.equal(existsSync(path.join(repo, 'features/demo/.coding-complete')), false);
  });

  it('rejects blocked completion claims with no verification evidence', async () => {
    const repo = createRepo('mutation-blocked-no-evidence-');
    const tool = createWriteArtifactTool(repo);

    const result = await tool.execute('call-no-evidence', {
      path: 'features/demo/.coding-blocked-completion.json',
      content: JSON.stringify({
        stage: 'coding',
        implementationComplete: true,
        committed: true,
        passingChecks: [],
        blockingChecks: ['npm test'],
        blockingReason: 'baseline_tests_failing',
        evidence: 'Did not run checks.',
        recommendedAction: 'advance_to_review',
      }),
    });

    const details = result.details as WriteArtifactDetails;
    assert.equal(details.ok, false);
    if (!details.ok) {
      assert.equal(details.error, 'no_verification_evidence');
      assert.match(details.retryHint ?? '', /implementationComplete to false/);
    }
    assert.equal(existsSync(path.join(repo, 'features/demo/.coding-blocked-completion.json')), false);
  });

  it('does not apply completion validation to non-completion artifacts', async () => {
    const repo = createRepo('mutation-non-completion-');
    const tool = createWriteArtifactTool(repo);

    const result = await tool.execute('call-non-completion', {
      path: 'features/demo/.coding-result.json',
      content: '{not-json',
    });

    const details = result.details as WriteArtifactDetails;
    assert.equal(details.ok, true);
    assert.equal(readFileSync(path.join(repo, 'features/demo/.coding-result.json'), 'utf-8'), '{not-json');
  });

  it('rejects markers outside the whole-file allowlist', async () => {
    const repo = createRepo('mutation-marker-denied-');
    const tool = createCreateMarkerTool(repo);

    const result = await tool.execute('call-5', {
      path: 'src/.marker',
      content: 'x',
    });

    const details = result.details as CreateMarkerDetails;
    assert.equal(details.ok, false);
    if (!details.ok) {
      assert.equal(details.error, 'whole_file_source_write_denied');
      assert.equal(details.retryHint, 'use apply_patch for source edits');
    }
  });

  it('writes durable status updates and leaves no temp files behind', async () => {
    const repo = createRepo('mutation-status-success-');
    const statusPath = path.join(repo, '.wavemill', 'status.json');
    const tracker = createCleanupTracker();
    const tool = createUpdateStatusTool(repo, { statusPath, recorder: tracker });

    const result = await tool.execute('call-6', {
      state: 'working',
      message: 'editing native tools',
      detail: 'phase 2',
    });

    const details = result.details as UpdateStatusDetails;
    assert.equal(details.ok, true);
    if (details.ok) {
      assert.equal(details.statusPath, statusPath);
      const saved = JSON.parse(readFileSync(statusPath, 'utf-8')) as Record<string, unknown>;
      assert.equal(saved.state, 'working');
      assert.equal(saved.event, 'update_status');
      assert.equal(saved.message, 'editing native tools');
      assert.equal(saved.detail, 'phase 2');
      assert.match(result.content[0]!.text, /"tool":"update_status"/);
      assert.deepEqual(
        readdirSync(path.dirname(statusPath)).filter((entry) => entry.endsWith('.tmp')),
        [],
      );
      assert.deepEqual(tracker.mutations, [{
        tool: 'update_status',
        status: 'completed',
        path: '.wavemill/status.json',
      }]);
    }
  });

  it('records patch snapshots for apply_patch success', async () => {
    const repo = createRepo('mutation-apply-patch-recorder-');
    const tracker = createCleanupTracker();
    writeFileSync(path.join(repo, 'src.ts'), 'const value = 1;\n', 'utf8');
    const [tool] = createCodingMutationTools(repo, { recorder: tracker });

    const result = await tool.execute('call-patch', {
      patch: {
        version: 1,
        atomic: true,
        operations: [{
          op: 'edit',
          path: 'src.ts',
          oldText: 'const value = 1;\n',
          newText: 'const value = 2;\n',
        }],
      },
    });

    assert.equal((result.details as { ok: boolean }).ok, true);
    assert.equal(tracker.patchSnapshots.length, 1);
    assert.equal(tracker.patchSnapshots[0]?.path, 'src.ts');
    assert.equal(tracker.patchSnapshots[0]?.originalDiskText, 'const value = 1;\n');
    assert.equal(tracker.patchSnapshots[0]?.postImage, 'const value = 2;\n');
  });

  it('rejects invalid status states', async () => {
    const repo = createRepo('mutation-status-invalid-');
    const tool = createUpdateStatusTool(repo);

    const result = await tool.execute('call-7', {
      state: 'done' as any,
    });

    const details = result.details as UpdateStatusDetails;
    assert.equal(details.ok, false);
    if (!details.ok) {
      assert.equal(details.error, 'invalid_input');
      assert.match(details.message, /state must be one of/);
    }
  });

  it('write_artifact redacts secrets from content before writing to disk', async () => {
    const repo = createRepo('mutation-artifact-redact-');
    const tool = createWriteArtifactTool(repo);
    const token = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890';

    const result = await tool.execute('call-redact', {
      path: 'features/demo/secret.json',
      content: `{"token": "${token}"}`,
    });

    const details = result.details as WriteArtifactDetails;
    assert.equal(details.ok, true);
    if (details.ok) {
      const diskContent = readFileSync(path.join(repo, details.resolvedPath), 'utf-8');
      assert.ok(!diskContent.includes(token), 'original token must not appear on disk');
      assert.ok(diskContent.includes('[REDACTED:github_pat]'), 'redacted placeholder must appear');
    }
  });

  it('write_artifact redacts configured secret env values before writing to disk', async () => {
    const repo = createRepo('mutation-artifact-configured-redact-');
    writeFileSync(
      path.join(repo, '.wavemill-config.json'),
      JSON.stringify({ safety: { redaction: { secretEnvNames: ['HOKUSAI_TEST_SECRET'] } } }),
      'utf-8',
    );
    clearConfigCache(repo);
    process.env.HOKUSAI_TEST_SECRET = 'configured-value-without-known-pattern';
    const tool = createWriteArtifactTool(repo);

    try {
      const result = await tool.execute('call-configured-redact', {
        path: 'features/demo/configured-secret.txt',
        content: 'value=configured-value-without-known-pattern\n',
      });

      const details = result.details as WriteArtifactDetails;
      assert.equal(details.ok, true);
      if (details.ok) {
        const diskContent = readFileSync(path.join(repo, details.resolvedPath), 'utf-8');
        assert.ok(!diskContent.includes('configured-value-without-known-pattern'));
        assert.equal(diskContent, 'value=[REDACTED:configured_secret]\n');
      }
    } finally {
      delete process.env.HOKUSAI_TEST_SECRET;
      clearConfigCache(repo);
    }
  });
});

function createRepo(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  dirsToClean.add(dir);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}
