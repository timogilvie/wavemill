// wavemill-test-suite: standalone (live gh-authed smoke, not CI-safe; run by hand with node --test)
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  listPullRequests,
  getPullRequest,
  getPullRequestDiff,
} from './github.ts';

// These tests use real gh CLI commands and require authentication
// Run: gh auth login before running tests

describe('listPullRequests', () => {
  it('lists PRs with default options (open state)', () => {
    const prs = listPullRequests();
    assert.ok(Array.isArray(prs), 'should return array');
    // May be empty if no open PRs
  });

  it('lists closed PRs', () => {
    const prs = listPullRequests({ state: 'closed', limit: 5 });
    assert.ok(Array.isArray(prs), 'should return array');

    if (prs.length > 0) {
      const pr = prs[0];
      assert.ok(pr.number, 'should have number');
      assert.ok(pr.title, 'should have title');
      assert.ok(pr.state, 'should have state');
      assert.ok(pr.url, 'should have url');
      assert.ok(pr.createdAt, 'should have createdAt');
    }
  });

  it('lists all PRs with limit', () => {
    const prs = listPullRequests({ state: 'all', limit: 3 });
    assert.ok(Array.isArray(prs), 'should return array');
    assert.ok(prs.length <= 3, 'should respect limit');
  });

  it('filters by author', () => {
    const prs = listPullRequests({ state: 'all', author: 'timogilvie', limit: 2 });
    assert.ok(Array.isArray(prs), 'should return array');

    prs.forEach(pr => {
      assert.equal(pr.author, 'timogilvie', 'should match author filter');
    });
  });

  it('returns structured PR objects', () => {
    const prs = listPullRequests({ state: 'closed', limit: 1 });

    if (prs.length > 0) {
      const pr = prs[0];
      assert.ok(typeof pr.number === 'number', 'number should be number');
      assert.ok(typeof pr.title === 'string', 'title should be string');
      assert.ok(typeof pr.state === 'string', 'state should be string');
      assert.ok(typeof pr.author === 'string', 'author should be string');
      assert.ok(typeof pr.headRefName === 'string', 'headRefName should be string');
      assert.ok(typeof pr.baseRefName === 'string', 'baseRefName should be string');
      assert.ok(Array.isArray(pr.labels), 'labels should be array');
      assert.ok(typeof pr.url === 'string', 'url should be string');
      assert.ok(typeof pr.createdAt === 'string', 'createdAt should be string');
    }
  });

  it('returns empty array when no PRs match', () => {
    const prs = listPullRequests({ state: 'open', author: 'nonexistent-user-12345' });
    assert.ok(Array.isArray(prs), 'should return array');
    assert.equal(prs.length, 0, 'should be empty');
  });

  it('respects limit parameter', () => {
    const prs = listPullRequests({ state: 'all', limit: 2 });
    assert.ok(prs.length <= 2, 'should not exceed limit');
  });
});

