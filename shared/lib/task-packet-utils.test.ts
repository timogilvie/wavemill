/**
 * Tests for task-packet-utils.ts
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { expect } from './test-assertions.ts';
import {
  getTaskPacketArtifactPaths,
  splitTaskPacket,
  isValidTaskPacket,
  isTaskPacketContent,
  isTaskPacketFile,
  writeTaskPacketArtifacts,
  extractReleaseReadiness,
} from './task-packet-utils.ts';

describe('splitTaskPacket', () => {
  test('splits task packet with marker', () => {
    const taskPacket = `# Task Packet Header

## Objective
Implement feature X

<!-- SPLIT: HEADER ABOVE, DETAILS BELOW -->

## 1. Complete Objective
Full objective details here

## 2. Technical Context
Context details here`;

    const result = splitTaskPacket(taskPacket);

    expect(result.header).toContain('# Task Packet Header');
    expect(result.header).toContain('## Objective');
    expect(result.header).not.toContain('SPLIT:');
    expect(result.details).toContain('## 1. Complete Objective');
    expect(result.details).toContain('## 2. Technical Context');
    expect(result.fullContent).toContain('---');
  });

  test('handles legacy format without marker', () => {
    const taskPacket = `## 1. Objective

Implement feature X

### Key Files
- file1.ts
- file2.ts

## 2. Technical Context
Details here`;

    const result = splitTaskPacket(taskPacket);

    expect(result.header).toContain('# Task Packet');
    expect(result.header).toContain('## 1. Objective');
    expect(result.header).toContain('### Key Files');
    expect(result.details).toBe(taskPacket);
    expect(result.fullContent).toBe(taskPacket);
  });

  test('generates header when objective section exists', () => {
    const taskPacket = `## 1. Objective

Build authentication

## 2. Technical Context
Details`;

    const result = splitTaskPacket(taskPacket);

    expect(result.header).toContain('## 1. Objective');
    expect(result.header).toContain('Build authentication');
  });

  test('handles missing objective section gracefully', () => {
    const taskPacket = `## Some Other Section

Content here`;

    const result = splitTaskPacket(taskPacket);

    expect(result.header).toContain('See details below');
  });

  test('preserves whitespace in header/details', () => {
    const taskPacket = `Header with spaces

<!-- SPLIT: HEADER ABOVE, DETAILS BELOW -->

Details with spaces`;

    const result = splitTaskPacket(taskPacket);

    expect(result.header).toBe('Header with spaces');
    expect(result.details).toBe('Details with spaces');
  });
});

describe('isValidTaskPacket', () => {
  test('validates task packet with numbered section', () => {
    const text = '## 1. Objective\n\nImplement feature';
    expect(isValidTaskPacket(text)).toBe(true);
  });

  test('validates task packet with Objective header', () => {
    const text = '## Objective\n\nImplement feature';
    expect(isValidTaskPacket(text)).toBe(true);
  });

  test('validates task packet with Technical Context', () => {
    const text = '## Technical Context\n\nDetails';
    expect(isValidTaskPacket(text)).toBe(true);
  });

  test('validates task packet with Success Criteria', () => {
    const text = '## Success Criteria\n\n- Criterion 1';
    expect(isValidTaskPacket(text)).toBe(true);
  });

  test('validates task packet with Implementation', () => {
    const text = '## Implementation\n\nSteps';
    expect(isValidTaskPacket(text)).toBe(true);
  });

  test('rejects conversational text', () => {
    const text = 'Sure, I can help you with that. Let me explain...';
    expect(isValidTaskPacket(text)).toBe(false);
  });

  test('rejects empty string', () => {
    expect(isValidTaskPacket('')).toBe(false);
  });

  test('is case-insensitive', () => {
    const text = '## objective\n\nImplement feature';
    expect(isValidTaskPacket(text)).toBe(true);
  });

  test('accepts "What" as valid section (alternative phrasing)', () => {
    const text = '## What\n\nBuild feature X';
    expect(isValidTaskPacket(text)).toBe(true);
  });
});

describe('isTaskPacketFile', () => {
  test('recognizes task-packet.md', () => {
    expect(isTaskPacketFile('features/foo/task-packet.md')).toBe(true);
  });

  test('recognizes task-packet-header.md', () => {
    expect(isTaskPacketFile('features/foo/task-packet-header.md')).toBe(true);
  });

  test('recognizes task-packet-details.md', () => {
    expect(isTaskPacketFile('features/foo/task-packet-details.md')).toBe(true);
  });

  test('rejects README.md', () => {
    expect(isTaskPacketFile('features/foo/README.md')).toBe(false);
  });

  test('rejects plan.md', () => {
    expect(isTaskPacketFile('features/foo/plan.md')).toBe(false);
  });

  test('rejects non-markdown files', () => {
    expect(isTaskPacketFile('task-packet.txt')).toBe(false);
  });

  test('handles paths without directory', () => {
    expect(isTaskPacketFile('task-packet.md')).toBe(true);
  });
});

describe('isTaskPacketContent', () => {
  test('recognizes legacy section formats', () => {
    expect(isTaskPacketContent('## 1. Objective\n\nBuild feature')).toBe(true);
    expect(isTaskPacketContent('## Technical Context\n\nNotes')).toBe(true);
  });

  test('recognizes progressive-disclosure markers', () => {
    expect(isTaskPacketContent('Quick Reference\n\n- Item')).toBe(true);
    expect(isTaskPacketContent('## Detailed Sections\n\n## 1. Objective')).toBe(true);
  });

  test('returns false for raw issue text', () => {
    expect(isTaskPacketContent('Fix failing webhook retries in staging')).toBe(false);
  });
});

describe('task packet artifact persistence', () => {
  test('derives conventional artifact paths from the full packet path', () => {
    const paths = getTaskPacketArtifactPaths('features/foo/task-packet.md');
    expect(paths).toEqual({
      full: 'features/foo/task-packet.md',
      header: 'features/foo/task-packet-header.md',
      details: 'features/foo/task-packet-details.md',
    });
  });

  test('writes full, header, and details files and creates parent directories', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-packet-utils-'));
    const outputFile = path.join(root, 'features', 'foo', 'task-packet.md');

    const artifactPaths = await writeTaskPacketArtifacts(outputFile, {
      header: '# Header',
      details: '## 1. Objective\n\nDetails',
      fullContent: '# Header\n\n---\n\n## 1. Objective\n\nDetails',
    });

    await expect(fs.readFile(artifactPaths.header, 'utf-8')).resolves.toBe('# Header');
    await expect(fs.readFile(artifactPaths.details, 'utf-8')).resolves.toBe('## 1. Objective\n\nDetails');
    await expect(fs.readFile(artifactPaths.full, 'utf-8')).resolves.toBe('# Header\n\n---\n\n## 1. Objective\n\nDetails');
    await fs.rm(root, { recursive: true, force: true });
  });
});

describe('extractReleaseReadiness', () => {
  test('extracts valid metadata with all fields populated', () => {
    const markdown = `## Some Section

Content here

## Release Readiness
- **database_change_risk**: required
- **env_changes**: NEW_API_KEY, FEATURE_FLAG_X
- **config_changes**: config/production.json
- **manual_steps**: Run migration script, Update CDN cache rules

## Next Section

More content`;

    const result = extractReleaseReadiness(markdown);

    expect(result!.databaseChangeRisk).toBe('required');
    expect(result!.envChanges).toEqual(['NEW_API_KEY', 'FEATURE_FLAG_X']);
    expect(result!.configChanges).toEqual(['config/production.json']);
    expect(result!.manualSteps).toEqual(['Run migration script', 'Update CDN cache rules']);
    expect(result!.missingFields).toEqual([]);
  });

  test('returns null when section is absent', () => {
    const markdown = `## Objective

Build something

## Technical Context

Details`;

    expect(extractReleaseReadiness(markdown)).toBeNull();
  });

  test('returns null for partial heading match', () => {
    const markdown = `## Release

Some content`;

    expect(extractReleaseReadiness(markdown)).toBeNull();
  });

  test('returns null for empty string', () => {
    expect(extractReleaseReadiness('')).toBeNull();
  });

  test('maps "none" list values to empty arrays', () => {
    const markdown = `## Release Readiness
- **database_change_risk**: none
- **env_changes**: none
- **config_changes**: none
- **manual_steps**: none`;

    const result = extractReleaseReadiness(markdown);

    expect(result!.databaseChangeRisk).toBe('none');
    expect(result!.envChanges).toEqual([]);
    expect(result!.configChanges).toEqual([]);
    expect(result!.manualSteps).toEqual([]);
    expect(result!.missingFields).toEqual([]);
  });

  test('handles single-item lists', () => {
    const markdown = `## Release Readiness
- **database_change_risk**: possible
- **env_changes**: API_KEY
- **config_changes**: none
- **manual_steps**: none`;

    const result = extractReleaseReadiness(markdown);

    expect(result!.databaseChangeRisk).toBe('possible');
    expect(result!.envChanges).toEqual(['API_KEY']);
    expect(result!.configChanges).toEqual([]);
    expect(result!.manualSteps).toEqual([]);
    expect(result!.missingFields).toEqual([]);
  });

  test('defaults database_change_risk to none for invalid value', () => {
    const markdown = `## Release Readiness
- **database_change_risk**: maybe
- **env_changes**: none
- **config_changes**: none
- **manual_steps**: none`;

    const result = extractReleaseReadiness(markdown);

    expect(result).not.toBeNull();
    expect(result!.databaseChangeRisk).toBe('none');
  });

  test('trims whitespace from list items', () => {
    const markdown = `## Release Readiness
- **database_change_risk**: none
- **env_changes**:  FOO ,  BAR ,  BAZ
- **config_changes**: none
- **manual_steps**: none`;

    const result = extractReleaseReadiness(markdown);

    expect(result!.envChanges).toEqual(['FOO', 'BAR', 'BAZ']);
  });

  test('handles section at end of document', () => {
    const markdown = `## Objective

Build something

## Release Readiness
- **database_change_risk**: required
- **env_changes**: none
- **config_changes**: none
- **manual_steps**: none`;

    const result = extractReleaseReadiness(markdown);

    expect(result).not.toBeNull();
    expect(result!.databaseChangeRisk).toBe('required');
  });

  // HOK-3499: the incident spelling — the colon sits inside the bold markers.
  test('accepts the colon inside the bold markers', () => {
    const markdown = `## Release Readiness

- **database_change_risk:** none
- **env_changes:** none
- **config_changes:** config/app.json
- **manual_steps:** none`;

    const result = extractReleaseReadiness(markdown);

    expect(result!.databaseChangeRisk).toBe('none');
    expect(result!.envChanges).toEqual([]);
    expect(result!.configChanges).toEqual(['config/app.json']);
    expect(result!.manualSteps).toEqual([]);
    expect(result!.missingFields).toEqual([]);
  });

  test('accepts * bullets', () => {
    const markdown = `## Release Readiness
* **database_change_risk**: possible
* **env_changes**: API_KEY
* **config_changes**: none
* **manual_steps**: none`;

    const result = extractReleaseReadiness(markdown);

    expect(result!.databaseChangeRisk).toBe('possible');
    expect(result!.envChanges).toEqual(['API_KEY']);
    expect(result!.missingFields).toEqual([]);
  });

  test('accepts a heading suffix after Release Readiness', () => {
    const markdown = `## Release Readiness (v2)
- **database_change_risk**: none
- **env_changes**: none
- **config_changes**: none
- **manual_steps**: none`;

    const result = extractReleaseReadiness(markdown);

    expect(result).not.toBeNull();
    expect(result!.missingFields).toEqual([]);
  });

  test('reports a missing database_change_risk instead of inventing none', () => {
    const markdown = `## Release Readiness
- **env_changes**: none
- **config_changes**: none
- **manual_steps**: none`;

    const result = extractReleaseReadiness(markdown);

    expect(result).not.toBeNull();
    expect(result!.databaseChangeRisk).toBeUndefined();
    expect(result!.missingFields).toEqual(['database_change_risk']);
  });

  test('reports every missing required field', () => {
    expect(extractReleaseReadiness('## Release Readiness')!.missingFields).toEqual([
      'database_change_risk',
      'env_changes',
      'config_changes',
      'manual_steps',
    ]);
  });

  test('treats "none" with an annotation as an empty list', () => {
    const markdown = `## Release Readiness
- **database_change_risk:** none
- **env_changes:** none (kill-switch removed; no env var remains)
- **config_changes:** none
- **manual_steps:** none (no migration needed)`;

    const result = extractReleaseReadiness(markdown);

    expect(result!.databaseChangeRisk).toBe('none');
    expect(result!.envChanges).toEqual([]);
    expect(result!.manualSteps).toEqual([]);
    expect(result!.missingFields).toEqual([]);
  });

  test('ignores a Release Readiness example inside a fenced code block', () => {
    const markdown = `# Plan

The expected shape is:

\`\`\`markdown
## Release Readiness
- **database_change_risk**: none
\`\`\`

## Release Readiness
- **database_change_risk:** possible
- **env_changes:** none
- **config_changes:** none
- **manual_steps:** none`;

    const result = extractReleaseReadiness(markdown);

    expect(result!.databaseChangeRisk).toBe('possible');
    expect(result!.missingFields).toEqual([]);
  });
});
