#!/usr/bin/env -S npx tsx
/**
 * Shell bridge to `tests/lib/task-builder.ts` (HOK-3223), used by
 * `fixture_task` / `fixture_workflow_state` in `tests/lib/state-fixtures.sh`
 * so shell and TS fixtures share one schema, one default row and one
 * validator.
 *
 * Usage:
 *   build-fixture-task.ts [--bare] <task-id> [field=value | field:=json ...] [-- <task-id> ...]
 *
 * Prints one compact JSON object on stdout: `{"<task-id>": {...}, ...}` (the
 * `.tasks` map). `--bare` skips the default row for every task.
 *
 * Values:
 *   field=value   typed by the schema: a field that admits a string (`pr`,
 *                 `slug`, `phase`, ...) keeps `value` verbatim, so `pr=9999`
 *                 stays the string the shell writers store; any other field
 *                 (`challenge`, `challengeArms`, `lifecycle`, `queueHandoffAt`)
 *                 parses `value` as JSON.
 *   field:=json   always JSON (`pr:=1230` for a numeric PR, `attempt:=null`).
 *
 * Exit codes: 0 ok, 1 fixture rejected (unknown field, schema violation),
 * 2 usage error.
 */
import { fileURLToPath } from 'node:url';
import { buildTask, TASK_RECORD_SCHEMA_PROPERTIES, TaskFixtureError } from '../task-builder.ts';
import type { TaskRecord } from '../../../shared/lib/workflow-state.ts';

class UsageError extends Error {}

function admitsString(field: string): boolean {
  const type = TASK_RECORD_SCHEMA_PROPERTIES[field]?.type;
  return type === 'string' || (Array.isArray(type) && type.includes('string'));
}

function parseJson(field: string, raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new UsageError(`field "${field}" needs a JSON value, got ${JSON.stringify(raw)}`);
  }
}

/** Parse one `field=value` / `field:=json` argument. Unknown fields pass through for buildTask to reject. */
export function parseFieldArg(arg: string): [string, unknown] {
  const eq = arg.indexOf('=');
  if (eq <= 0) throw new UsageError(`expected field=value or field:=json, got ${JSON.stringify(arg)}`);
  if (arg[eq - 1] === ':') {
    const field = arg.slice(0, eq - 1);
    if (!field) throw new UsageError(`expected field:=json, got ${JSON.stringify(arg)}`);
    return [field, parseJson(field, arg.slice(eq + 1))];
  }
  const field = arg.slice(0, eq);
  const raw = arg.slice(eq + 1);
  // An unknown field keeps its raw string; buildTask names it in the error.
  if (admitsString(field) || !(field in TASK_RECORD_SCHEMA_PROPERTIES)) return [field, raw];
  return [field, parseJson(field, raw)];
}

/** Build the `.tasks` map described by `argv`. */
export function buildFixtureTasks(argv: string[]): Record<string, TaskRecord> {
  let bare = false;
  const args = [...argv];
  if (args[0] === '--bare') {
    bare = true;
    args.shift();
  }
  const tasks: Record<string, TaskRecord> = {};
  while (args.length > 0) {
    const id = args.shift() as string;
    if (!id || id === '--' || id.includes('=')) throw new UsageError(`expected a task id, got ${JSON.stringify(id)}`);
    if (Object.hasOwn(tasks, id)) throw new UsageError(`task ${id} given twice`);
    const overrides: Record<string, unknown> = {};
    while (args.length > 0 && args[0] !== '--') {
      const [field, value] = parseFieldArg(args.shift() as string);
      if (Object.hasOwn(overrides, field)) throw new UsageError(`task ${id}: field "${field}" given twice`);
      overrides[field] = value;
    }
    if (args[0] === '--') {
      args.shift();
      if (args.length === 0) throw new UsageError('expected a task id after --');
    }
    try {
      tasks[id] = buildTask(overrides as TaskRecord, { bare });
    } catch (error) {
      if (error instanceof TaskFixtureError) throw new TaskFixtureError(`task ${id}: ${error.message}`);
      throw error;
    }
  }
  if (Object.keys(tasks).length === 0) throw new UsageError('expected at least one task id');
  return tasks;
}

const USAGE = 'usage: build-fixture-task.ts [--bare] <task-id> [field=value | field:=json ...] [-- <task-id> ...]';

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify(buildFixtureTasks(process.argv.slice(2)))}\n`);
  } catch (error) {
    const usage = error instanceof UsageError;
    process.stderr.write(`build-fixture-task: ${(error as Error).message}\n${usage ? `${USAGE}\n` : ''}`);
    process.exit(usage ? 2 : 1);
  }
}
