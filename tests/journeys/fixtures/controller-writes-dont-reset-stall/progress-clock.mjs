// HOK-3422: apply the existing background journey's clock seam to Ready's
// shared progress reader as well. Only progress CLI processes see the skew;
// controller writes and all other jobs keep real time.
import { readFileSync } from 'node:fs';

const script = process.argv[1] ?? '';
const skewFile = process.env.FAKE_ROOT ? `${process.env.FAKE_ROOT}/progress-clock-skew-minutes` : '';

if (skewFile && /[\\/]tools[\\/](task-progress|stage-agent-disposition|ready-remediation-disposition)\.ts$/.test(script)) {
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