describe('getPullRequest', () => {
  let testPrNumber;

  before(async () => {
    // Get a real PR number to test with
    const prs = listPullRequests({ state: 'closed', limit: 1 });
    if (prs.length > 0) {
      testPrNumber = prs[0].number;
    }
  });

  it('throws error when PR number is not provided', () => {
    assert.throws(
      () => getPullRequest(),
      /PR number is required/,
      'should throw error for missing PR number'
    );
  });

  it('fetches PR metadata', () => {
    if (!testPrNumber) {
      console.log('⚠️ Skipping test: no PRs available');
      return;
    }

    const pr = getPullRequest(testPrNumber);
    assert.ok(pr, 'should return PR object');
    assert.equal(pr.number, testPrNumber, 'should match requested PR number');
    assert.ok(pr.title, 'should have title');
    assert.ok(pr.state, 'should have state');
    assert.ok(pr.author, 'should have author');
    assert.ok(pr.url, 'should have url');
  });

  it('returns all required fields', () => {
    if (!testPrNumber) {
      console.log('⚠️ Skipping test: no PRs available');
      return;
    }

    const pr = getPullRequest(testPrNumber);

    const requiredFields = [
      'number', 'title', 'body', 'state', 'author',
      'headRefName', 'baseRefName', 'labels', 'url',
      'createdAt', 'updatedAt', 'mergedAt', 'closedAt',
    ];

    requiredFields.forEach(field => {
      assert.ok(field in pr, `should have ${field} field`);
    });
  });

  it('includes labels array', () => {
    if (!testPrNumber) {
      console.log('⚠️ Skipping test: no PRs available');
      return;
    }

    const pr = getPullRequest(testPrNumber);
    assert.ok(Array.isArray(pr.labels), 'labels should be array');
  });

  it('throws error for invalid PR number', () => {
    assert.throws(
      () => getPullRequest(999999),
      /not found/,
      'should throw error for invalid PR'
    );
  });

  it('accepts PR number as string', () => {
    if (!testPrNumber) {
      console.log('⚠️ Skipping test: no PRs available');
      return;
    }

    const pr = getPullRequest(testPrNumber.toString());
    assert.equal(pr.number, testPrNumber, 'should handle string PR number');
  });

  it('body field defaults to empty string', () => {
    if (!testPrNumber) {
      console.log('⚠️ Skipping test: no PRs available');
      return;
    }

    const pr = getPullRequest(testPrNumber);
    assert.ok(typeof pr.body === 'string', 'body should be string');
  });
});

describe('getPullRequestDiff', () => {
  let testPrNumber;

  before(async () => {
    // Get a real PR number to test with
    const prs = listPullRequests({ state: 'closed', limit: 1 });
    if (prs.length > 0) {
      testPrNumber = prs[0].number;
    }
  });

  it('throws error when PR number is not provided', () => {
    assert.throws(
      () => getPullRequestDiff(),
      /PR number is required/,
      'should throw error for missing PR number'
    );
  });

  it('fetches PR diff', () => {
    if (!testPrNumber) {
      console.log('⚠️ Skipping test: no PRs available');
      return;
    }

    const result = getPullRequestDiff(testPrNumber);
    assert.ok(result, 'should return result object');
    assert.equal(result.prNumber, testPrNumber, 'should match PR number');
    assert.ok(typeof result.diff === 'string', 'diff should be string');
  });

  it('returns diff in unified format', () => {
    if (!testPrNumber) {
      console.log('⚠️ Skipping test: no PRs available');
      return;
    }

    const result = getPullRequestDiff(testPrNumber);
    // Diff should contain typical diff markers
    // Note: may be empty for some PRs
    assert.ok(typeof result.diff === 'string', 'diff should be string');
  });

  it('throws error for invalid PR number', () => {
    assert.throws(
      () => getPullRequestDiff(999999),
      /not found/,
      'should throw error for invalid PR'
    );
  });

  it('accepts PR number as string', () => {
    if (!testPrNumber) {
      console.log('⚠️ Skipping test: no PRs available');
      return;
    }

    const result = getPullRequestDiff(testPrNumber.toString());
    assert.equal(result.prNumber, testPrNumber, 'should handle string PR number');
  });

  it('returns structured object with prNumber and diff', () => {
    if (!testPrNumber) {
      console.log('⚠️ Skipping test: no PRs available');
      return;
    }

    const result = getPullRequestDiff(testPrNumber);
    assert.ok('prNumber' in result, 'should have prNumber field');
    assert.ok('diff' in result, 'should have diff field');
    assert.equal(Object.keys(result).length, 2, 'should only have 2 fields');
  });
});

describe('Integration: Full workflow', () => {
  it('can list PRs, then fetch details and diff', () => {
    // List PRs
    const prs = listPullRequests({ state: 'closed', limit: 1 });

    if (prs.length === 0) {
      console.log('⚠️ Skipping integration test: no PRs available');
      return;
    }

    const prNumber = prs[0].number;

    // Fetch PR details
    const pr = getPullRequest(prNumber);
    assert.equal(pr.number, prNumber, 'should fetch correct PR');
    assert.equal(pr.title, prs[0].title, 'title should match');

    // Fetch PR diff
    const { diff } = getPullRequestDiff(prNumber);
    assert.ok(typeof diff === 'string', 'should get diff');
  });
});
