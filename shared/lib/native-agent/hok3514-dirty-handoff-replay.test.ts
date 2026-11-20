/**
 * HOK-3514 incident replay: a native coder that creates a file through
 * `run_tests` must not finish on a dirty tree, and must be able to commit or
 * discard that file itself in the same session.
 *
 * Each fixture under tests/fixtures/incident-replay/real/hok3514-native-dirty-handoff/
 * replays the sanitised tool sequence from one parked incident (HOK-3454:
 * commit; HOK-3451: discard) through `launchNativeCoding` with a scripted
 * model, so the launcher's command-provenance hook, the tracker-backed git
 * tools and the `.coding-complete` completion gate all run for real.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';
import { launchNativeCoding } from './launch-coding.ts';
import { registerScriptedPiProvider, type ScriptedPiProviderTurn } from './provider.ts';
import { readTaskDirtyPaths } from '../worktree-dirty-status.ts';

const FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../tests/fixtures/incident-replay/real/hok3514-native-dirty-handoff',
);

interface ReplayFixture {
  incident: string;
  issue: string;
  slug: string;
  steps: Array<{ tool: string; args: Record<string, unknown> }>;
  dirtyPath: string;
  resolution: 'commit' | 'discard';
  expected: {
    markerRefusedWhileDirty: boolean;
    resolutionSucceeds: boolean;
    markerAcceptedAfterResolution: boolean;
    recoveryRelaunches: number;
  };
}

const roots: string[] = [];
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

function git(repoDir: string, args: string[]): string {
  return execFileSync('git', ['-C', repoDir, ...args], { encoding: 'utf8' }).trim();
}

/** A worktree shaped like the milled repo: `features/*\/` is ignored, the task has one commit. */
function makeWorktree(slug: string): string {
  const root = mkdtempSync(join(tmpdir(), 'hok3514-replay-'));
  roots.push(root);
  mkdirSync(join(root, 'features', slug), { recursive: true });
  mkdirSync(join(root, 'shared', 'lib'), { recursive: true });
  mkdirSync(join(root, 'tests', 'fixtures', 'incidents'), { recursive: true });
  writeFileSync(join(root, '.gitignore'), 'features/*/\n');
  writeFileSync(join(root, 'shared', 'lib', 'existing.ts'), 'export const x = 1;\n');
  writeFileSync(join(root, 'tests', 'fixtures', 'incidents', 'README.md'), '# incidents\n');
  writeFileSync(join(root, 'features', slug, 'plan.md'), '# Plan\n');
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'Wavemill Test']);
  git(root, ['config', 'user.email', 'wavemill@example.com']);
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'base']);
  return root;
}

function turn(content: ScriptedPiProviderTurn['content'], stopReason: 'toolUse' | 'stop'): ScriptedPiProviderTurn {
  return {
    content,
    usage: {
      input: 50, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 60,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
  };
}

function toolTurn(id: string, name: string, args: Record<string, unknown>): ScriptedPiProviderTurn {
  return turn([{ type: 'tool_call', id, name, arguments: args }], 'toolUse');
}

function loadFixtures(): ReplayFixture[] {
  return readdirSync(FIXTURE_DIR)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf8')) as ReplayFixture);
}

describe('HOK-3514 native dirty-handoff replay', () => {
  const fixtures = loadFixtures();
  it('has both incident fixtures', () => {
    assert.deepEqual(fixtures.map((fixture) => fixture.resolution).sort(), ['commit', 'discard']);
  });

  for (const fixture of fixtures) {
    // protects: HOK-3514 — the incident ends clean in its first session, with zero recovery relaunches.
    it(`${fixture.issue} (${fixture.resolution}) ends clean in the first session`, async () => {
      const root = makeWorktree(fixture.slug);
      const featureDir = join(root, 'features', fixture.slug);
      const marker = { path: `features/${fixture.slug}/.coding-complete`, content: '{"stage":"coding","confidence":"high"}\n' };
      const resolution = fixture.resolution === 'commit'
        ? [
          toolTurn('resolve-add', 'git_add', { paths: [fixture.dirtyPath] }),
          toolTurn('resolve-commit', 'git_commit', { message: 'test: add incident fixture' }),
        ]
        : [toolTurn('resolve-discard', 'discard_owned_path', { paths: [fixture.dirtyPath] })];
      const scripted: ScriptedPiProviderTurn[] = [
        ...fixture.steps.map((step, index) => toolTurn(`step-${index}`, step.tool, step.args)),
        toolTurn('marker-dirty', 'create_marker', marker),
        ...resolution,
        toolTurn('marker-clean', 'create_marker', marker),
        turn([{ type: 'text', text: 'Coding complete.' }], 'stop'),
      ];
      // The transcript the model saw, as of its last turn.
      let transcript = '';
      const api = `hok3514-${fixture.resolution}-${process.pid}-${Date.now()}`;
      let index = 0;
      registerScriptedPiProvider({
        api,
        provider: 'scripted',
        turns: (context) => {
          transcript = JSON.stringify(context.messages);
          return scripted[Math.min(index++, scripted.length - 1)]!;
        },
      });

      const result = await launchNativeCoding({
        session: 'sess', issue: fixture.issue, slug: fixture.slug, wtDir: root, repoDir: root,
        loopModelOverride: { id: `scripted:${api}`, name: `scripted:${api}`, api, provider: 'scripted' },
      });

      assert.equal(existsSync(join(root, fixture.dirtyPath)), fixture.resolution === 'commit');
      if (fixture.expected.markerRefusedWhileDirty) {
        assert.ok(transcript.includes(`.coding-complete refused`), 'the dirty marker write is refused');
        assert.ok(transcript.includes(`Dirty: ${fixture.dirtyPath}.`), 'the refusal names the dirty path');
      }
      if (fixture.expected.resolutionSucceeds) {
        assert.doesNotMatch(transcript, /not_intended|out_of_scope|discard_refused/);
      }
      if (fixture.expected.markerAcceptedAfterResolution) {
        assert.equal(result.completion, 'complete');
        assert.ok(existsSync(join(featureDir, '.coding-complete')));
        assert.deepEqual(readTaskDirtyPaths({ worktree: root, slug: fixture.slug }), { state: 'readable', paths: [] });
      }
      // Zero recovery relaunches: the monitor never had to write a recovery instruction.
      assert.equal(existsSync(join(featureDir, '.coding-recovery-instruction.md')), fixture.expected.recoveryRelaunches > 0);
    });
  }
});
