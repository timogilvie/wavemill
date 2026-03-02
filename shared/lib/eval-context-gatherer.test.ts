/**
 * Tests for eval-context-gatherer module.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as shellUtils from './shell-utils.ts';
import {
  fetchIssueData,
  formatIssueAsPrompt,
  fetchPrContext,
  gatherEvalContext,
} from './eval-context-gatherer.ts';

// Mock shell-utils
vi.mock('./shell-utils.ts', () => ({
  escapeShellArg: (arg: string) => `'${arg}'`,
  execShellCommand: vi.fn(),
}));

describe('eval-context-gatherer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('fetchIssueData', () => {
    it('should fetch and parse issue data', () => {
      const mockIssue = {
        identifier: 'HOK-870',
        title: 'Test Issue',
        description: 'Test description',
      };

      vi.mocked(shellUtils.execShellCommand).mockReturnValue(
        JSON.stringify(mockIssue)
      );

      const result = fetchIssueData('HOK-870', '/repo');

      expect(result).toEqual(mockIssue);
      expect(shellUtils.execShellCommand).toHaveBeenCalledWith(
        expect.stringContaining('HOK-870'),
        expect.objectContaining({ cwd: '/repo' })
      );
    });

    it('should return null on fetch failure', () => {
      vi.mocked(shellUtils.execShellCommand).mockImplementation(() => {
        throw new Error('fetch failed');
      });

      const result = fetchIssueData('HOK-870', '/repo');

      expect(result).toBeNull();
    });

    it('should return null on JSON parse failure', () => {
      vi.mocked(shellUtils.execShellCommand).mockReturnValue('invalid json');

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
      vi.mocked(shellUtils.execShellCommand)
        .mockReturnValueOnce('https://github.com/user/repo/pull/123')
        .mockReturnValueOnce('diff --git a/file.ts b/file.ts\n...');

      const result = fetchPrContext('123', '/repo');

      expect(result.url).toBe('https://github.com/user/repo/pull/123');
      expect(result.diff).toContain('diff --git');
    });

    it('should handle URL fetch failure gracefully', () => {
      vi.mocked(shellUtils.execShellCommand)
        .mockImplementationOnce(() => { throw new Error('failed'); })
        .mockReturnValueOnce('diff content');

      const result = fetchPrContext('123', '/repo');

      expect(result.url).toBe('');
      expect(result.diff).toBe('diff content');
    });

    it('should handle diff fetch failure gracefully', () => {
      vi.mocked(shellUtils.execShellCommand)
        .mockReturnValueOnce('https://github.com/user/repo/pull/123')
        .mockImplementationOnce(() => { throw new Error('failed'); });

      const result = fetchPrContext('123', '/repo');

      expect(result.url).toBe('https://github.com/user/repo/pull/123');
      expect(result.diff).toBe('(PR diff unavailable)');
    });

    it('should handle both fetch failures gracefully', () => {
      vi.mocked(shellUtils.execShellCommand).mockImplementation(() => {
        throw new Error('failed');
      });

      const result = fetchPrContext('123', '/repo');

      expect(result.url).toBe('');
      expect(result.diff).toBe('(PR diff unavailable)');
    });
  });

  describe('gatherEvalContext', () => {
    it('should gather all context successfully', () => {
      const mockIssue = {
        identifier: 'HOK-870',
        title: 'Test Issue',
        description: 'Test description',
      };

      vi.mocked(shellUtils.execShellCommand)
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
      vi.mocked(shellUtils.execShellCommand)
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
      vi.mocked(shellUtils.execShellCommand)
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

      vi.mocked(shellUtils.execShellCommand)
        .mockReturnValueOnce(JSON.stringify(mockIssue));

      const result = gatherEvalContext({
        issueId: 'HOK-870',
        repoDir: '/repo',
      });

      expect(result.prDiff).toBe('');
      expect(result.prUrl).toBe('');
    });

    it('should handle all fetch failures gracefully', () => {
      vi.mocked(shellUtils.execShellCommand).mockImplementation(() => {
        throw new Error('failed');
      });

      const result = gatherEvalContext({
        issueId: 'HOK-870',
        prNumber: '123',
        repoDir: '/repo',
      });

      expect(result.taskPrompt).toContain('details unavailable');
      expect(result.prDiff).toBe('(PR diff unavailable)');
      expect(result.prUrl).toBe('');
      expect(result.issueData).toBeNull();
    });
  });
});
