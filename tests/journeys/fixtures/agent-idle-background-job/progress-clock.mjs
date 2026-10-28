// Clock seam for the liveness primitive in the agent-idle-background-job
// journey (HOK-3137). Preloaded via NODE_OPTIONS into every node process the
// monitor spawns, but it only acts inside `tools/task-progress.ts`.
//
// The incident's idle window lasted past the primitive's 30-minute stall
// threshold; a journey has ~90s. The tick clock (mill-clock) does not reach
// the primitive, which reads the wall clock, so while
// $FAKE_ROOT/progress-clock-skew-minutes exists (written by the fake agent
// for the duration of its idle window) the primitive's "now" is shifted
// forward by that many minutes. Every other process keeps the real clock.
import { readFileSync } from 'node:fs';

const script = process.argv[1] ?? '';
const skewFile = process.env.FAKE_ROOT ? `${process.env.FAKE_ROOT}/progress-clock-skew-minutes` : '';

if (skewFile && /[\\/]tools[\\/]task-progress\.ts$/.test(script)) {
  let skewMs = 0;
  try {
    const minutes = Number.parseFloat(readFileSync(skewFile, 'utf8'));
    if (Number.isFinite(minutes) && minutes > 0) skewMs = minutes * 60_000;
  } catch {
    // No skew file: real clock.
  }
  if (skewMs > 0) {
    const RealDate = Date;
    class SkewedDate extends RealDate {
      constructor(...args) {
        if (args.length === 0) super(RealDate.now() + skewMs);
        else super(...args);
      }
      static now() {
        return RealDate.now() + skewMs;
      }
    }
    globalThis.Date = SkewedDate;
  }
}
