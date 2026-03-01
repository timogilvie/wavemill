#!/usr/bin/env -S npx tsx
/**
 * Rule Generator
 *
 * Generates executable Node.js validation scripts from constraint objects.
 * Each rule includes clear error messages with remediation guidance.
 */

import type { Constraint } from './constraint-parser.ts';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { toKebabCase } from './string-utils.js';

export interface GeneratedRule {
  id: string;
  filename: string;
  code: string;
  constraint: Constraint;
}

export interface RuleGenerationResult {
  rules: GeneratedRule[];
  manualReviewConstraints: Constraint[];
  metadata: {
    issueId: string;
    generatedAt: string;
    taskPacketHash: string;
  };
}

/**
 * Generate executable rules from constraints
 */
export function generateRules(
  constraints: Constraint[],
  issueId: string,
  taskPacketContent: string
): RuleGenerationResult {
  const rules: GeneratedRule[] = [];
  const manualReviewConstraints: Constraint[] = [];

  for (const constraint of constraints) {
    if (constraint.type === 'manual-review') {
      manualReviewConstraints.push(constraint);
      continue;
    }

    // Generate rule based on constraint category
    const ruleCode = generateRuleCode(constraint);
    if (ruleCode) {
      rules.push({
        id: constraint.id,
        filename: generateFilename(constraint),
        code: ruleCode,
        constraint,
      });
    }
  }

  return {
    rules,
    manualReviewConstraints,
    metadata: {
      issueId,
      generatedAt: new Date().toISOString(),
      taskPacketHash: hashString(taskPacketContent),
    },
  };
}

/**
 * Generate filename for rule
 */
function generateFilename(constraint: Constraint): string {
  const prefix = constraint.id.toLowerCase().replace('constraint-', '');
  const category = constraint.category;
  const sanitized = toKebabCase(constraint.description, 40);

  return `${prefix.padStart(2, '0')}-${category}-${sanitized}.cjs`;
}

/**
 * Generate rule code based on constraint
 */
function generateRuleCode(constraint: Constraint): string | null {
  switch (constraint.category) {
    case 'file':
      return generateFileConstraintRule(constraint);
    case 'code-style':
      return generateCodeStyleRule(constraint);
    case 'testing':
      return generateTestingRule(constraint);
    case 'security':
      return generateSecurityRule(constraint);
    default:
      return generateGenericRule(constraint);
  }
}

/**
 * Generate rule for file modification constraints
 */
function generateFileConstraintRule(constraint: Constraint): string {
  const pattern = constraint.pattern || '';
  const isProhibited = /don't modify|must not modify|do not change|cannot modify/i.test(
    constraint.description
  );

  return `#!/usr/bin/env node
/**
 * ${constraint.id}: ${constraint.description}
 * Category: ${constraint.category}
 * Severity: ${constraint.severity}
 */

const { execSync } = require('child_process');
const path = require('path');

function checkFileModificationConstraint() {
  const pattern = ${JSON.stringify(pattern)};
  const isProhibited = ${isProhibited};

  try {
    // Get list of modified files in current branch (compared to main)
    const gitDiff = execSync('git diff --name-only main...HEAD', { encoding: 'utf-8' });
    const modifiedFiles = gitDiff.trim().split('\\n').filter(f => f);

    const violations = [];

    for (const file of modifiedFiles) {
      // Check if file matches the pattern
      if (pattern && (file === pattern || file.includes(pattern) || matchGlob(file, pattern))) {
        if (isProhibited) {
          violations.push({
            file,
            message: \`File "\${file}" was modified, but constraint prohibits this\`,
          });
        }
      }
    }

    if (violations.length > 0) {
      console.error(\`\\n❌ Constraint violation: ${constraint.id}\`);
      console.error(\`   ${constraint.description}\\n\`);

      for (const violation of violations) {
        console.error(\`   • \${violation.file}\`);
        console.error(\`     \${violation.message}\\n\`);
      }

      console.error('📋 Remediation:');
      console.error(\`   - Revert changes to the prohibited file(s)\`);
      console.error(\`   - Or update the constraint if this change is intentional\\n\`);

      process.exit(1);
    }

    console.log(\`✓ ${constraint.id}: No prohibited file modifications\`);
    process.exit(0);

  } catch (error) {
    console.error(\`Warning: Could not check file constraints: \${error.message}\`);
    process.exit(0); // Don't fail on git errors
  }
}

function matchGlob(filename, pattern) {
  // Simple glob matching for *.ext patterns
  if (pattern.includes('*')) {
    const regex = pattern.replace(/\\*/g, '.*').replace(/\\./g, '\\\\.');
    return new RegExp(\`^\${regex}$\`).test(filename);
  }
  return false;
}

checkFileModificationConstraint();
`;
}

