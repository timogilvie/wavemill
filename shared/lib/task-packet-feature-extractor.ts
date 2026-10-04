import { access, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { analyzeTaskContext } from './task-context-analyzer.ts';
import { classifyTaskPacket } from './task-packet-classifier.ts';
import { isTaskPacketContent } from './task-packet-utils.ts';

export const CANONICAL_PACKET_SECTIONS = [
  'objective',
  'technical_context',
  'implementation_approach',
  'success_criteria',
  'implementation_constraints',
  'validation_steps',
  'definition_of_done',
  'rollback_plan',
  'release_readiness',
] as const;

export type CanonicalPacketSection = typeof CANONICAL_PACKET_SECTIONS[number];

export interface PacketFeatures {
  packet_path: string;
  format: 'full' | 'header' | 'unknown';
  section_lengths: Record<CanonicalPacketSection, number>;
  file_count: number;
  req_tag_count: number;
  validation_scenario_count: number;
  total_chars: number;
  vague_phrase_density: number;
  difficulty: number;
}

export class TaskPacketNotFoundError extends Error {
  constructor(packetPath: string) {
    super(`Task packet not found at ${packetPath}`);
    this.name = 'TaskPacketNotFoundError';
  }
}

const VAGUE_PHRASES = [
  'as needed',
  'if appropriate',
  'etc',
  'and so on',
  'probably',
  'maybe',
  'somehow',
  'tbd',
  'to be determined',
  'figure out',
  'clean up',
  'improve',
  'make better',
  'handle edge cases',
] as const;

const SECTION_MATCHERS: Array<[CanonicalPacketSection, RegExp]> = [
  ['objective', /\b(objective|what)\b/i],
  ['technical_context', /\btechnical context\b/i],
  ['implementation_approach', /\b(implementation approach|implementation plan|approach)\b/i],
  ['success_criteria', /\b(success criteria|acceptance criteria|requirements?)\b/i],
  ['implementation_constraints', /\b(implementation constraints|constraints)\b/i],
  ['validation_steps', /\b(validation steps|validation|tests?)\b/i],
  ['definition_of_done', /\b(definition of done|done)\b/i],
  ['rollback_plan', /\brollback\b/i],
  ['release_readiness', /\brelease readiness\b/i],
];

function emptySectionLengths(): Record<CanonicalPacketSection, number> {
  return Object.fromEntries(CANONICAL_PACKET_SECTIONS.map((name) => [name, 0])) as Record<CanonicalPacketSection, number>;
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function resolvePacketFile(inputPath: string): Promise<string> {
  if (!(await pathExists(inputPath))) {
    throw new TaskPacketNotFoundError(inputPath);
  }

  const info = await stat(inputPath);
  if (info.isFile()) {
    return inputPath;
  }
  if (!info.isDirectory()) {
    throw new TaskPacketNotFoundError(inputPath);
  }

  const names = await readdir(inputPath);
  const preferred = [
    'task-packet.md',
    'task-packet-full.md',
    'task-packet-header.md',
  ];
  for (const name of preferred) {
    if (names.includes(name)) {
      return path.join(inputPath, name);
    }
  }

  const fallback = names
    .filter((name) => /^task-packet.*\.md$/i.test(name) && !/details/i.test(name))
    .sort()[0];
  if (fallback) {
    return path.join(inputPath, fallback);
  }

  throw new TaskPacketNotFoundError(inputPath);
}

function detectFormat(text: string, packetPath: string): PacketFeatures['format'] {
  if (/task-packet-header\.md$/i.test(packetPath) || /Quick Reference|Detailed Sections/i.test(text)) {
    return 'header';
  }
  if (/##\s*(?:1\.\s*)?Objective|##\s+Technical Context|##\s+Success Criteria/i.test(text)) {
    return 'full';
  }
  return 'unknown';
}

function canonicalSectionName(raw: string): CanonicalPacketSection | null {
  const normalized = raw
    .replace(/^\s*\d+\.\s*/, '')
    .replace(/[*_`]/g, '')
    .trim();
  for (const [name, matcher] of SECTION_MATCHERS) {
    if (matcher.test(normalized)) {
      return name;
    }
  }
  return null;
}

function extractSectionLengths(text: string): Record<CanonicalPacketSection, number> {
  const lengths = emptySectionLengths();
  const headingPattern = /^(#{2,6})\s+(.+?)\s*$/gm;
  const headings = [...text.matchAll(headingPattern)]
    .map((match) => ({
      index: match.index ?? 0,
      length: match[0].length,
      title: match[2],
      section: canonicalSectionName(match[2]),
    }))
    .filter((heading) => heading.section !== null);

  for (let i = 0; i < headings.length; i += 1) {
    const current = headings[i];
    const next = headings[i + 1];
    const start = current.index + current.length;
    const end = next ? next.index : text.length;
    const body = text.slice(start, end).trim();
    lengths[current.section!] += body.length;
  }

  return lengths;
}

function countFiles(text: string, sectionLengths: Record<CanonicalPacketSection, number>): number {
  const filePaths = new Set<string>();
  for (const match of text.matchAll(/[A-Za-z0-9_./-]+\.(?:ts|tsx|js|jsx|json|md|sh|py|css|html|yml|yaml|sql|go|rs|rb)\b/g)) {
    filePaths.add(match[0]);
  }

  const keyFilesSection = text.match(/(?:^|\n)#{1,6}\s*(?:key files?|files?|modules?)\b[^\n]*\n([\s\S]*?)(?=\n#{1,6}\s+|$)/i)?.[1] ?? '';
  const listedFiles = (keyFilesSection.match(/^\s*(?:[-*]|\d+[.)])\s+/gm) || []).length;

  return Math.max(filePaths.size, listedFiles, sectionLengths.technical_context > 0 ? 0 : 0);
}

function countValidationScenarios(text: string, sectionLengths: Record<CanonicalPacketSection, number>): number {
  const explicit = (text.match(/\bvalidation scenario\b/gi) || []).length;
  const reqValidation = (text.match(/\[REQ-[A-Z]+\d+\][\s\S]{0,120}\b(validation|expected|test)\b/gi) || []).length;
  const validationSection = text.match(/(?:^|\n)#{1,6}\s*(?:validation steps?|validation|tests?)\b[^\n]*\n([\s\S]*?)(?=\n#{1,6}\s+|$)/i)?.[1] ?? '';
  const bullets = (validationSection.match(/^\s*(?:[-*]|\d+[.)])\s+/gm) || []).length;
  return Math.max(explicit, reqValidation, sectionLengths.validation_steps > 0 ? bullets : 0);
}

function vaguePhraseDensity(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  if (words === 0) return 0;
  const lower = text.toLowerCase();
  const vagueCount = VAGUE_PHRASES.reduce((count, phrase) => {
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return count + (lower.match(new RegExp(`\\b${escaped}\\b`, 'g')) || []).length;
  }, 0);
  return vagueCount / words;
}

function difficultyProxy(text: string, fileCount: number): number {
  const classification = classifyTaskPacket(text);
  const context = analyzeTaskContext({
    issue: { title: '', description: text },
    filesTouched: fileCount,
    locTouched: Math.max(0, Math.round(text.length / 20)),
  });
  const bandValue: Record<string, number> = { xs: 1, s: 2, m: 3, l: 4, xl: 5 };
  const contextScore = bandValue[context.complexity] ?? 3;
  const score = (classification.complexityScore + contextScore) / 2;
  return Number.isFinite(score) ? Number(score.toFixed(3)) : 3;
}

export async function extractPacketFeatures(packetPath: string): Promise<PacketFeatures> {
  const resolvedPath = await resolvePacketFile(packetPath);
  const text = await readFile(resolvedPath, 'utf-8');

  if (!isTaskPacketContent(text)) {
    return {
      packet_path: resolvedPath,
      format: 'unknown',
      section_lengths: emptySectionLengths(),
      file_count: 0,
      req_tag_count: 0,
      validation_scenario_count: 0,
      total_chars: 0,
      vague_phrase_density: 0,
      difficulty: 1,
    };
  }

  const section_lengths = extractSectionLengths(text);
  const file_count = countFiles(text, section_lengths);
  const req_tag_count = (text.match(/\[REQ-[A-Z]+\d+\]/g) || []).length;
  const validation_scenario_count = countValidationScenarios(text, section_lengths);
  const total_chars = text.length;

  return {
    packet_path: resolvedPath,
    format: detectFormat(text, resolvedPath),
    section_lengths,
    file_count,
    req_tag_count,
    validation_scenario_count,
    total_chars,
    vague_phrase_density: Number(vaguePhraseDensity(text).toFixed(6)),
    difficulty: difficultyProxy(text, file_count),
  };
}
