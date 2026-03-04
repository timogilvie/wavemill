#!/usr/bin/env -S npx tsx

/**
 * Health check for review tool setup.
 *
 * Validates:
 * - Claude CLI availability
 * - Authentication
 * - Network connectivity
 * - Simple test review
 *
 * Usage:
 *   npx tsx tools/check-review-setup.ts
 *   npm run check:review
 */

import { checkClaudeAvailability } from '../shared/lib/llm-cli.ts';
import { execShellCommand } from '../shared/lib/shell-utils.ts';

interface CheckResult {
  name: string;
  passed: boolean;
  message: string;
  details?: string[];
}

/**
 * Check Claude CLI availability
 */
async function checkCLI(): Promise<CheckResult> {
  try {
    const health = await checkClaudeAvailability({ verbose: false });

    if (health.available) {
      return {
        name: 'Claude CLI',
        passed: true,
        message: `Available (${health.version || 'version unknown'})`,
        details: [
          `Command: ${health.command}`,
          `In PATH: ${health.diagnostics?.inPath ? 'Yes' : 'No'}`,
          `Executable: ${health.diagnostics?.executable ? 'Yes' : 'No'}`,
          `Auth working: ${health.diagnostics?.authWorking ? 'Yes' : 'No'}`,
        ],
      };
    } else {
      return {
        name: 'Claude CLI',
        passed: false,
        message: health.error || 'Not available',
        details: [
          `Command: ${health.command}`,
          `In PATH: ${health.diagnostics?.inPath ? 'Yes' : 'No'}`,
          `Executable: ${health.diagnostics?.executable ? 'Yes' : 'No'}`,
          'See troubleshooting steps below',
        ],
      };
    }
  } catch (error) {
    return {
      name: 'Claude CLI',
      passed: false,
      message: `Check failed: ${(error as Error).message}`,
    };
  }
}

/**
 * Check network connectivity to Anthropic API
 */
async function checkNetwork(): Promise<CheckResult> {
  try {
    const result = execShellCommand('curl -I -s -o /dev/null -w "%{http_code}" https://api.anthropic.com --max-time 10', {
      encoding: 'utf-8',
      timeout: 15000,
    });

    const statusCode = result.toString().trim();

    // 200-299 = success, 401 = auth issue but network is working
    if (statusCode.match(/^[23]\d{2}$/) || statusCode === '401') {
      return {
        name: 'Network Connectivity',
        passed: true,
        message: `Can reach Anthropic API (HTTP ${statusCode})`,
      };
    } else {
      return {
        name: 'Network Connectivity',
        passed: false,
        message: `Unexpected status: HTTP ${statusCode}`,
        details: [
          'Check your internet connection',
          'Check if firewall is blocking api.anthropic.com',
        ],
      };
    }
  } catch (error) {
    return {
      name: 'Network Connectivity',
      passed: false,
      message: `Cannot reach Anthropic API: ${(error as Error).message}`,
      details: [
        'Check your internet connection',
        'Check if firewall is blocking api.anthropic.com',
        'Try: curl -I https://api.anthropic.com',
      ],
    };
  }
}

/**
 * Check if git is available (required for review tool)
 */
async function checkGit(): Promise<CheckResult> {
  try {
    const result = execShellCommand('git --version', {
      encoding: 'utf-8',
      timeout: 5000,
    });

    const version = result.toString().trim();

    return {
      name: 'Git',
      passed: true,
      message: version,
    };
  } catch (error) {
    return {
      name: 'Git',
      passed: false,
      message: `Git not found: ${(error as Error).message}`,
      details: [
        'Install git: https://git-scm.com/downloads',
      ],
    };
  }
}

/**
 * Check if running in a git repository
 */
