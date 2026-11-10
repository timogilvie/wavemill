// wavemill-test-suite: none (ran in no suite before HOK-3466; run it or delete it)
/**
 * Unit tests for subsystem-mapper.ts
 *
 * Verifies file-to-subsystem mapping logic.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createFileToSubsystemMap,
  mapFilesToSubsystems,
  getSubsystemForFile,
  detectFilesInIssue,
} from '../shared/lib/subsystem-mapper.ts';
import type { Subsystem } from '../shared/lib/subsystem-detector.ts';

describe('subsystem-mapper', () => {
  const mockSubsystems: Subsystem[] = [
    {
      id: 'linear-api',
      name: 'Linear API',
      description: 'Linear GraphQL client',
      keyFiles: ['shared/lib/linear.ts', 'shared/lib/linear-query.ts'],
      testPatterns: ['tests/unit/linear/*.test.ts'],
      dependencies: [],
      confidence: 0.9,
      detectionMethod: 'package',
    },
    {
      id: 'eval-system',
      name: 'Eval System',
      description: 'Evaluation and scoring',
      keyFiles: ['shared/lib/eval.ts', 'shared/lib/eval-persistence.ts'],
      testPatterns: ['tests/unit/eval/*.test.ts'],
      dependencies: [],
      confidence: 0.8,
      detectionMethod: 'directory',
    },
  ];

  describe('createFileToSubsystemMap', () => {
    it('creates bidirectional mapping', () => {
      const mapping = createFileToSubsystemMap(mockSubsystems);

      assert.ok(mapping.fileMap.size > 0, 'Should have file mappings');
      assert.ok(mapping.subsystemFiles.size > 0, 'Should have subsystem mappings');
      assert.strictEqual(mapping.subsystems.length, mockSubsystems.length);
    });

    it('maps files to subsystems correctly', () => {
      const mapping = createFileToSubsystemMap(mockSubsystems);

      assert.strictEqual(mapping.fileMap.get('shared/lib/linear.ts'), 'linear-api');
      assert.strictEqual(mapping.fileMap.get('shared/lib/eval.ts'), 'eval-system');
    });
  });

  describe('mapFilesToSubsystems', () => {
    it('maps multiple files to their subsystems', () => {
      const files = ['shared/lib/linear.ts', 'shared/lib/eval.ts'];
      const result = mapFilesToSubsystems(files, mockSubsystems);

      assert.ok(result.has('linear-api'), 'Should map to linear-api');
      assert.ok(result.has('eval-system'), 'Should map to eval-system');
    });

    it('handles files not in any subsystem', () => {
      const files = ['unknown/file.ts'];
      const result = mapFilesToSubsystems(files, mockSubsystems);

      assert.strictEqual(result.size, 0, 'Should not map unknown files');
    });
  });

  describe('getSubsystemForFile', () => {
    it('returns subsystem for known file', () => {
      const subsystem = getSubsystemForFile('shared/lib/linear.ts', mockSubsystems);

      assert.ok(subsystem, 'Should find subsystem');
      assert.strictEqual(subsystem?.id, 'linear-api');
    });

    it('returns null for unknown file', () => {
      const subsystem = getSubsystemForFile('unknown/file.ts', mockSubsystems);

      assert.strictEqual(subsystem, null, 'Should return null for unknown file');
    });
  });

  describe('detectFilesInIssue', () => {
    it('detects file paths in backticks', () => {
      const issueDescription = 'Update `shared/lib/linear.ts` and `tools/expand-issue.ts`';
      const files = detectFilesInIssue(issueDescription);

      assert.ok(files.includes('shared/lib/linear.ts'), 'Should detect first file');
      assert.ok(files.includes('tools/expand-issue.ts'), 'Should detect second file');
    });

    it('detects file paths in code blocks', () => {
      const issueDescription = `
Fix the issue in:

\`\`\`typescript
// shared/lib/eval.ts
export function evaluate() {}
\`\`\`
      `;
      const files = detectFilesInIssue(issueDescription);

      assert.ok(files.includes('shared/lib/eval.ts'), 'Should detect file in code block');
    });

    it('returns empty array for issues without file paths', () => {
      const issueDescription = 'This is a general improvement';
      const files = detectFilesInIssue(issueDescription);

      assert.strictEqual(files.length, 0, 'Should return empty array');
    });
  });
});
