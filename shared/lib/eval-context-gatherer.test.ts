/**
 * Tests for eval-context-gatherer module.
 */

import { afterEach, beforeEach, describe, test as it } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { expect } from './test-assertions.ts';
import { POLICY_RESOLVER_VERSION, ROUTE_ARTIFACT_SCHEMA_VERSION } from './route-artifact.ts';
import {
  computePhaseDurations,
  computeWallClockSeconds,
  fetchIssueData,
  formatIssueAsPrompt,
  fetchPrContext,
  gatherEvalContext,
  gatherStageArtifacts,
  convertToRoutingDecision,
  fetchRoutingDecision,
  fetchRoutingCompleteRawWithArchive,
  resetEvalContextGathererShellDependenciesForTest,
  setEvalContextGathererShellDependenciesForTest,
} from './eval-context-gatherer.ts';

type ShellCall = [string, { encoding: string; cwd: string }];

const shellMock = {
  calls: [] as ShellCall[],
  queuedImplementations: [] as Array<(command: string, options: ShellCall[1]) => string>,
  implementation: (() => '') as (command: string, options: ShellCall[1]) => string,
  reset() {
    this.calls = [];
    this.queuedImplementations = [];
    this.implementation = (_command: string, _options: ShellCall[1]) => '';
  },
  mockReturnValue(value: string) {
    this.implementation = (_command: string, _options: ShellCall[1]) => value;
    return this;
  },
  mockImplementation(implementation: (command: string, options: ShellCall[1]) => string) {
    this.implementation = implementation;
    return this;
  },
  mockReturnValueOnce(value: string) {
    this.queuedImplementations.push(() => value);
    return this;
  },
  mockImplementationOnce(implementation: (command: string, options: ShellCall[1]) => string) {
    this.queuedImplementations.push(implementation);
    return this;
  },
  exec(command: string, options: ShellCall[1]) {
    this.calls.push([command, options]);
    return (this.queuedImplementations.shift() ?? this.implementation)(command, options);
  },
};