async function checkGitRepo(): Promise<CheckResult> {
  try {
    const result = execShellCommand('git rev-parse --is-inside-work-tree', {
      encoding: 'utf-8',
      timeout: 5000,
      cwd: process.cwd(),
    });

    const isRepo = result.toString().trim() === 'true';

    if (isRepo) {
      // Get current branch
      const branch = execShellCommand('git branch --show-current', {
        encoding: 'utf-8',
        timeout: 5000,
        cwd: process.cwd(),
      }).toString().trim();

      return {
        name: 'Git Repository',
        passed: true,
        message: `In repository (branch: ${branch || 'detached HEAD'})`,
      };
    } else {
      return {
        name: 'Git Repository',
        passed: false,
        message: 'Not in a git repository',
        details: [
          'Review tool must be run from within a git repository',
          'Navigate to your repo directory first',
        ],
      };
    }
  } catch (error) {
    return {
      name: 'Git Repository',
      passed: false,
      message: `Not in a git repository`,
      details: [
        'Review tool must be run from within a git repository',
        'Navigate to your repo directory first',
      ],
    };
  }
}

/**
 * Print check result
 */
function printResult(result: CheckResult): void {
  const status = result.passed ? '✓' : '✗';
  const color = result.passed ? '\x1b[32m' : '\x1b[31m'; // green or red
  const reset = '\x1b[0m';

  console.log(`${color}${status}${reset} ${result.name}: ${result.message}`);

  if (result.details && result.details.length > 0) {
    result.details.forEach(detail => {
      console.log(`    ${detail}`);
    });
  }
}

/**
 * Print troubleshooting section
 */
function printTroubleshooting(results: CheckResult[]): void {
  const failedChecks = results.filter(r => !r.passed);

  if (failedChecks.length === 0) {
    return;
  }

  console.log('\n' + '─'.repeat(60));
  console.log('Troubleshooting');
  console.log('─'.repeat(60));

  // CLI check failed
  const cliFailed = failedChecks.find(r => r.name === 'Claude CLI');
  if (cliFailed) {
    console.log('\nClaude CLI is not available:');
    console.log('  1. Install: npm install -g @anthropic-ai/claude-cli');
    console.log('  2. Authenticate: claude login');
    console.log('  3. Test: echo "hello" | claude -p --model claude-haiku-4-5-20251001');
    console.log('  4. Verify: which claude');
  }

  // Network check failed
  const networkFailed = failedChecks.find(r => r.name === 'Network Connectivity');
  if (networkFailed) {
    console.log('\nNetwork connectivity issues:');
    console.log('  1. Check internet connection');
    console.log('  2. Test: curl -I https://api.anthropic.com');
    console.log('  3. Check firewall/proxy settings');
    console.log('  4. Check service status: https://status.anthropic.com');
  }

  // Git check failed
  const gitFailed = failedChecks.find(r => r.name === 'Git');
  if (gitFailed) {
    console.log('\nGit is not installed:');
    console.log('  1. Install: https://git-scm.com/downloads');
    console.log('  2. Verify: git --version');
  }

  // Git repo check failed
  const repoFailed = failedChecks.find(r => r.name === 'Git Repository');
  if (repoFailed) {
    console.log('\nNot in a git repository:');
    console.log('  1. Navigate to your repository: cd /path/to/repo');
    console.log('  2. Or initialize: git init');
  }
}

/**
 * Main health check
 */
async function main(): Promise<void> {
  console.log('🔍 Checking review tool setup...\n');

  const results: CheckResult[] = [];

  // Run all checks
  results.push(await checkGit());
  results.push(await checkGitRepo());
  results.push(await checkCLI());
  results.push(await checkNetwork());

  // Print results
  console.log();
  results.forEach(printResult);

  // Print summary
  const passed = results.filter(r => r.passed).length;
  const total = results.length;

  console.log('\n' + '─'.repeat(60));
  if (passed === total) {
    console.log('\x1b[32m✓ All checks passed!\x1b[0m');
    console.log('\nReview tool is ready to use.');
    console.log('Run: npx tsx tools/review-changes.ts main');
  } else {
    console.log(`\x1b[31m✗ ${total - passed}/${total} checks failed\x1b[0m`);
    printTroubleshooting(results);
  }
  console.log('─'.repeat(60));

  // Exit with appropriate code
  process.exitCode = passed === total ? 0 : 1;
}

main().catch((error) => {
  console.error('\n❌ Health check failed:', error.message);
  process.exitCode = 1;
});
