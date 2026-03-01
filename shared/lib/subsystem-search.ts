/**
 * Subsystem Search Library
 *
 * Programmatic API for searching subsystem specs. Supports:
 * - Keyword search across subsystem content
 * - File path matching (detect subsystems from file references)
 * - Issue description analysis (extract files and patterns)
 * - Hybrid ranking (keyword + file + section relevance)
 *
 * Inspired by AMA-Bench findings: hybrid retrieval outperforms
 * similarity-only by 11%+ (per Codified Context paper).
 *
 * @module subsystem-search
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Subsystem } from './subsystem-detector.ts';
import { detectSubsystems } from './subsystem-detector.ts';
import { detectFilesInIssue, detectSubsystemsInIssue } from './subsystem-mapper.ts';

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

export interface SubsystemSearchResult {
  subsystemId: string;
  subsystemName: string;
  specPath: string;
  score: number;
  relevantSections: {
    section: string;
    content: string;
  }[];
}

export interface SubsystemSearchOptions {
  /** Maximum results to return */
  limit?: number;
  /** Include full spec content (default: false, returns excerpts only) */
  includeFullSpecs?: boolean;
  /** Filter to specific section */
  sectionFilter?: string;
  /** Minimum score threshold */
  minScore?: number;
}

const DEFAULT_OPTIONS: Required<SubsystemSearchOptions> = {
  limit: 10,
  includeFullSpecs: false,
  sectionFilter: '',
  minScore: 0,
};

// ────────────────────────────────────────────────────────────────
// Helper Functions
// ────────────────────────────────────────────────────────────────

/**
 * Extract subsystem name from spec content.
 */
function extractSubsystemName(content: string): string {
  const match = content.match(/^# Subsystem:\s*(.+)$/m);
  return match ? match[1].trim() : 'Unknown';
}

/**
 * Extract content from a specific section.
 */
function extractSection(content: string, sectionName: string): string {
  const lines = content.split('\n');
  const sectionRegex = new RegExp(`^##\\s+${sectionName}`, 'i');

  let inSection = false;
  const sectionLines: string[] = [];

  for (const line of lines) {
    if (sectionRegex.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && /^##\s+/.test(line)) {
      break; // End of section
    }
    if (inSection) {
      sectionLines.push(line);
    }
  }

  return sectionLines.join('\n').trim();
}

/**
 * Extract all sections from a spec.
 */
function extractAllSections(content: string): Map<string, string> {
  const sections = new Map<string, string>();
  const lines = content.split('\n');

  let currentSection = '';
  let currentContent: string[] = [];

  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      // Save previous section
      if (currentSection) {
        sections.set(currentSection, currentContent.join('\n').trim());
      }

      // Start new section
      currentSection = line.replace(/^##\s+/, '').trim();
      currentContent = [];
    } else if (currentSection) {
      currentContent.push(line);
    }
  }

  // Save last section
  if (currentSection) {
    sections.set(currentSection, currentContent.join('\n').trim());
  }

  return sections;
}

/**
 * Find keyword matches in content with context.
 */
function findKeywordMatches(
  content: string,
  query: string,
  contextLines = 1
): {
  snippets: string[];
  locations: string[];
  count: number;
} {
  const lines = content.split('\n');
  const queryLower = query.toLowerCase();
  const snippets: string[] = [];
  const locations: string[] = [];
  let count = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.toLowerCase().includes(queryLower)) {
      count++;

      // Extract snippet with context
      const start = Math.max(0, i - contextLines);
      const end = Math.min(lines.length, i + contextLines + 1);
      const snippet = lines.slice(start, end).join('\n');
      snippets.push(snippet);

      // Determine location (section)
      const location = findSectionForLine(lines, i);
      locations.push(location);
    }
  }

  return { snippets, locations, count };
}

/**
 * Find which section a line belongs to.
 */
