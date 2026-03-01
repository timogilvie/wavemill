/**
 * ANSI color escape sequences for terminal output formatting.
 *
 * These constants provide a centralized way to add color and styling to CLI output.
 * Usage: Concatenate with strings or use in template literals.
 *
 * @example
 * ```typescript
 * import { GREEN, BOLD, NC } from './colors.ts';
 *
 * console.log(`${GREEN}${BOLD}Success!${NC} Operation completed.`);
 * ```
 */

/**
 * Cyan text color
 */
export const CYAN = '\x1b[36m';

/**
 * Green text color
 */
export const GREEN = '\x1b[32m';

/**
 * Yellow text color
 */
export const YELLOW = '\x1b[33m';

/**
 * Red text color
 */
export const RED = '\x1b[31m';

/**
 * Bold text style
 */
export const BOLD = '\x1b[1m';

/**
 * Dim/faint text style
 */
export const DIM = '\x1b[2m';

/**
 * Reset all formatting (No Color)
 */
export const NC = '\x1b[0m';
