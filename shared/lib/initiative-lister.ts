/**
 * Initiative Lister
 *
 * Lists and ranks Linear initiatives by various criteria.
 * Used by plan-initiative tool's list subcommand.
 *
 * @module initiative-lister
 */

import { getInitiatives } from './linear.js';

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

/**
 * Ranked initiative with computed metadata.
 */
export interface RankedInitiative {
  /** Linear initiative ID */
  id: string;
  /** Initiative name */
  name: string;
  /** Description */
  description: string;
  /** Status (Active, Planned, Completed) */
  status: string;
  /** Total issue count across all projects */
  issueCount: number;
  /** Target date (ISO string or null) */
  targetDate: string | null;
  /** Owner name (or null) */
  owner: string | null;
  /** Project names associated with this initiative */
  projectNames: string[];
}

/**
 * Options for listing initiatives.
 */
export interface ListInitiativesOptions {
  /** Filter by project name (optional) */
  projectName?: string;
  /** Maximum number of results to return */
  maxDisplay?: number;
}

// ────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────

/**
 * List and rank Linear initiatives.
 *
 * Fetches all initiatives from Linear, filters by project if specified,
 * computes issue counts, and ranks by:
 * 1. Zero-issue initiatives first (ready for planning)
 * 2. Active status before Planned
 * 3. Alphabetically by name
 *
 * @param options - Listing options
 * @returns Array of ranked initiatives (limited by maxDisplay)
 *
 * @example
 * ```typescript
 * const initiatives = await listInitiatives({ maxDisplay: 10 });
 * initiatives.forEach(init => {
 *   console.log(`${init.name} (${init.issueCount} issues)`);
 * });
 * ```
 */
export async function listInitiatives(
  options: ListInitiativesOptions = {}
): Promise<RankedInitiative[]> {
  const { projectName, maxDisplay = 9 } = options;

  const initiatives = await getInitiatives();

  // Filter by project if specified
  let filtered = initiatives;
  if (projectName) {
    filtered = initiatives.filter((init: any) =>
      init.projects?.nodes?.some((p: any) => p.name === projectName)
    );
  }

  // Compute issue count per initiative (from associated projects)
  const ranked = filtered.map((init: any) => {
    const issueCount = (init.projects?.nodes || []).reduce(
      (sum: number, p: any) => {
        return sum + (p.issues?.nodes?.length || 0);
      },
      0
    );

    return {
      id: init.id,
      name: init.name,
      description: init.description || '',
      status: init.status,
      issueCount,
      targetDate: init.targetDate || null,
      owner: init.owner?.name || null,
      projectNames: (init.projects?.nodes || []).map((p: any) => p.name),
    };
  });

  // Sort: zero-issue first, then Active before Planned, then by name
  ranked.sort((a: any, b: any) => {
    // Prioritize those without issues
    if (a.issueCount === 0 && b.issueCount > 0) return -1;
    if (a.issueCount > 0 && b.issueCount === 0) return 1;

    // Then by status: Active > Planned > Completed
    const statusOrder: Record<string, number> = {
      Active: 0,
      Planned: 1,
      Completed: 2,
    };
    const sa = statusOrder[a.status] ?? 9;
    const sb = statusOrder[b.status] ?? 9;
    if (sa !== sb) return sa - sb;

    // Then alphabetically
    return a.name.localeCompare(b.name);
  });

  // Truncate to maxDisplay
  return ranked.slice(0, maxDisplay);
}
