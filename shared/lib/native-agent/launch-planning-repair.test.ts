import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { registerScriptedPiProvider } from './provider.ts';
import { launchNativePlanning } from './launch-planning.ts';

// HOK-3129: coverage for the single bounded repair turn and the quality
// signal (zero-tool-call plan) that launchNativePlanning now records.

let apiSeq = 0;
function uniqueApi(label: string): string {
  apiSeq += 1;
  return `launch-planning-repair-${label}-${apiSeq}`;
}

function setupWorktree(): { wtDir: string; featureDir: string } {
  const wtDir = mkdtempSync(join(tmpdir(), 'native-planning-repair-wt-'));
  execFileSync('git', ['init', wtDir], { stdio: 'pipe' });
  execFileSync('git', ['-C', wtDir, 'config', 'user.email', 'native@wavemill.test'], { stdio: 'pipe' });
  execFileSync('git', ['-C', wtDir, 'config', 'user.name', 'Native Planning Repair Test'], { stdio: 'pipe' });

  const featureDir = join(wtDir, 'features', 'demo');
  const packetPath = join(featureDir, 'task-packet.md');
  mkdirSync(featureDir, { recursive: true });
  writeFileSync(packetPath, [
    '# Task Packet',
    '## 1. Objective',
    'Rescue a format-only planning rejection.',
    '## Success Criteria',
    '- repair turn fires once for repairable reasons only',
  ].join('\n'));
  writeFileSync(join(wtDir, 'src.ts'), 'export const value = 1;\n');
  execFileSync('git', ['-C', wtDir, 'add', '.'], { stdio: 'pipe' });
  execFileSync('git', ['-C', wtDir, 'commit', '-m', 'fixture'], { stdio: 'pipe' });

  return { wtDir, featureDir };
}