/**
 * Generate rule for code style constraints
 */
function generateCodeStyleRule(constraint: Constraint): string {
  const pattern = constraint.pattern || '';
  const requiresPattern = /must use|should use|use only/i.test(constraint.description);
  const forbidsPattern = /no .+ allowed|cannot use|must not use/i.test(constraint.description);

  return `#!/usr/bin/env node
/**
 * ${constraint.id}: ${constraint.description}
 * Category: ${constraint.category}
 * Severity: ${constraint.severity}
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function escapeRegExp(string) {
  // Escape special regex characters by doubling backslashes first, then escaping others
  return string
    .replace(/\\\\/g, '\\\\\\\\')
    .replace(/\\./g, '\\\\.')
    .replace(/\\*/g, '\\\\*')
    .replace(/\\+/g, '\\\\+')
    .replace(/\\?/g, '\\\\?')
    .replace(/\\^/g, '\\\\^')
    .replace(/\\$/g, '\\\\$$')
    .replace(/\\{/g, '\\\\{')
    .replace(/\\}/g, '\\\\}')
    .replace(/\\(/g, '\\\\(')
    .replace(/\\)/g, '\\\\)')
    .replace(/\\|/g, '\\\\|')
    .replace(/\\[/g, '\\\\[')
    .replace(/\\]/g, '\\\\]');
}

function checkCodeStyleConstraint() {
  const pattern = ${JSON.stringify(pattern)};
  const requires = ${requiresPattern};
  const forbids = ${forbidsPattern};

  try {
    // Get list of modified files in current branch
    const gitDiff = execSync('git diff --name-only main...HEAD', { encoding: 'utf-8' });
    const modifiedFiles = gitDiff
      .trim()
      .split('\\n')
      .filter(f => f && (f.endsWith('.ts') || f.endsWith('.js') || f.endsWith('.tsx') || f.endsWith('.jsx')));

    const violations = [];

    for (const file of modifiedFiles) {
      if (!fs.existsSync(file)) continue;

      const content = fs.readFileSync(file, 'utf-8');

      // Check for forbidden patterns
      if (forbids && pattern) {
        // Simple string matching for forbidden pattern
        const occurrences = (content.match(new RegExp(escapeRegExp(pattern), 'gi')) || []).length;

        if (occurrences > 0) {
          violations.push({
            file,
            message: \`Found forbidden pattern "\${pattern}" (\${occurrences} occurrences)\`,
          });
        }
      }
    }

    if (violations.length > 0) {
      console.error(\`\\n❌ Constraint violation: ${constraint.id}\`);
      console.error(\`   ${constraint.description}\\n\`);

      for (const violation of violations) {
        console.error(\`   • \${violation.file}\`);
        console.error(\`     \${violation.message}\\n\`);
      }

      console.error('📋 Remediation:');
      if (forbids) {
        console.error(\`   - Remove or replace the forbidden pattern "\${pattern}"\`);
      }
      if (requires) {
        console.error(\`   - Ensure all code uses the required pattern "\${pattern}"\`);
      }
      console.error(\`   - Review the constraint and update code accordingly\\n\`);

      process.exit(1);
    }

    console.log(\`✓ ${constraint.id}: Code style constraint satisfied\`);
    process.exit(0);

  } catch (error) {
    console.error(\`Warning: Could not check code style: \${error.message}\`);
    process.exit(0);
  }
}

checkCodeStyleConstraint();
`;
}

/**
 * Generate rule for testing constraints
 */
