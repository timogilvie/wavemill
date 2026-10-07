// Replay Labels
// Safety labeling for tools based on idempotency

/**
 * Tool replay safety labels
 * safe: Tool can be safely replayed after a crash (read-only operations)
 * unsafe: Tool should not be replayed after a crash (mutating operations)
 */
export const REPLAY_LABELS: Record<string, 'safe' | 'unsafe'> = {
  // Safe tools (read-only operations)
  'read_file': 'safe',
  'list_files': 'safe',
  'search_text': 'safe',
  'read_plan': 'safe',
  'read_task_packet': 'safe',
  'git_status': 'safe',
  'git_diff': 'safe',
  'git_diff_stat': 'safe',
  'git_log': 'safe',
  
  // Unsafe tools (mutating operations)
  'run_tests': 'unsafe', // Can write caches/snapshots and is expensive
  'run_format': 'unsafe', // Mutates files
  'apply_patch': 'unsafe', // Worktree mutation, non-idempotent
  'git_add': 'unsafe', // Index mutation
  'git_commit': 'unsafe', // History mutation
  'write_artifact': 'unsafe', // Artifact side effects
  'create_marker': 'unsafe', // Marker side effects
  'update_status': 'unsafe', // Status side effects
};

/**
 * Get replay label for a tool
 * @param toolName Name of the tool
 * @returns 'safe' or 'unsafe' - defaults to 'unsafe' for unknown tools (fail closed)
 */
export function getReplayLabel(toolName: string): 'safe' | 'unsafe' {
  return REPLAY_LABELS[toolName] || 'unsafe';
}

/**
 * Validate that all known tools have replay labels defined
 * @throws Error if any tool is missing a label
 */
export function validateReplayLabels(knownTools: string[]): void {
  const missingLabels = knownTools.filter(tool => !(tool in REPLAY_LABELS));
  if (missingLabels.length > 0) {
    throw new Error(`Missing replay labels for tools: ${missingLabels.join(', ')}`);
  }
}