function cleanup(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

function scriptedModel(api: string) {
  return {
    id: `scripted:${api}`,
    name: `scripted:${api}`,
    api,
    provider: 'scripted',
  } as const;
}

function stubRunTsxCommand(): (args: string[]) => string {
  return (args: string[]) => {
    const outputIndex = args.indexOf('--output');
    if (outputIndex >= 0) {
      writeFileSync(args[outputIndex + 1]!, `${JSON.stringify({
        planner: 'gpt-5.4',
        coder: 'gpt-5.4',
        reviewer: 'gpt-5.4',
        planDepth: 'light',
      }, null, 2)}\n`);
    }
    return '';
  };
}

/**
 * A fully valid plan body — matches validateFinalPlanningArtifact's checks:
 * H1, actionable `## Phase` section with bullets, and the full
 * `## Release Readiness` block with every required bullet.
 */
const VALID_PLAN_BODY = [
  '',
  '## Phase 1',
  '- Inspect the native planning launch path and relevant tests.',
  '- Implement bounded loop execution and deterministic validation.',
  '',
  '## Validation',
  '- Run targeted native planning and loop tests.',
  '',
  '## Release Readiness',
  '- **database_change_risk**: none',
  '- **env_changes**: none',
  '- **config_changes**: none',
  '- **manual_steps**: none',
].join('\n');

const PLAN_WITHOUT_H1 = `## Overview\n${VALID_PLAN_BODY}`;
const PLAN_WITH_H1 = `# Rescued Plan\n${VALID_PLAN_BODY}`;
// `too_short` plans are terminal — their total body length is <120 chars
// after trim. They never earn a repair turn even if the model emits them.
const TOO_SHORT_PLAN = 'ok';

describe('launchNativePlanning HOK-3129 repair turn', () => {
  it('runs one bounded repair turn for missing_title and succeeds when the model fixes it', async () => {
    const { wtDir, featureDir } = setupWorktree();
    const api = uniqueApi('missing-title-recovers');
    let turnCount = 0;

    try {
      registerScriptedPiProvider({
        api,
        turns: () => {
          turnCount += 1;
          if (turnCount === 1) {
            return {
              content: [{ type: 'text', text: PLAN_WITHOUT_H1 }],
              stopReason: 'stop',
            };
          }
          return {
            content: [{ type: 'text', text: PLAN_WITH_H1 }],
            stopReason: 'stop',
          };
        },
      });

      await launchNativePlanning({
        session: 'repair-success',
        issue: 'HOK-3129',
        slug: 'demo',
        wtDir,
        repoDir: wtDir,
        loopModelOverride: scriptedModel(api),
        runTsxCommand: stubRunTsxCommand(),
      });

      // Two provider turns — one initial, one repair.
      assert.equal(turnCount, 2);
      assert.match(readFileSync(join(featureDir, 'plan.md'), 'utf-8'), /^# Rescued Plan/);
      const stageResult = JSON.parse(
        readFileSync(join(featureDir, '.planning-result.json'), 'utf-8'),
      ) as Record<string, any>;
      assert.equal(stageResult.status, 'awaiting_user');
      assert.equal(stageResult.artifacts.repairAttempted, true);
      assert.equal(stageResult.artifacts.planArtifactValid, true);
      // Initial loop had no tool calls, so the quality signal fires.
      assert.equal(stageResult.artifacts.zeroToolCallPlan, true);
    } finally {
      cleanup(wtDir);
    }
  });

  it('terminalizes with planning-artifact-invalid notes when the repair turn still fails validation', async () => {
    const { wtDir, featureDir } = setupWorktree();
    const api = uniqueApi('missing-title-persists');

    try {
      registerScriptedPiProvider({
        api,
        turns: [
          {
            content: [{ type: 'text', text: PLAN_WITHOUT_H1 }],
            stopReason: 'stop',
          },
          {
            content: [{ type: 'text', text: PLAN_WITHOUT_H1 }],
            stopReason: 'stop',
          },
        ],
      });

      await assert.rejects(
        () => launchNativePlanning({
          session: 'repair-persists',
          issue: 'HOK-3129',
          slug: 'demo',
          wtDir,
          repoDir: wtDir,
          loopModelOverride: scriptedModel(api),
          runTsxCommand: stubRunTsxCommand(),
        }),
        /missing_title/,
      );

      assert.equal(existsSync(join(featureDir, 'plan.md')), false);
      const stageResult = JSON.parse(
        readFileSync(join(featureDir, '.planning-result.json'), 'utf-8'),
      ) as Record<string, any>;
      assert.equal(stageResult.status, 'failed');
      assert.equal(stageResult.failureReason, 'invalid_final_plan');
      assert.equal(stageResult.artifacts.validationError, 'missing_title');
      assert.equal(stageResult.artifacts.repairAttempted, true);
      assert.equal(stageResult.artifacts.planArtifactValid, false);
      // Notes string stability — the shell classifier depends on it.
      assert.match(
        String(stageResult.notes),
        /Native planning final artifact rejected: missing_title\./,
      );
    } finally {
      cleanup(wtDir);
    }
  });

  it('does not attempt repair for terminal validation reasons such as too_short', async () => {
    const { wtDir, featureDir } = setupWorktree();
    const api = uniqueApi('too-short-terminal');
    let turnCount = 0;

    try {
      registerScriptedPiProvider({
        api,
        turns: () => {
          turnCount += 1;
          return {
            content: [{ type: 'text', text: TOO_SHORT_PLAN }],
            stopReason: 'stop',
          };
        },
      });

      await assert.rejects(
        () => launchNativePlanning({
          session: 'too-short',
          issue: 'HOK-3129',
          slug: 'demo',
          wtDir,
          repoDir: wtDir,
          loopModelOverride: scriptedModel(api),
          runTsxCommand: stubRunTsxCommand(),
        }),
        /too_short/,
      );

      assert.equal(turnCount, 1, 'no repair turn should have run');
      const stageResult = JSON.parse(
        readFileSync(join(featureDir, '.planning-result.json'), 'utf-8'),
      ) as Record<string, any>;
      assert.equal(stageResult.status, 'failed');
      assert.equal(stageResult.artifacts.validationError, 'too_short');
      // repairAttempted is false (never attempted) and planArtifactValid stays false.
      assert.equal(stageResult.artifacts.repairAttempted ?? false, false);
    } finally {
      cleanup(wtDir);
    }
  });

  it('records zeroToolCallPlan=true when a valid plan arrives in one turn with no tool calls', async () => {
    const { wtDir, featureDir } = setupWorktree();
    const api = uniqueApi('zero-tool-call');

    try {
      registerScriptedPiProvider({
        api,
        turns: [{
          content: [{ type: 'text', text: PLAN_WITH_H1 }],
          stopReason: 'stop',
        }],
      });

      await launchNativePlanning({
        session: 'zero-tool-call',
        issue: 'HOK-3129',
        slug: 'demo',
        wtDir,
        repoDir: wtDir,
        loopModelOverride: scriptedModel(api),
        runTsxCommand: stubRunTsxCommand(),
      });

      const stageResult = JSON.parse(
        readFileSync(join(featureDir, '.planning-result.json'), 'utf-8'),
      ) as Record<string, any>;
      assert.equal(stageResult.artifacts.zeroToolCallPlan, true);
      // Clean first try — repairAttempted is false (or omitted on legacy).
      assert.equal(stageResult.artifacts.repairAttempted ?? false, false);
      assert.equal(stageResult.artifacts.usage.turnsCompleted, 1);
      assert.equal(stageResult.artifacts.usage.toolCallsExecuted, 0);
    } finally {
      cleanup(wtDir);
    }
  });
});