function generateTestingRule(constraint: Constraint): string {
  return `#!/usr/bin/env node
/**
 * ${constraint.id}: ${constraint.description}
 * Category: ${constraint.category}
 * Severity: ${constraint.severity}
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function checkTestingConstraint() {
  try {
    // Get list of modified source files
    const gitDiff = execSync('git diff --name-only main...HEAD', { encoding: 'utf-8' });
    const modifiedFiles = gitDiff
      .trim()
      .split('\\n')
      .filter(f => f && !f.includes('.test.') && !f.includes('.spec.') &&
                   (f.endsWith('.ts') || f.endsWith('.js') || f.endsWith('.tsx') || f.endsWith('.jsx')));

    const missingTests = [];

    for (const file of modifiedFiles) {
      if (!fs.existsSync(file)) continue;

      // Check if corresponding test file exists
      const testFile = file.replace(/\\.(ts|js|tsx|jsx)$/, '.test.$1');
      const specFile = file.replace(/\\.(ts|js|tsx|jsx)$/, '.spec.$1');

      if (!fs.existsSync(testFile) && !fs.existsSync(specFile)) {
        missingTests.push(file);
      }
    }

    if (missingTests.length > 0) {
      console.error(\`\\n⚠️  Testing constraint: ${constraint.id}\`);
      console.error(\`   ${constraint.description}\\n\`);

      console.error(\`   Modified files without corresponding test files:\`);
      for (const file of missingTests) {
        console.error(\`   • \${file}\`);
      }
      console.error();

      console.error('📋 Remediation:');
      console.error(\`   - Add test files for the modified source files\`);
      console.error(\`   - Test files should be named: <filename>.test.<ext> or <filename>.spec.<ext>\\n\`);

      // This is a warning, not a hard failure
      if ('${constraint.severity}' === 'error') {
        process.exit(1);
      }
    }

    console.log(\`✓ ${constraint.id}: Testing constraint satisfied\`);
    process.exit(0);

  } catch (error) {
    console.error(\`Warning: Could not check testing constraints: \${error.message}\`);
    process.exit(0);
  }
}

checkTestingConstraint();
`;
}

/**
 * Generate rule for security constraints
 */
function generateSecurityRule(constraint: Constraint): string {
  const pattern = constraint.pattern || '';

  // Common security patterns to check
  const securityPatterns = [
    'API_KEY',
    'SECRET',
    'PASSWORD',
    'TOKEN',
    'PRIVATE_KEY',
    'AWS_ACCESS_KEY',
  ];

  return `#!/usr/bin/env node
/**
 * ${constraint.id}: ${constraint.description}
 * Category: ${constraint.category}
 * Severity: ${constraint.severity}
 */

const { execSync } = require('child_process');
const fs = require('fs');

function checkSecurityConstraint() {
  try {
    // Get list of modified files
    const gitDiff = execSync('git diff --name-only main...HEAD', { encoding: 'utf-8' });
    const modifiedFiles = gitDiff.trim().split('\\n').filter(f => f);

    const violations = [];
    const securityPatterns = ${JSON.stringify(securityPatterns)};

    for (const file of modifiedFiles) {
      if (!fs.existsSync(file)) continue;

      // Skip certain file types
      if (file.endsWith('.md') || file.endsWith('.json')) continue;

      const content = fs.readFileSync(file, 'utf-8');

      // Check for exposed secrets/keys
      for (const pattern of securityPatterns) {
        const regex = new RegExp(\`\${pattern}\\\\s*=\\\\s*["']\`, 'gi');
        const matches = content.match(regex);

        if (matches) {
          violations.push({
            file,
            pattern,
            message: \`Possible hardcoded secret: \${pattern}\`,
          });
        }
      }
    }

    if (violations.length > 0) {
      console.error(\`\\n❌ Security constraint violation: ${constraint.id}\`);
      console.error(\`   ${constraint.description}\\n\`);

      for (const violation of violations) {
        console.error(\`   • \${violation.file}\`);
        console.error(\`     \${violation.message}\\n\`);
      }

      console.error('📋 Remediation:');
      console.error(\`   - Move sensitive values to environment variables\`);
      console.error(\`   - Use .env files (not committed to git)\`);
      console.error(\`   - Never hardcode API keys, secrets, or passwords\\n\`);

      process.exit(1);
    }

    console.log(\`✓ ${constraint.id}: Security constraint satisfied\`);
    process.exit(0);

  } catch (error) {
    console.error(\`Warning: Could not check security constraints: \${error.message}\`);
    process.exit(0);
  }
}

checkSecurityConstraint();
`;
}

/**
 * Generate generic rule template
 */
function generateGenericRule(constraint: Constraint): string {
  return `#!/usr/bin/env node
/**
 * ${constraint.id}: ${constraint.description}
 * Category: ${constraint.category}
 * Severity: ${constraint.severity}
 *
 * This is a generic rule template. Manual verification may be required.
 */

console.log(\`ℹ️  ${constraint.id}: Generic constraint check\`);
console.log(\`   ${constraint.description}\`);
console.log(\`   Manual verification recommended.\\n\`);

process.exit(0);
`;
}

/**
 * Simple string hash function
 */
function hashString(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash).toString(16);
}
