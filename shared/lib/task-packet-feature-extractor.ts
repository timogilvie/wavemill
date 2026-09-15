/**
 * Task Packet Feature Extractor
 *
 * Deterministic extraction of structural and contextual features from a task
 * packet for readiness scoring. Supports both full 9-section and progressive
 * disclosure (header/details) formats.
 *
 * @module task-packet-feature-extractor
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { isTaskPacketContent } from './task-packet-utils.ts';
import { classifyTaskPacket } from './task-packet-classifier.ts';

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

export class TaskPacketNotFoundError extends Error {
  constructor(path: string) {
    super(`Task packet not found at ${path}`);
    this.name = 'TaskPacketNotFoundError';
  }
}

export const CANONICAL_SECTIONS = [
  'objective',
  'technical_context',
  'implementation_approach',
  'success_criteria',
  'implementation_constraints',
  'validation_steps',
  'definition_of_done',
  'rollback_plan',
  'release_readiness',
  'proposed_labels',
] as const;

export type CanonicalSection = (typeof CANONICAL_SECTIONS)[number];

export interface PacketFeatures {
  section_lengths: Record<CanonicalSection, number>;
  total_chars: number;
  file_count: number;
  req_tag_count: number;
  validation_scenario_count: number;
  vague_phrase_count: number;
  difficulty: number;
}

// ────────────────────────────────────────────────────────────────
// Section Detection
// ────────────────────────────────────────────────────────────────

const SECTION_PATTERNS: Record<CanonicalSection, RegExp> = {
  objective: /^##\s*(?:1[\.\)]\s*)?(?:Objective|What)\b/im,
  technical_context: /^##\s*(?:2[\.\)]\s*)?Technical Context\b/im,
  implementation_approach: /^##\s*(?:3[\.\)]\s*)?Implementation (?:Approach|Plan)\b/im,
  success_criteria: /^##\s*(?:4[\.\)]\s*)?Success Criteria\b/im,
  implementation_constraints: /^##\s*(?:5[\.\)]\s*)?Implementation Constraints\b/im,
  validation_steps: /^##\s*(?:6[\.\)]\s*)?Validation (?:Steps|Scenarios)\b/im,
  definition_of_done: /^##\s*(?:7[\.\)]\s*)?Definition of Done\b/im,
  rollback_plan: /^##\s*(?:8[\.\)]\s*)?Rollback (?:Plan|Strategy)\b/im,
  release_readiness: /^##\s*(?:9[\.\)]\s*)?(?:Release Readiness|Release|Readiness)\b/im,
  proposed_labels: /^##\s*(?:10[\.\)]\s*)?Proposed Labels\b/im,
};

function extractSectionLengths(text: string): Record<CanonicalSection, number> {
  const result = {} as Record<CanonicalSection, number>;
  for (const section of CANONICAL_SECTIONS) {
    result[section] = 0;
  }

  const headingPositions: Array<{ section: CanonicalSection; start: number }> = [];
  for (const section of CANONICAL_SECTIONS) {
    const match = SECTION_PATTERNS[section].exec(text);
    if (match && match.index !== undefined) {
      headingPositions.push({ section, start: match.index });
    }
  }

  headingPositions.sort((a, b) => a.start - b.start);

  for (let i = 0; i < headingPositions.length; i++) {
    const current = headingPositions[i];
    const nextStart = i + 1 < headingPositions.length
      ? headingPositions[i + 1].start
      : text.length;
    result[current.section] = nextStart - current.start;
  }

  return result;
}

// ────────────────────────────────────────────────────────────────
// Feature Counting
// ────────────────────────────────────────────────────────────────

function countKeyFiles(text: string): number {
  const keyFilesSection = text.match(
    /(?:^|\n)#{1,6}\s*(?:Key Files|Files to Modify)\b[^\n]*\n([\s\S]*?)(?=\n#{1,6}\s|\n---|\Z)/i,
  );
  if (!keyFilesSection) return 0;
  const lines = keyFilesSection[1].split('\n');
  return lines.filter(l => /^\s*[-*|]\s*[`']?\S/.test(l)).length;
}

function countReqTags(text: string): number {
  return (text.match(/\[REQ-[A-Z]+\d*\]/g) || []).length;
}

function countValidationScenarios(text: string): number {
  return (text.match(/(?:^|\n)\s*(?:\d+\.\s+|[-*]\s+)(?:Setup|Action|Expected|Validation scenario)\b/gi) || []).length;
}

const VAGUE_PHRASES = [
  /\bTBD\b/gi,
  /\bTODO\b/gi,
  /\bas needed\b/gi,
  /\bif (?:necessary|needed|appropriate)\b/gi,
  /\bsome\s+(?:kind|type|form)\s+of\b/gi,
  /\betc\.?\b/gi,
  /\band\s+(?:so on|more)\b/gi,
  /\bpossibly\b/gi,
  /\bmaybe\b/gi,
];

function countVaguePhrases(text: string): number {
  let count = 0;
  for (const pattern of VAGUE_PHRASES) {
    const matches = text.match(pattern);
    if (matches) count += matches.length;
  }
  return count;
}

// ────────────────────────────────────────────────────────────────
// Difficulty Estimate (packet-only, no network)
// ────────────────────────────────────────────────────────────────

function estimateDifficultyFromPacket(text: string): number {
  const classification = classifyTaskPacket(text);
  return classification.complexityScore;
}

// ────────────────────────────────────────────────────────────────
// Packet Resolution
// ────────────────────────────────────────────────────────────────

async function resolvePacketContent(target: string): Promise<string> {
  let stat;
  try {
    stat = await fs.stat(target);
  } catch {
    throw new TaskPacketNotFoundError(target);
  }

  if (stat.isDirectory()) {
    const candidates = [
      'task-packet.md',
      'task-packet-header.md',
    ];
    for (const name of candidates) {
      const filePath = path.join(target, name);
      try {
        return await fs.readFile(filePath, 'utf-8');
      } catch {
        // try next
      }
    }
    throw new TaskPacketNotFoundError(target);
  }

  return fs.readFile(target, 'utf-8');
}

// ────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────

export async function extractPacketFeatures(packetPath: string): Promise<PacketFeatures> {
  const text = await resolvePacketContent(packetPath);

  const section_lengths = extractSectionLengths(text);
  const total_chars = text.length;
  const file_count = countKeyFiles(text);
  const req_tag_count = countReqTags(text);
  const validation_scenario_count = countValidationScenarios(text);
  const vague_phrase_count = countVaguePhrases(text);
  const difficulty = estimateDifficultyFromPacket(text);

  return {
    section_lengths,
    total_chars,
    file_count,
    req_tag_count,
    validation_scenario_count,
    vague_phrase_count,
    difficulty,
  };
}
