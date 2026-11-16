/** Stable host identifiers at the SDK task-cost boundary. */
import { createHash } from 'node:crypto';

// The SDK contract's id pattern (validators); ids that do not satisfy it are
// pseudonymized so a native session id with `_` or a path never reaches the
// ledger raw.
const SDK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** Map a raw id onto the SDK contract's id alphabet (stable across runs). */
export function toSdkId(raw: string | null | undefined, fallback = 'unknown'): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (value === '') return fallback;
  if (SDK_ID_PATTERN.test(value)) return value;
  if (!/[\\/]/.test(value)) {
    const slug = value.replace(/[^A-Za-z0-9._:-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '');
    if (SDK_ID_PATTERN.test(slug)) return slug;
  }
  return `h-${createHash('sha256').update(value).digest('hex').slice(0, 32)}`;
}