describe('eval-context-gatherer', () => {
  beforeEach(() => {
    shellMock.reset();
    setEvalContextGathererShellDependenciesForTest({
      escapeShellArg: (arg) => `'${arg}'`,
      execShellCommand: shellMock.exec.bind(shellMock),
      fetchPrDiff: (prNumber, repoDir) => {
        try {
          const text = shellMock.exec(`gh pr diff ${prNumber}`, { encoding: 'utf-8', cwd: repoDir });
          return { kind: 'diff', text, source: 'gh-pr-diff', bytes: Buffer.byteLength(text), attempts: [] };
        } catch (error) {
          return {
            kind: 'unavailable',
            reason: 'gh_error',
            detail: error instanceof Error ? error.message : String(error),
            attempts: [],
          };
        }
      },
    });
  });

  afterEach(() => {
    resetEvalContextGathererShellDependenciesForTest();
  });

  describe('fetchIssueData', () => {
    it('should fetch and parse issue data', () => {
      const mockIssue = {
        identifier: 'HOK-870',
        title: 'Test Issue',
        description: 'Test description',
      };

      shellMock.mockReturnValue(
        JSON.stringify(mockIssue)
      );

      const result = fetchIssueData('HOK-870', '/repo');

      expect(result).toEqual(mockIssue);
      expect(shellMock.calls.length).toBeGreaterThan(0);
      expect(shellMock.calls[0][0]).toContain('HOK-870');
      expect(shellMock.calls[0][1]).toEqual({ encoding: 'utf-8', cwd: '/repo' });
    });

    it('should return null on fetch failure', () => {
      shellMock.mockImplementation(() => {
        throw new Error('fetch failed');
      });

      const result = fetchIssueData('HOK-870', '/repo');

      expect(result).toBeNull();
    });

    it('should return null on JSON parse failure', () => {
      shellMock.mockReturnValue('invalid json');

      const result = fetchIssueData('HOK-870', '/repo');

      expect(result).toBeNull();
    });
  });

  describe('formatIssueAsPrompt', () => {
    it('should format issue with all fields', () => {
      const issue = {
        identifier: 'HOK-870',
        title: 'Test Issue',
        description: 'Test description',
      };

      const result = formatIssueAsPrompt(issue, 'HOK-870');

      expect(result).toContain('HOK-870: Test Issue');
      expect(result).toContain('Test description');
    });

    it('should handle missing description', () => {
      const issue = {
        identifier: 'HOK-870',
        title: 'Test Issue',
      };

      const result = formatIssueAsPrompt(issue, 'HOK-870');

      expect(result).toContain('HOK-870: Test Issue');
    });

    it('should handle null issue', () => {
      const result = formatIssueAsPrompt(null, 'HOK-870');

      expect(result).toBe('Issue: HOK-870 (details unavailable)');
    });
  });

  describe('fetchPrContext', () => {
    it('should fetch PR URL and diff', () => {
      shellMock
        .mockReturnValueOnce('https://github.com/user/repo/pull/123')
        .mockReturnValueOnce('diff --git a/file.ts b/file.ts\n...');

      const result = fetchPrContext('123', '/repo');

      expect(result.url).toBe('https://github.com/user/repo/pull/123');
      expect(result.diff).toContain('diff --git');
    });

    it('should handle URL fetch failure gracefully', () => {
      shellMock
        .mockImplementationOnce(() => { throw new Error('failed'); })
        .mockReturnValueOnce('diff content');

      const result = fetchPrContext('123', '/repo');

      expect(result.url).toBe('');
      expect(result.diff).toBe('diff content');
    });

    it('should handle diff fetch failure gracefully', () => {
      shellMock
        .mockReturnValueOnce('https://github.com/user/repo/pull/123')
        .mockImplementationOnce(() => { throw new Error('failed'); });

      const result = fetchPrContext('123', '/repo');

      expect(result.url).toBe('https://github.com/user/repo/pull/123');
      expect(result.diff).toBe('');
      expect(result.availability.available).toBe(false);
    });

    it('should handle both fetch failures gracefully', () => {
      shellMock.mockImplementation(() => {
        throw new Error('failed');
      });

      const result = fetchPrContext('123', '/repo');

      expect(result.url).toBe('');
      expect(result.diff).toBe('');
      expect(result.availability.available).toBe(false);
    });
  });

  describe('gatherEvalContext', () => {
    it('should gather all context successfully', () => {
      const mockIssue = {
        identifier: 'HOK-870',
        title: 'Test Issue',
        description: 'Test description',
      };

      shellMock
        .mockReturnValueOnce(JSON.stringify(mockIssue)) // issue fetch
        .mockReturnValueOnce('https://github.com/user/repo/pull/123') // PR URL
        .mockReturnValueOnce('diff content'); // PR diff

      const result = gatherEvalContext({
        issueId: 'HOK-870',
        prNumber: '123',
        repoDir: '/repo',
      });

      expect(result.taskPrompt).toContain('HOK-870: Test Issue');
      expect(result.prDiff).toBe('diff content');
      expect(result.prUrl).toBe('https://github.com/user/repo/pull/123');
      expect(result.issueData).toEqual(mockIssue);
    });

    it('should use provided prUrl if given', () => {
      shellMock
        .mockReturnValueOnce('https://github.com/user/repo/pull/123') // PR URL (ignored)
        .mockReturnValueOnce('diff content'); // PR diff

      const result = gatherEvalContext({
        prNumber: '123',
        prUrl: 'https://custom.url',
        repoDir: '/repo',
      });

      expect(result.prUrl).toBe('https://custom.url');
    });

    it('should handle missing issueId', () => {
      shellMock
        .mockReturnValueOnce('https://github.com/user/repo/pull/123')
        .mockReturnValueOnce('diff content');

      const result = gatherEvalContext({
        prNumber: '123',
        repoDir: '/repo',
      });

      expect(result.taskPrompt).toBe('Issue:  (details unavailable)');
      expect(result.issueData).toBeNull();
    });

    it('should handle missing prNumber', () => {
      const mockIssue = {
        identifier: 'HOK-870',
        title: 'Test Issue',
        description: 'Test description',
      };

      shellMock
        .mockReturnValueOnce(JSON.stringify(mockIssue));

      const result = gatherEvalContext({
        issueId: 'HOK-870',
        repoDir: '/repo',
      });

      expect(result.prDiff).toBe('');
      expect(result.prUrl).toBe('');
    });

    it('should handle all fetch failures gracefully', () => {
      shellMock.mockImplementation(() => {
        throw new Error('failed');
      });

      const result = gatherEvalContext({
        issueId: 'HOK-870',
        prNumber: '123',
        repoDir: '/repo',
      });

      expect(result.taskPrompt).toContain('details unavailable');
      expect(result.prDiff).toBe('');
      expect(result.prDiffAvailability.available).toBe(false);
      expect(result.prUrl).toBe('');
      expect(result.issueData).toBeNull();
    });
  });

  describe('computeWallClockSeconds', () => {
    it('should return null when git log is empty', () => {
      shellMock.mockReturnValue('');

      const result = computeWallClockSeconds('/repo', 'task/test');

      expect(result).toBeNull();
      expect(shellMock.calls[0][0]).toContain("git log 'main'..'task/test' --format=\"%ct\" --reverse");
      expect(shellMock.calls[0][1]).toEqual({ encoding: 'utf-8', cwd: '/repo' });
    });

    it('should return null for a single commit timestamp', () => {
      shellMock.mockReturnValue('1710000000');

      const result = computeWallClockSeconds('/repo', 'task/test');

      expect(result).toBeNull();
    });

    it('should return the elapsed seconds for multiple commits', () => {
      shellMock.mockReturnValue(
        '1710000000\n1710000015\n1710000120'
      );

      const result = computeWallClockSeconds('/repo', 'task/test');

      expect(result).toBe(120);
    });

    it('should ignore malformed timestamps when valid endpoints remain', () => {
      shellMock.mockReturnValue(
        '1710000000\nnot-a-number\n1710000060\n0'
      );

      const result = computeWallClockSeconds('/repo', 'task/test');

      expect(result).toBe(60);
    });

    it('should return null on git errors', () => {
      shellMock.mockImplementation(() => {
        throw new Error('git failed');
      });

      const result = computeWallClockSeconds('/repo', 'missing-branch');

      expect(result).toBeNull();
    });
  });

  describe('computePhaseDurations', () => {
    function makeTmpDir(): string {
      return fs.mkdtempSync(nodePath.join(os.tmpdir(), 'phase-durations-'));
    }

    it('returns all completed phase durations and total', () => {
      const repoDir = makeTmpDir();
      const featureDir = nodePath.join(repoDir, 'features', 'accurate-wall-clock');
      fs.mkdirSync(featureDir, { recursive: true });
      fs.writeFileSync(
        nodePath.join(featureDir, '.planning-result.json'),
        JSON.stringify({
          startedAt: '2026-05-31T10:00:00.000Z',
          finishedAt: '2026-05-31T10:05:30.000Z',
        }),
      );
      fs.writeFileSync(
        nodePath.join(featureDir, '.coding-result.json'),
        JSON.stringify({
          startedAt: '2026-05-31T10:06:00.000Z',
          finishedAt: '2026-05-31T10:21:00.000Z',
        }),
      );
      fs.writeFileSync(
        nodePath.join(featureDir, '.review-result.json'),
        JSON.stringify({
          startedAt: '2026-05-31T10:21:00.000Z',
          finishedAt: '2026-05-31T10:24:15.000Z',
        }),
      );

      try {
        expect(computePhaseDurations(repoDir, 'accurate-wall-clock')).toEqual({
          planning: 330,
          coding: 900,
          review: 195,
          total: 1425,
        });
      } finally {
        fs.rmSync(repoDir, { recursive: true, force: true });
      }
    });

    it('leaves missing phase files undefined', () => {
      const repoDir = makeTmpDir();
      const featureDir = nodePath.join(repoDir, 'features', 'accurate-wall-clock');
      fs.mkdirSync(featureDir, { recursive: true });
      fs.writeFileSync(
        nodePath.join(featureDir, '.coding-result.json'),
        JSON.stringify({
          startedAt: '2026-05-31T10:06:00.000Z',
          finishedAt: '2026-05-31T10:21:00.000Z',
        }),
      );

      try {
        expect(computePhaseDurations(repoDir, 'accurate-wall-clock')).toEqual({
          coding: 900,
          total: 900,
        });
      } finally {
        fs.rmSync(repoDir, { recursive: true, force: true });
      }
    });

    it('ignores incomplete phase result files', () => {
      const repoDir = makeTmpDir();
      const featureDir = nodePath.join(repoDir, 'features', 'accurate-wall-clock');
      fs.mkdirSync(featureDir, { recursive: true });
      fs.writeFileSync(
        nodePath.join(featureDir, '.planning-result.json'),
        JSON.stringify({
          startedAt: '2026-05-31T10:00:00.000Z',
        }),
      );

      try {
        expect(computePhaseDurations(repoDir, 'accurate-wall-clock')).toBeUndefined();
      } finally {
        fs.rmSync(repoDir, { recursive: true, force: true });
      }
    });
  });

  describe('convertToRoutingDecision', () => {
    it('should build candidates from unique models', () => {
      const result = convertToRoutingDecision({
        planner: 'claude-sonnet-4-5-20250929',
        coder: 'claude-opus-4-6',
        reviewer: 'claude-haiku-4-5-20251001',
      });

      expect(result.candidates).toHaveLength(3);
      expect(result.candidates.map((c) => c.modelId)).toEqual([
        'claude-sonnet-4-5-20250929',
        'claude-opus-4-6',
        'claude-haiku-4-5-20251001',
      ]);
    });

    it('should deduplicate models when planner and coder are the same', () => {
      const result = convertToRoutingDecision({
        planner: 'claude-sonnet-4-5-20250929',
        coder: 'claude-sonnet-4-5-20250929',
        reviewer: 'claude-haiku-4-5-20251001',
      });

      expect(result.candidates).toHaveLength(2);
      expect(result.candidates.map((c) => c.modelId)).toEqual([
        'claude-sonnet-4-5-20250929',
        'claude-haiku-4-5-20251001',
      ]);
    });

    it('should set chosen to coder model', () => {
      const result = convertToRoutingDecision({
        planner: 'claude-sonnet-4-5-20250929',
        coder: 'claude-opus-4-6',
        reviewer: 'claude-haiku-4-5-20251001',
      });

      expect(result.chosen).toEqual({
        agentType: 'claude',
        modelId: 'claude-opus-4-6',
      });
    });

    it('should set decisionPolicyVersion to baseline', () => {
      const result = convertToRoutingDecision({
        planner: 'model-a',
        coder: 'model-b',
        reviewer: 'model-c',
      });

      expect(result.decisionPolicyVersion).toBe('baseline');
      expect(result.routeArtifactSchemaVersion).toBe(ROUTE_ARTIFACT_SCHEMA_VERSION);
      expect(result.policyResolverVersion).toBe(POLICY_RESOLVER_VERSION);
    });

    it('maps stage-aware routing metadata into structured policy fields', () => {
      const result = convertToRoutingDecision({
        planner: 'model-a',
        coder: 'model-b',
        reviewer: 'model-c',
        routingMode: 'stage-aware',
        provenance: {
          source: 'live',
          inputKind: 'issue',
          routerMode: 'normal',
        },
      });

      expect(result.decisionPolicyVersion).toBe('stage-aware');
      expect(result.routeMode).toBe('stage-aware');
      expect(result.operatingModeDependency).toBe('normal');
    });

    it('maps hokusai routing metadata into structured policy fields', () => {
      const result = convertToRoutingDecision({
        planner: 'model-a',
        coder: 'model-b',
        reviewer: 'model-c',
        routingMode: 'hokusai',
        provenance: {
          source: 'live',
          inputKind: 'issue',
          routerMode: 'normal',
        },
      });

      expect(result.decisionPolicyVersion).toBe('hokusai');
      expect(result.routeMode).toBe('hokusai');
    });

    it('preserves operating mode separately from policy source', () => {
      const result = convertToRoutingDecision({
        planner: 'model-a',
        coder: 'model-b',
        reviewer: 'model-c',
        routingMode: 'stage-aware',
        provenance: {
          source: 'live',
          inputKind: 'issue',
          routerMode: 'survival',
        },
      });

      expect(result.decisionPolicyVersion).toBe('stage-aware');
      expect(result.operatingModeDependency).toBe('survival');
    });

    it('should include depth and mode in rationale', () => {
      const result = convertToRoutingDecision({
        planner: 'model-a',
        coder: 'model-b',
        reviewer: 'model-c',
        planDepth: 'light',
        codeDepth: 'medium',
        reviewMode: 'static',
      });

      expect(result.decisionRationale).toContain('planDepth=light');
      expect(result.decisionRationale).toContain('codeDepth=medium');
      expect(result.decisionRationale).toContain('reviewMode=static');
    });

    it('should handle missing depth/mode fields', () => {
      const result = convertToRoutingDecision({
        planner: 'model-a',
        coder: 'model-b',
        reviewer: 'model-c',
      });

      expect(result.decisionRationale).toContain('planner=model-a');
      expect(result.decisionRationale).not.toContain('planDepth');
    });
  });

  describe('fetchRoutingDecision', () => {
    function makeTmpDir(): string {
      return fs.mkdtempSync(nodePath.join(os.tmpdir(), 'eval-test-'));
    }

    it('should load valid routing file', () => {
      const tmpDir = makeTmpDir();
      const featureDir = nodePath.join(tmpDir, 'features', 'my-feature');
      fs.mkdirSync(featureDir, { recursive: true });
      fs.writeFileSync(
        nodePath.join(featureDir, '.routing-complete'),
        JSON.stringify({
          planner: 'model-a',
          coder: 'model-b',
          reviewer: 'model-c',
          planDepth: 'light',
          codeDepth: 'medium',
          reviewMode: 'static',
        })
      );

      const result = fetchRoutingDecision(tmpDir, 'my-feature');

      expect(result).not.toBeNull();
      expect(result!.candidates).toHaveLength(3);
      expect(result!.decisionPolicyVersion).toBe('baseline');
      expect(result!.routeArtifactSchemaVersion).toBe(ROUTE_ARTIFACT_SCHEMA_VERSION);
      expect(result!.policyResolverVersion).toBe(POLICY_RESOLVER_VERSION);
      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should derive stage-aware routing metadata from the routing file', () => {
      const tmpDir = makeTmpDir();
      const featureDir = nodePath.join(tmpDir, 'features', 'my-feature');
      fs.mkdirSync(featureDir, { recursive: true });
      fs.writeFileSync(
        nodePath.join(featureDir, '.routing-complete'),
        JSON.stringify({
          planner: 'model-a',
          coder: 'model-b',
          reviewer: 'model-c',
          routingMode: 'stage-aware',
          provenance: {
            source: 'live',
            inputKind: 'issue',
            routerMode: 'survival',
          },
        })
      );

      const result = fetchRoutingDecision(tmpDir, 'my-feature');

      expect(result).not.toBeNull();
      expect(result!.decisionPolicyVersion).toBe('stage-aware');
      expect(result!.routeMode).toBe('stage-aware');
      expect(result!.operatingModeDependency).toBe('survival');
      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should return null for missing file', () => {
      const tmpDir = makeTmpDir();
      fs.mkdirSync(nodePath.join(tmpDir, 'features', 'my-feature'), { recursive: true });

      const result = fetchRoutingDecision(tmpDir, 'my-feature');

      expect(result).toBeNull();
      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should return null for invalid JSON', () => {
      const tmpDir = makeTmpDir();
      const featureDir = nodePath.join(tmpDir, 'features', 'my-feature');
      fs.mkdirSync(featureDir, { recursive: true });
      fs.writeFileSync(nodePath.join(featureDir, '.routing-complete'), 'not json');

      const result = fetchRoutingDecision(tmpDir, 'my-feature');

      expect(result).toBeNull();
      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should return null when required fields missing', () => {
      const tmpDir = makeTmpDir();
      const featureDir = nodePath.join(tmpDir, 'features', 'my-feature');
      fs.mkdirSync(featureDir, { recursive: true });
      fs.writeFileSync(
        nodePath.join(featureDir, '.routing-complete'),
        JSON.stringify({ planner: 'model-a' }) // missing coder and reviewer
      );

      const result = fetchRoutingDecision(tmpDir, 'my-feature');

      expect(result).toBeNull();
      fs.rmSync(tmpDir, { recursive: true });
    });
  });

  describe('fetchRoutingCompleteRawWithArchive', () => {
    function makeTmpDir(): string {
      return fs.mkdtempSync(nodePath.join(os.tmpdir(), 'routing-complete-'));
    }

    it('returns worktree routing data when present', () => {
      const repoDir = makeTmpDir();
      const worktreeDir = nodePath.join(repoDir, 'worktree');
      const slug = 'my-feature';
      const issueId = 'HOK-1328';
      const featureDir = nodePath.join(worktreeDir, 'features', slug);
      fs.mkdirSync(featureDir, { recursive: true });
      fs.writeFileSync(
        nodePath.join(featureDir, '.routing-complete'),
        JSON.stringify({
          planner: 'model-a',
          coder: 'model-b',
          reviewer: 'model-c',
        }),
      );

      try {
        expect(fetchRoutingCompleteRawWithArchive(repoDir, slug, issueId, worktreeDir)).toEqual({
          planner: 'model-a',
          coder: 'model-b',
          reviewer: 'model-c',
        });
      } finally {
        fs.rmSync(repoDir, { recursive: true, force: true });
      }
    });

    it('falls back to archived routing data when worktree is missing', () => {
      const repoDir = makeTmpDir();
      const slug = 'my-feature';
      const issueId = 'HOK-1328';
      const archiveDir = nodePath.join(repoDir, '.wavemill', 'evals', 'artifacts', issueId);
      fs.mkdirSync(archiveDir, { recursive: true });
      fs.writeFileSync(
        nodePath.join(archiveDir, 'routing-complete.json'),
        JSON.stringify({
          planner: 'model-a',
          coder: 'model-b',
          reviewer: 'model-c',
        }),
      );

      try {
        expect(fetchRoutingCompleteRawWithArchive(repoDir, slug, issueId)).toEqual({
          planner: 'model-a',
          coder: 'model-b',
          reviewer: 'model-c',
        });
      } finally {
        fs.rmSync(repoDir, { recursive: true, force: true });
      }
    });

    it('returns null for malformed archived routing data', () => {
      const repoDir = makeTmpDir();
      const issueId = 'HOK-1328';
      const archiveDir = nodePath.join(repoDir, '.wavemill', 'evals', 'artifacts', issueId);
      fs.mkdirSync(archiveDir, { recursive: true });
      fs.writeFileSync(nodePath.join(archiveDir, 'routing-complete.json'), '{"planner":true}');

      try {
        expect(fetchRoutingCompleteRawWithArchive(repoDir, 'my-feature', issueId)).toBeNull();
      } finally {
        fs.rmSync(repoDir, { recursive: true, force: true });
      }
    });

    it('preserves maxCostUsd from archived routing data', () => {
      const repoDir = makeTmpDir();
      const issueId = 'HOK-1328';
      const archiveDir = nodePath.join(repoDir, '.wavemill', 'evals', 'artifacts', issueId);
      fs.mkdirSync(archiveDir, { recursive: true });
      fs.writeFileSync(
        nodePath.join(archiveDir, 'routing-complete.json'),
        JSON.stringify({
          planner: 'model-a',
          coder: 'model-b',
          reviewer: 'model-c',
          maxCostUsd: 7.5,
        }),
      );

      try {
        expect(fetchRoutingCompleteRawWithArchive(repoDir, 'my-feature', issueId)).toEqual({
          planner: 'model-a',
          coder: 'model-b',
          reviewer: 'model-c',
          maxCostUsd: 7.5,
        });
      } finally {
        fs.rmSync(repoDir, { recursive: true, force: true });
      }
    });
  });

  describe('gatherStageArtifacts archived routing', () => {
    function makeTmpDir(): string {
      return fs.mkdtempSync(nodePath.join(os.tmpdir(), 'stage-artifacts-'));
    }

    it('converts archived raw routing data into a routing decision', () => {
      const repoDir = makeTmpDir();
      const issueId = 'HOK-1494';
      const branch = 'task/fix-archived-routing';
      const featureDir = nodePath.join(repoDir, 'features', 'fix-archived-routing');
      const archiveDir = nodePath.join(repoDir, '.wavemill', 'evals', 'artifacts', issueId);
      fs.mkdirSync(featureDir, { recursive: true });
      fs.mkdirSync(archiveDir, { recursive: true });
      fs.writeFileSync(
        nodePath.join(archiveDir, 'routing-complete.json'),
        JSON.stringify({
          planner: 'model-a',
          coder: 'model-b',
          reviewer: 'model-c',
          expectedSuccess: 0.8,
          expectedCost: 2.5,
          confidence: 0.7,
          reasoning: ['repo risk', 'balanced route'],
          signals: {
            taskType: 'feature',
            riskScore: 0.4,
            taskDifficulty: 'medium',
          },
          codeDepth: 'deep',
          reviewMode: 'static+llm',
        }),
      );
      fs.writeFileSync(
        nodePath.join(featureDir, '.planning-result.json'),
        JSON.stringify({
          stage: 'planning',
          status: 'completed',
          agent: 'codex',
          model: 'claude-sonnet-4-6',
          startedAt: '2026-05-31T10:00:00.000Z',
          finishedAt: '2026-05-31T10:02:00.000Z',
        }),
      );

      try {
        const result = gatherStageArtifacts(repoDir, issueId, branch);
        expect(result.routingDecision).toEqual({
          candidates: [
            { agentType: 'claude', modelId: 'model-a' },
            { agentType: 'claude', modelId: 'model-b' },
            { agentType: 'claude', modelId: 'model-c' },
          ],
          chosen: { agentType: 'claude', modelId: 'model-b' },
          decisionPolicyVersion: 'baseline',
          decisionRationale:
            'Routing: planner=model-a, coder=model-b, reviewer=model-c; codeDepth=deep, reviewMode=static+llm',
          routeArtifactSchemaVersion: ROUTE_ARTIFACT_SCHEMA_VERSION,
          policyResolverVersion: POLICY_RESOLVER_VERSION,
        });
        expect(result.routePrediction).toEqual({
          expectedSuccess: 0.8,
          expectedCostUsd: 2.5,
          confidence: 0.7,
          riskScore: 0.4,
          taskType: 'feature',
          taskDifficulty: 'medium',
          topFeatures: ['repo risk', 'balanced route', 'taskType=feature', 'taskDifficulty=medium', 'riskScore=0.4'],
          rationaleSummary: 'repo risk balanced route',
        });
        expect(result.executedPlanning).toEqual({
          agent: 'codex',
          model: 'claude-sonnet-4-6',
          status: 'completed',
          source: '.planning-result.json',
        });
        expect(result.planningExecutionOutcome).toEqual({
          agent: 'codex',
          model: 'claude-sonnet-4-6',
          status: 'completed',
          source: '.planning-result.json',
        });
        expect(result.phaseDurations).toEqual({
          planning: 120,
          total: 120,
        });
        // HOK-2958: the directory holding stage results is exposed so the
        // execution-economics collector can read windows via stage-result.ts.
        expect(result.stageResultsDir).toBe(featureDir);
      } finally {
        fs.rmSync(repoDir, { recursive: true, force: true });
      }
    });

    it('omits stageResultsDir when no stage result files exist (HOK-2958)', () => {
      const repoDir = makeTmpDir();
      const issueId = 'HOK-2958';
      const branch = 'task/no-stage-results';
      fs.mkdirSync(nodePath.join(repoDir, 'features', 'no-stage-results'), { recursive: true });

      try {
        const result = gatherStageArtifacts(repoDir, issueId, branch);
        expect(result.stageResultsDir).toBeUndefined();
      } finally {
        fs.rmSync(repoDir, { recursive: true, force: true });
      }
    });

    it('omits routingDecision when archived routing data is malformed', () => {
      const repoDir = makeTmpDir();
      const issueId = 'HOK-1494';
      const branch = 'task/fix-archived-routing';
      const archiveDir = nodePath.join(repoDir, '.wavemill', 'evals', 'artifacts', issueId);
      fs.mkdirSync(archiveDir, { recursive: true });
      fs.writeFileSync(nodePath.join(archiveDir, 'routing-complete.json'), '{"planner":true}');

      try {
        const result = gatherStageArtifacts(repoDir, issueId, branch);
        expect(result.routingDecision).toBeUndefined();
        expect(result.routePrediction).toBeUndefined();
      } finally {
        fs.rmSync(repoDir, { recursive: true, force: true });
      }
    });

    it('loads latest per-role resolved-model routing from archived routing.jsonl', () => {
      const repoDir = makeTmpDir();
      const issueId = 'HOK-1632';
      const branch = 'task/emit-routing';
      const archiveDir = nodePath.join(repoDir, '.wavemill', 'evals', 'artifacts', issueId);
      fs.mkdirSync(archiveDir, { recursive: true });
      fs.writeFileSync(
        nodePath.join(archiveDir, 'routing.jsonl'),
        [
          JSON.stringify({
            role: 'planner',
            requestedSelector: { kind: 'pinned', modelId: 'gpt-5.5' },
            resolvedModelId: 'gpt-5.5',
            sourceLayer: 'user',
          }),
          JSON.stringify({
            role: 'planner',
            requestedSelector: { kind: 'pinned', modelId: 'gpt-5.4' },
            resolvedModelId: 'gpt-5.4',
            sourceLayer: 'policy',
          }),
          'not json',
          JSON.stringify({
            role: 'reviewer',
            requestedSelector: { kind: 'pinned', modelId: 'claude-sonnet-4-6' },
            resolvedModelId: 'claude-sonnet-4-6',
            sourceLayer: 'user',
          }),
        ].join('\n'),
      );

      try {
        const result = gatherStageArtifacts(repoDir, issueId, branch);
        expect(result.routing?.planner?.resolvedModelId).toBe('gpt-5.4');
        expect(result.routing?.reviewer?.resolvedModelId).toBe('claude-sonnet-4-6');
      } finally {
        fs.rmSync(repoDir, { recursive: true, force: true });
      }
    });

    it('omits executed planning when planning-result is malformed', () => {
      const repoDir = makeTmpDir();
      const issueId = 'HOK-1728';
      const branch = 'task/clarify-routing';
      const featureDir = nodePath.join(repoDir, 'features', 'clarify-routing');
      fs.mkdirSync(featureDir, { recursive: true });
      fs.writeFileSync(nodePath.join(featureDir, '.planning-result.json'), 'not json');

      try {
        const result = gatherStageArtifacts(repoDir, issueId, branch);
        expect(result.executedPlanning).toBeUndefined();
        expect(result.planningExecutionOutcome).toBeUndefined();
      } finally {
        fs.rmSync(repoDir, { recursive: true, force: true });
      }
    });

    it('loads structured successful planning execution outcome', () => {
      const repoDir = makeTmpDir();
      const issueId = 'HOK-2593';
      const branch = 'task/capture-planning-outcome';
      const featureDir = nodePath.join(repoDir, 'features', 'capture-planning-outcome');
      fs.mkdirSync(featureDir, { recursive: true });
      fs.writeFileSync(
        nodePath.join(featureDir, '.planning-result.json'),
        JSON.stringify({
          stage: 'planning',
          status: 'awaiting_user',
          agent: 'native',
          model: 'claude-sonnet-5',
          failureReason: null,
          artifacts: {
            type: 'planning',
            planArtifactValid: true,
            approvalReady: true,
            bounds: {
              maxTurns: 40,
              maxToolCalls: 120,
              maxWallClockMs: 1200000,
            },
            usage: {
              turnsCompleted: 12,
              toolCallsExecuted: 31,
              wallClockMs: 300000,
              totalInputTokens: 10000,
              totalOutputTokens: 2000,
              totalCostUsd: 0.25,
            },
            promptRef: {
              id: 'native-planning',
              version: 'sha256:abc',
            },
          },
        }),
      );

      try {
        const result = gatherStageArtifacts(repoDir, issueId, branch);
        expect(result.planningExecutionOutcome).toEqual({
          agent: 'native',
          model: 'claude-sonnet-5',
          status: 'awaiting_user',
          failureReason: null,
          planArtifactValid: true,
          approvalReady: true,
          bounds: {
            maxTurns: 40,
            maxToolCalls: 120,
            maxWallClockMs: 1200000,
          },
          usage: {
            turnsCompleted: 12,
            toolCallsExecuted: 31,
            wallClockMs: 300000,
            totalInputTokens: 10000,
            totalOutputTokens: 2000,
            totalCostUsd: 0.25,
          },
          promptRef: {
            id: 'native-planning',
            version: 'sha256:abc',
          },
          source: '.planning-result.json',
        });
      } finally {
        fs.rmSync(repoDir, { recursive: true, force: true });
      }
    });

    it('loads structured turn_limit planning execution outcome', () => {
      const repoDir = makeTmpDir();
      const issueId = 'HOK-2593';
      const branch = 'task/planner-hit-limit';
      const featureDir = nodePath.join(repoDir, 'features', 'planner-hit-limit');
      fs.mkdirSync(featureDir, { recursive: true });
      fs.writeFileSync(
        nodePath.join(featureDir, '.planning-result.json'),
        JSON.stringify({
          stage: 'planning',
          status: 'failed',
          agent: 'native',
          model: 'moonshotai/kimi-k2.7-code',
          failureReason: 'turn_limit',
          artifacts: {
            type: 'planning',
            planArtifactValid: false,
            approvalReady: false,
            bounds: { maxTurns: 40 },
            usage: { turnsCompleted: 40, toolCallsExecuted: 72 },
          },
        }),
      );

      try {
        const result = gatherStageArtifacts(repoDir, issueId, branch);
        expect(result.planningExecutionOutcome).toEqual({
          agent: 'native',
          model: 'moonshotai/kimi-k2.7-code',
          status: 'failed',
          failureReason: 'turn_limit',
          planArtifactValid: false,
          approvalReady: false,
          bounds: { maxTurns: 40 },
          usage: { turnsCompleted: 40, toolCallsExecuted: 72 },
          source: '.planning-result.json',
        });
      } finally {
        fs.rmSync(repoDir, { recursive: true, force: true });
      }
    });
  });
});
