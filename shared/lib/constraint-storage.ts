#!/usr/bin/env -S npx tsx
/**
 * Constraint Storage
 *
 * Manages persistent storage of constraint rules in the repository.
 * Rules are stored in `constraints/<issue-id>/` directory (version controlled).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Constraint } from './constraint-parser.ts';
import type { GeneratedRule, RuleGenerationResult } from './rule-generator.ts';

export interface StoredConstraintMetadata {
  issueId: string;
  generatedAt: string;
  taskPacketHash: string;
  totalRules: number;
  autoValidatableCount: number;
  manualReviewCount: number;
}

/**
 * Save generated rules to constraints directory
 */
export function saveConstraintRules(
  issueId: string,
  ruleGenerationResult: RuleGenerationResult,
  repoRoot: string = process.cwd()
): string {
  const constraintDir = path.join(repoRoot, 'constraints', issueId);
  const rulesDir = path.join(constraintDir, 'rules');

  // Create directories
  fs.mkdirSync(constraintDir, { recursive: true });
  fs.mkdirSync(rulesDir, { recursive: true });

  // Save each rule
  for (const rule of ruleGenerationResult.rules) {
    const rulePath = path.join(rulesDir, rule.filename);
    fs.writeFileSync(rulePath, rule.code, { mode: 0o755 }); // Make executable
  }

  // Save manual review constraints
  if (ruleGenerationResult.manualReviewConstraints.length > 0) {
    const manualReviewPath = path.join(constraintDir, 'manual-review.md');
    const manualReviewContent = generateManualReviewDocument(
      ruleGenerationResult.manualReviewConstraints
    );
    fs.writeFileSync(manualReviewPath, manualReviewContent);
  }

  // Save metadata
  const metadata: StoredConstraintMetadata = {
    issueId,
    generatedAt: ruleGenerationResult.metadata.generatedAt,
    taskPacketHash: ruleGenerationResult.metadata.taskPacketHash,
    totalRules: ruleGenerationResult.rules.length,
    autoValidatableCount: ruleGenerationResult.rules.length,
    manualReviewCount: ruleGenerationResult.manualReviewConstraints.length,
  };

  const metadataPath = path.join(constraintDir, 'metadata.json');
  fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));

  return constraintDir;
}

/**
 * Load constraint rules for an issue
 */
export function loadConstraintRules(
  issueId: string,
  repoRoot: string = process.cwd()
): LoadedConstraintRules | null {
  const constraintDir = path.join(repoRoot, 'constraints', issueId);

  if (!fs.existsSync(constraintDir)) {
    return null;
  }

  const rulesDir = path.join(constraintDir, 'rules');
  const metadataPath = path.join(constraintDir, 'metadata.json');
  const manualReviewPath = path.join(constraintDir, 'manual-review.md');

  // Load metadata
  let metadata: StoredConstraintMetadata | null = null;
  if (fs.existsSync(metadataPath)) {
    metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
  }

  // Load rule files
  const ruleFiles: string[] = [];
  if (fs.existsSync(rulesDir)) {
    ruleFiles.push(
      ...fs.readdirSync(rulesDir)
        .filter(f => f.endsWith('.cjs') || f.endsWith('.js'))
        .map(f => path.join(rulesDir, f))
    );
  }

  // Load manual review document
  let manualReviewContent: string | null = null;
  if (fs.existsSync(manualReviewPath)) {
    manualReviewContent = fs.readFileSync(manualReviewPath, 'utf-8');
  }

  return {
    issueId,
    constraintDir,
    metadata,
    ruleFiles,
    manualReviewContent,
  };
}

/**
 * Check if constraint rules exist for an issue
 */
export function constraintRulesExist(issueId: string, repoRoot: string = process.cwd()): boolean {
  const constraintDir = path.join(repoRoot, 'constraints', issueId);
  return fs.existsSync(constraintDir);
}

/**
 * Delete constraint rules for an issue (cleanup after PR merge)
 */
export function deleteConstraintRules(issueId: string, repoRoot: string = process.cwd()): boolean {
  const constraintDir = path.join(repoRoot, 'constraints', issueId);

  if (!fs.existsSync(constraintDir)) {
    return false;
  }

  fs.rmSync(constraintDir, { recursive: true, force: true });
  return true;
}

/**
 * List all issues with constraint rules
 */
export function listConstraintIssues(repoRoot: string = process.cwd()): string[] {
  const constraintsDir = path.join(repoRoot, 'constraints');

  if (!fs.existsSync(constraintsDir)) {
    return [];
  }

  return fs.readdirSync(constraintsDir, { withFileTypes: true })
    .filter(dirent => dirent.isDirectory())
    .map(dirent => dirent.name);
}

/**
 * Generate manual review document
 */
function generateManualReviewDocument(constraints: Constraint[]): string {
  let doc = `# Manual Constraint Review

These constraints require human verification and cannot be automatically validated.

`;

  for (const constraint of constraints) {
    doc += `## ${constraint.id}

**Category:** ${constraint.category}
**Severity:** ${constraint.severity}

**Description:**
${constraint.description}

**Review Instructions:**
- Manually verify that this constraint is satisfied
- Check implementation against the description above
- Document findings in PR review

---

`;
  }

  return doc;
}

/**
 * Result of loading constraint rules
 */
export interface LoadedConstraintRules {
  issueId: string;
  constraintDir: string;
  metadata: StoredConstraintMetadata | null;
  ruleFiles: string[];
  manualReviewContent: string | null;
}
