#!/usr/bin/env -S npx tsx
/**
 * Context Search - Keyword search across subsystem specs
 *
 * Performs case-insensitive substring matching across all subsystem specs.
 * Returns ranked results with relevant snippets.
 *
 * Usage:
 *   npx tsx tools/context-search.ts <query> [repo-path] [options]
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// ────────────────────────────────────────────────────────────────
// CLI Argument Parsing
// ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const isHelp = args.includes('--help') || args.includes('-h');

// Parse options
let limitIndex = args.indexOf('--limit');
let limit = limitIndex !== -1 && args[limitIndex + 1] ? parseInt(args[limitIndex + 1], 10) : 10;

let sectionIndex = args.indexOf('--section');
let sectionFilter = sectionIndex !== -1 && args[sectionIndex + 1] ? args[sectionIndex + 1] : null;

// First non-flag arg is query
const query = args.find((arg) => !arg.startsWith('-'));
const repoPath = args.find((arg, i) => i > 0 && !arg.startsWith('-') && arg !== query && arg !== args[limitIndex + 1] && arg !== args[sectionIndex + 1]) || process.cwd();
const repoDir = resolve(repoPath);

if (isHelp || !query) {
  console.log(`
Context Search - Keyword search across subsystem specs

Performs case-insensitive substring matching and returns ranked results.

Usage:
  npx tsx tools/context-search.ts <query> [repo-path] [options]

Arguments:
  <query>        Search term (case-insensitive)
  [repo-path]    Path to repository (default: current directory)

Options:
  --limit N         Max results to show (default: 10)
  --section NAME    Search only in specific section (e.g., "Purpose", "Architectural Constraints")
  --help, -h        Show this help message

Examples:
  # Search for "linear api"
  npx tsx tools/context-search.ts "linear api"

  # Limit to 5 results
  npx tsx tools/context-search.ts "error handling" --limit 5

  # Search only in Architectural Constraints
  npx tsx tools/context-search.ts "validation" --section "Architectural Constraints"
  `);
  process.exit(query ? 0 : 1);
}

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

interface SearchResult {
  subsystemId: string;
  subsystemName: string;
  specPath: string;
  score: number;
  snippets: string[];
  matchLocations: string[];
}

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

  return sectionLines.join('\n');
}

/**
 * Find all matches in content with context.
 */
function findMatches(content: string, query: string, contextLines = 1): {
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
  locations: string[]
): number {
  let score = 0;
  const queryLower = query.toLowerCase();

  // Name match (highest priority)
  if (subsystemName.toLowerCase().includes(queryLower)) {
    score += 100;
  }

  // Match count
  score += matchCount * 10;

  // Purpose section match (high priority)
  if (locations.includes('Purpose')) {
    score += 20;
  }

  // Architectural Constraints match
  if (locations.includes('Architectural Constraints')) {
    score += 15;
  }

  return score;
}

/**
 * Search a single spec file.
 */
function searchSpec(specPath: string, query: string, sectionFilter: string | null): SearchResult | null {
  const content = readFileSync(specPath, 'utf-8');
  const subsystemName = extractSubsystemName(content);
  const subsystemId = specPath.split('/').pop()?.replace('.md', '') || 'unknown';

  // Filter to section if requested
  const searchContent = sectionFilter ? extractSection(content, sectionFilter) : content;

  if (!searchContent || searchContent.trim().length === 0) {
    return null; // Section not found
  }

  // Find matches
  const { snippets, locations, count } = findMatches(searchContent, query);

  if (count === 0) {
    return null; // No matches
  }

  // Calculate score
  const score = calculateScore(subsystemName, content, query, count, locations);

  // Limit snippets to top 3
  const topSnippets = snippets.slice(0, 3);
  const topLocations = locations.slice(0, 3);

  return {
    subsystemId,
    subsystemName,
    specPath,
    score,
    snippets: topSnippets,
    matchLocations: topLocations,
  };
}

/**
 * Format a snippet for display.
 */
function formatSnippet(snippet: string, query: string): string {
  // Highlight query matches (simple approach: uppercase the match)
  const queryLower = query.toLowerCase();
  const lines = snippet.split('\n');

  const formatted = lines.map(line => {
    const lineLower = line.toLowerCase();
    const index = lineLower.indexOf(queryLower);

    if (index !== -1) {
      // Highlight the match
      const before = line.substring(0, index);
      const match = line.substring(index, index + query.length);
      const after = line.substring(index + query.length);
      return `${before}**${match}**${after}`;
    }

    return line;
  });

  return formatted.join('\n');
}

/**
 * Display search results.
 */
function displayResults(results: SearchResult[], query: string): void {
  if (results.length === 0) {
    console.log('');
    console.log(`No matches found for "${query}"`);
    console.log('');
    return;
  }

  console.log('');
  console.log(`Found ${results.length} match${results.length === 1 ? '' : 'es'} for "${query}"`);
  console.log('');

  results.forEach((result, index) => {
    console.log(`${index + 1}. ${result.subsystemName} (${result.subsystemId})`);
    console.log(`   ${result.specPath}`);
    console.log('');

    result.snippets.forEach((snippet, i) => {
      const location = result.matchLocations[i];
      console.log(`   [${location}]`);
      const formatted = formatSnippet(snippet, query);
      formatted.split('\n').forEach(line => {
        console.log(`   ${line}`);
      });
      console.log('');
    });
  });
}

// ────────────────────────────────────────────────────────────────
// Main Logic
// ────────────────────────────────────────────────────────────────

async function main() {
  const contextDir = join(repoDir, '.wavemill', 'context');

  // Check if context directory exists
  if (!existsSync(contextDir)) {
    console.error('Error: No subsystem specs found');
    console.error('Initialize first: wavemill context init');
    process.exit(1);
  }

  // Find all spec files
  const specFiles = readdirSync(contextDir)
    .filter(f => f.endsWith('.md'))
    .map(f => join(contextDir, f));

  if (specFiles.length === 0) {
    console.error('Error: No subsystem specs found in .wavemill/context/');
    console.error('Initialize first: wavemill context init');
    process.exit(1);
  }

  // Search each spec
  const results: SearchResult[] = [];

  for (const specPath of specFiles) {
    try {
      const result = searchSpec(specPath, query, sectionFilter);
      if (result) {
        results.push(result);
      }
    } catch (error) {
      // Skip files we can't read
      console.error(`Warning: Could not search ${specPath}: ${error}`);
    }
  }

  // Sort by score (descending)
  results.sort((a, b) => b.score - a.score);

  // Limit results
  const limitedResults = results.slice(0, limit);

  // Display
  displayResults(limitedResults, query);
}

main().catch((error) => {
  console.error('Error:', error.message);
  process.exit(1);
});
