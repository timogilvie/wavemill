#!/usr/bin/env -S npx tsx
/**
 * Constraint Validator
 *
 * Executes generated constraint rules and collects violations.
 * Supports parallel rule execution for better performance.
 */

import { execSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadConstraintRules, type LoadedConstraintRules } from './constraint-storage.ts';

export interface ValidationResult {
  issueId: string;
  passed: boolean;
  totalRules: number;
  passedRules: number;
  failedRules: number;
  violations: RuleViolation[];
  manualReviewRequired: boolean;
  executionTimeMs: number;
}

export interface RuleViolation {
  ruleFile: string;
  ruleId: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Validate constraints for an issue
 */
export async function validateConstraints(
  issueId: string,
  repoRoot: string = process.cwd(),
  options: ValidationOptions = {}
): Promise<ValidationResult> {
  const startTime = Date.now();

  // Load constraint rules
  const loaded = loadConstraintRules(issueId, repoRoot);
  if (!loaded) {
    throw new Error(`No constraint rules found for issue ${issueId}`);
  }

  const violations: RuleViolation[] = [];
  const { ruleFiles, manualReviewContent } = loaded;

  // Execute rules (in parallel if enabled)
  if (options.parallel !== false && ruleFiles.length > 1) {
    const results = await executeRulesParallel(ruleFiles, repoRoot);
    violations.push(...results.filter(r => r.exitCode !== 0));
  } else {
    // Sequential execution
    for (const ruleFile of ruleFiles) {
      const result = await executeRule(ruleFile, repoRoot);
      if (result.exitCode !== 0) {
        violations.push(result);
      }
    }
  }

  const executionTimeMs = Date.now() - startTime;

  return {
    issueId,
    passed: violations.length === 0,
    totalRules: ruleFiles.length,
    passedRules: ruleFiles.length - violations.length,
    failedRules: violations.length,
    violations,
    manualReviewRequired: manualReviewContent !== null,
    executionTimeMs,
  };
}

/**
 * Execute a single rule
 */
async function executeRule(ruleFile: string, cwd: string): Promise<RuleViolation> {
  const ruleId = path.basename(ruleFile, '.js');

  return new Promise((resolve) => {
    const child = spawn('node', [ruleFile], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30000, // 30 second timeout
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      resolve({
        ruleFile,
        ruleId,
        exitCode: code ?? 1,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    });

    child.on('error', (error) => {
      resolve({
        ruleFile,
        ruleId,
        exitCode: 1,
        stdout: '',
        stderr: `Failed to execute rule: ${error.message}`,
      });
    });
  });
}

/**
 * Execute multiple rules in parallel
 */
async function executeRulesParallel(
  ruleFiles: string[],
  cwd: string
): Promise<RuleViolation[]> {
  const promises = ruleFiles.map((ruleFile) => executeRule(ruleFile, cwd));
  return Promise.all(promises);
}

/**
 * Format validation result for display
 */
export function formatValidationResult(result: ValidationResult): string {
  let output = '';

  if (result.passed && !result.manualReviewRequired) {
    output += `\n✅ All constraint validations passed for ${result.issueId}\n`;
    output += `   ${result.passedRules} rules checked in ${result.executionTimeMs}ms\n`;
    return output;
  }

  output += `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
  output += `   Constraint Validation Results: ${result.issueId}\n`;
  output += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

  // Summary
  const statusIcon = result.passed ? '✅' : '❌';
  output += `${statusIcon} Status: ${result.passed ? 'PASSED' : 'FAILED'}\n`;
  output += `   Total rules: ${result.totalRules}\n`;
  output += `   Passed: ${result.passedRules}\n`;
  output += `   Failed: ${result.failedRules}\n`;
  output += `   Execution time: ${result.executionTimeMs}ms\n\n`;

  // Violations
  if (result.violations.length > 0) {
    output += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    output += `   Violations\n`;
    output += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

    for (const violation of result.violations) {
      output += `Rule: ${violation.ruleId}\n`;
      output += `File: ${violation.ruleFile}\n`;
      output += `Exit code: ${violation.exitCode}\n\n`;

      if (violation.stderr) {
        output += violation.stderr + '\n\n';
      } else if (violation.stdout) {
        output += violation.stdout + '\n\n';
      }

      output += `---\n\n`;
    }
  }

  // Manual review
  if (result.manualReviewRequired) {
    output += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    output += `   Manual Review Required\n`;
    output += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
    output += `⚠️  Some constraints require human verification.\n`;
    output += `   See: constraints/${result.issueId}/manual-review.md\n\n`;
  }

  return output;
}

/**
 * Validation options
 */
export interface ValidationOptions {
  parallel?: boolean; // Execute rules in parallel (default: true)
}
