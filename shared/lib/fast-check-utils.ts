/**
 * Property-based test harness for the HOK-3230 suites.
 *
 * `assertProperty` is a thin wrapper around `fc.assert` that:
 *   1. Resolves a reproducible seed (env override → fixed CI seed → random).
 *   2. Caps the run count per suite so each stays ≤ 5 s in CI.
 *   3. Always prints the seed and the shrunk counter-example on failure so a
 *      CI red can be reproduced locally with `FAST_CHECK_SEED=<n>`.
 *
 * The seed is unconditionally echoed to stderr on the first call per process
 * so a run with 200 passing properties still reports which seed produced the
 * green — otherwise a "flaky" failure under a drifting random seed would be
 * invisible until it surfaces as a counter-example.
 */
import fc from 'fast-check';

/** Fixed seed used when `CI=true` and no `FAST_CHECK_SEED` is provided. */
export const DEFAULT_CI_SEED = 0x30303017;

export interface AssertPropertyOptions {
  /** Short identifier printed in the failure header. */
  name?: string;
  /** How many random inputs to try. Default 200; shell-shelling suites pass smaller counts. */
  numRuns?: number;
  /** Optional path override for the counter-example replay knob. */
  path?: string;
}

/**
 * Resolve the seed for this process in the documented precedence:
 *   `FAST_CHECK_SEED` env (any integer, decimal or signed) → `CI=1`/`CI=true` ⇒
 *   `DEFAULT_CI_SEED` → random (`Date.now()` xor pid, pinned per process).
 *
 * The per-process cache makes consecutive properties in the same `node --test`
 * run share a seed, so re-running a single file with `FAST_CHECK_SEED=<n>` is
 * sufficient to replay every property in that file.
 */
let cachedSeed: number | undefined;
export function resolveSeed(): number {
  if (cachedSeed !== undefined) return cachedSeed;
  const raw = process.env.FAST_CHECK_SEED;
  if (raw && /^-?\d+$/.test(raw)) {
    cachedSeed = Number(raw);
    return cachedSeed;
  }
  if (process.env.CI === 'true' || process.env.CI === '1') {
    cachedSeed = DEFAULT_CI_SEED;
    return cachedSeed;
  }
  cachedSeed = (Date.now() ^ (process.pid << 16)) >>> 0;
  return cachedSeed;
}

let seedAnnounced = false;
function announceSeedOnce(seed: number): void {
  if (seedAnnounced) return;
  seedAnnounced = true;
  // One line per process; readable without parsing.
  process.stderr.write(`[fast-check] seed=${seed} (set FAST_CHECK_SEED=${seed} to replay)\n`);
}

/**
 * Run a synchronous property with the shared seeded harness. Throws (via
 * `fc.assert`'s default error path) with a formatted header on failure.
 *
 * We hand the configuration directly to `fc.assert` rather than installing a
 * custom `reporter`: fast-check's default reporter already stringifies the
 * counter-example, path, numRuns and shrink depth. Replacing it would require
 * re-implementing that formatter. Instead we wrap the thrown error so the seed
 * and property name are added on top of fast-check's native message.
 */
export function assertProperty<Ts>(
  prop: fc.IRawProperty<Ts, boolean | void>,
  opts: AssertPropertyOptions = {},
): void {
  const seed = resolveSeed();
  announceSeedOnce(seed);
  const numRuns = opts.numRuns ?? 200;
  try {
    fc.assert(prop, {
      seed,
      numRuns,
      path: opts.path,
      // `endOnFailure: true` saves wall-clock time at the cost of less
      // detail on repeated failures. We rely on the counter-example alone.
      endOnFailure: true,
    });
  } catch (err) {
    const inner = err instanceof Error ? err.message : String(err);
    const header = [
      `fast-check property failed`,
      `  name:    ${opts.name ?? '(unnamed)'}`,
      `  seed:    ${seed}`,
      `  numRuns: ${numRuns}`,
      `  replay:  FAST_CHECK_SEED=${seed} node --test ${process.argv[process.argv.length - 1] ?? '<file>'}`,
    ].join('\n');
    throw new Error(`${header}\n${inner}`);
  }
}

/**
 * Async version of {@link assertProperty}. Use for properties whose predicate
 * returns a Promise (e.g. a reconciler run that invokes `bash -c`).
 */
export async function assertPropertyAsync<Ts>(
  prop: fc.IAsyncProperty<Ts>,
  opts: AssertPropertyOptions = {},
): Promise<void> {
  const seed = resolveSeed();
  announceSeedOnce(seed);
  const numRuns = opts.numRuns ?? 50;
  try {
    await fc.assert(prop, {
      seed,
      numRuns,
      path: opts.path,
      endOnFailure: true,
    });
  } catch (err) {
    const inner = err instanceof Error ? err.message : String(err);
    const header = [
      `fast-check async property failed`,
      `  name:    ${opts.name ?? '(unnamed)'}`,
      `  seed:    ${seed}`,
      `  numRuns: ${numRuns}`,
      `  replay:  FAST_CHECK_SEED=${seed} node --test ${process.argv[process.argv.length - 1] ?? '<file>'}`,
    ].join('\n');
    throw new Error(`${header}\n${inner}`);
  }
}

/**
 * Internal: reset the cached seed. Only used by the harness self-test; a
 * real suite inherits one seed per process so every property in one file is
 * replayable with a single `FAST_CHECK_SEED=` value.
 */
export function _resetSeedCacheForTests(): void {
  cachedSeed = undefined;
  seedAnnounced = false;
}
