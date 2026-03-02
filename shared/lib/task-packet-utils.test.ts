/**
 * Tests for task-packet-utils.ts
 */

import { describe, test, expect } from 'vitest';
import {
  splitTaskPacket,
  isValidTaskPacket,
  isTaskPacketFile,
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
