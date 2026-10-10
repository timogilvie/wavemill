import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';

// The supported Node release exposes SQLite, but still labels it experimental.
// Suppress only that one warning while loading the binding; preserve all others.
const originalEmitWarning = process.emitWarning;
process.emitWarning = function (warning: string | Error, ...args: unknown[]) {
  const message = typeof warning === 'string' ? warning : warning.message;
  const type = typeof warning === 'string' ? args[0] : warning.name;
  if (type === 'ExperimentalWarning' && /sqlite/i.test(message)) return;
  return Reflect.apply(originalEmitWarning, process, [warning, ...args]);
} as typeof process.emitWarning;
let binding: { DatabaseSync: typeof DatabaseSyncType };
try {
  binding = createRequire(import.meta.url)('node:sqlite');
} finally {
  process.emitWarning = originalEmitWarning;
}
export const DatabaseSync = binding!.DatabaseSync;