function findSectionForLine(lines: string[], lineIndex: number): string {
  let currentSection = 'Header';

  for (let i = lineIndex; i >= 0; i--) {
    const line = lines[i];
    if (/^##\s+/.test(line)) {
      currentSection = line.replace(/^##\s+/, '').trim();
      break;
    }
    if (/^#\s+/.test(line)) {
      currentSection = 'Header';
      break;
    }
  }

  return currentSection;
}

/**
 * Calculate relevance score for a search result.
 */
function calculateScore(
  subsystemName: string,
  content: string,
  query: string,
  matchCount: number,
  locations: string[],
  fileMatches: number = 0
): number {
  let score = 0;
  const queryLower = query.toLowerCase();

  // Name match (highest priority)
  if (subsystemName.toLowerCase().includes(queryLower)) {
    score += 100;
  }

  // File path matches (high priority)
  score += fileMatches * 50;

  // Keyword match count
  score += matchCount * 10;

  // Purpose section match (high priority)
  if (locations.includes('Purpose')) {
    score += 20;
  }

  // Architectural Constraints match
  if (locations.includes('Architectural Constraints')) {
    score += 15;
  }

  // Known Failure Modes match
  if (locations.includes('Known Failure Modes')) {
    score += 15;
  }

  // Testing Patterns match
  if (locations.includes('Testing Patterns')) {
    score += 10;
  }

  return score;
}

/**
 * Get relevant sections from a subsystem spec.
 *
 * Prioritizes sections most useful for implementation:
 * - Purpose, Architectural Constraints, Known Failure Modes, Testing Patterns
 */
function getRelevantSections(
  content: string,
  includeFullSpec: boolean
): { section: string; content: string }[] {
  const allSections = extractAllSections(content);
  const relevantSections: { section: string; content: string }[] = [];

  // Priority sections
  const prioritySections = [
    'Purpose',
    'Architectural Constraints',
    'Known Failure Modes',
    'Testing Patterns',
    'Key Files',
    'Dependencies',
  ];

  for (const sectionName of prioritySections) {
    const sectionContent = allSections.get(sectionName);
    if (sectionContent && sectionContent.length > 0) {
      relevantSections.push({
        section: sectionName,
        content: includeFullSpec ? sectionContent : sectionContent.substring(0, 500),
      });
    }
  }

  return relevantSections;
}

// ────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────

/**
 * Search subsystem specs by keyword query.
 *
 * Performs case-insensitive substring matching and returns ranked results.
 */
export function searchSubsystems(
  query: string,
  repoDir: string,
  options: SubsystemSearchOptions = {}
): SubsystemSearchResult[] {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const contextDir = join(repoDir, '.wavemill', 'context');

  // Check if context directory exists
  if (!existsSync(contextDir)) {
    return [];
  }

  // Find all spec files
  const specFiles = readdirSync(contextDir)
    .filter(f => f.endsWith('.md'))
    .map(f => join(contextDir, f));

  if (specFiles.length === 0) {
    return [];
  }

  const results: SubsystemSearchResult[] = [];

  for (const specPath of specFiles) {
    try {
      const content = readFileSync(specPath, 'utf-8');
      const subsystemName = extractSubsystemName(content);
      const subsystemId = specPath.split('/').pop()?.replace('.md', '') || 'unknown';

      // Filter to section if requested
      const searchContent = opts.sectionFilter
        ? extractSection(content, opts.sectionFilter)
        : content;

      if (!searchContent || searchContent.trim().length === 0) {
        continue; // Section not found
      }

      // Find matches
      const { count, locations } = findKeywordMatches(searchContent, query);

      if (count === 0) {
        continue; // No matches
      }

      // Calculate score
      const score = calculateScore(subsystemName, content, query, count, locations);

      if (score < opts.minScore) {
        continue;
      }

      // Get relevant sections
      const relevantSections = getRelevantSections(content, opts.includeFullSpecs);

      results.push({
        subsystemId,
        subsystemName,
        specPath,
        score,
        relevantSections,
      });
    } catch (error) {
      // Skip files we can't read
      console.warn(`Warning: Could not search ${specPath}: ${error}`);
    }
  }

  // Sort by score (descending)
  results.sort((a, b) => b.score - a.score);

  // Limit results
  return results.slice(0, opts.limit);
}

/**
 * Find subsystem specs relevant to an issue description.
 *
 * Uses hybrid retrieval: keyword search + file path matching + issue analysis.
 * This approach outperforms similarity-only by 11%+ (per AMA-Bench findings).
 */
export function findRelevantSubsystems(
  issueDescription: string,
  issueTitle: string,
  repoDir: string,
  options: SubsystemSearchOptions = {}
): SubsystemSearchResult[] {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const contextDir = join(repoDir, '.wavemill', 'context');

  // Check if context directory exists
  if (!existsSync(contextDir)) {
    return [];
  }

  // Detect subsystems
  let subsystems: Subsystem[];
  try {
    subsystems = detectSubsystems(repoDir, {
      minFiles: 3,
      useGitAnalysis: false, // Skip git analysis for speed
      maxSubsystems: 20,
    });
  } catch (error) {
    console.warn(`Warning: Subsystem detection failed: ${error}`);
    subsystems = [];
  }

  if (subsystems.length === 0) {
    return [];
  }

  // Strategy 1: File path matching
  const filesInIssue = detectFilesInIssue(issueDescription);
  const subsystemsFromFiles = detectSubsystemsInIssue(issueDescription, subsystems);

  // Strategy 2: Keyword search (title + description)
  const searchQuery = `${issueTitle} ${issueDescription}`.substring(0, 1000);
  const keywords = extractKeywords(searchQuery);

  // Combine results
  const resultMap = new Map<string, SubsystemSearchResult>();

  // Add file-based matches (high priority)
  for (const subsystem of subsystemsFromFiles) {
    const specPath = join(contextDir, `${subsystem.id}.md`);
    if (!existsSync(specPath)) continue;

    try {
      const content = readFileSync(specPath, 'utf-8');
      const relevantSections = getRelevantSections(content, opts.includeFullSpecs);

      const fileMatchCount = filesInIssue.filter(file =>
        subsystem.keyFiles.some(keyFile => file.includes(keyFile) || keyFile.includes(file))
      ).length;

      resultMap.set(subsystem.id, {
        subsystemId: subsystem.id,
        subsystemName: subsystem.name,
        specPath,
        score: 100 + fileMatchCount * 50, // High base score for file matches
        relevantSections,
      });
    } catch (error) {
      console.warn(`Warning: Could not read spec ${specPath}: ${error}`);
    }
  }

  // Add keyword-based matches
  for (const keyword of keywords) {
    const keywordResults = searchSubsystems(keyword, repoDir, {
      limit: 5,
      includeFullSpecs: opts.includeFullSpecs,
      minScore: 10,
    });

    for (const result of keywordResults) {
      if (resultMap.has(result.subsystemId)) {
        // Boost existing result
        const existing = resultMap.get(result.subsystemId)!;
        existing.score += result.score * 0.5;
      } else {
        resultMap.set(result.subsystemId, result);
      }
    }
  }

  // Convert to array and sort
  const results = Array.from(resultMap.values());
  results.sort((a, b) => b.score - a.score);

  // Limit results
  return results.slice(0, opts.limit);
}

/**
 * Extract meaningful keywords from text.
 *
 * Filters out common stop words and short terms.
 */
function extractKeywords(text: string): string[] {
  const stopWords = new Set([
    'add',
    'fix',
    'update',
    'the',
    'a',
    'an',
    'to',
    'for',
    'in',
    'on',
    'and',
    'or',
    'with',
    'that',
    'this',
    'from',
    'by',
    'at',
    'is',
    'are',
    'was',
    'were',
    'be',
    'been',
    'being',
    'have',
    'has',
    'had',
    'do',
    'does',
    'did',
    'will',
    'would',
    'should',
    'could',
    'may',
    'might',
    'must',
    'can',
  ]);

  const words = text
    .toLowerCase()
    .split(/\W+/)
    .filter(word => word.length > 3 && !stopWords.has(word));

  // Get unique words, limit to top 10 by frequency
  const wordCounts = new Map<string, number>();
  for (const word of words) {
    wordCounts.set(word, (wordCounts.get(word) || 0) + 1);
  }

  return Array.from(wordCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([word]) => word);
}
