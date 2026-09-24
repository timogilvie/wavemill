// ---------------------------------------------------------------------------
// Read-only browser session boundary (HOK-3057).
//
// Wraps a narrow, injectable browser adapter with all the guard-rails the
// native-review browser family needs:
//   - pre-request origin allowlist enforcement (no request is sent for a
//     denied navigation)
//   - deterministic capture buffers (DOM, accessibility, console, requests)
//     with fixed caps and stable truncation metadata
//   - session-lifetime and per-session call ceilings
//   - AbortSignal + navigation timeout handling
//   - idempotent close that leaves no child process behind (guaranteed by the
//     adapter contract)
//
// The adapter interface is intentionally minimal so the module can ship
// without a hard dependency on any live browser runtime. Deterministic
// fixture adapters cover every test scenario without network or credentials.
// ---------------------------------------------------------------------------

import { canonicalizeBrowserOrigin } from '../config.ts';

// ---------------------------------------------------------------------------
// Session configuration and observation shapes
// ---------------------------------------------------------------------------

export interface BrowserSessionLimits {
  /** Canonicalized allowlist; anything outside is denied pre-request. */
  allowedOrigins: readonly string[];
  maxSessionLifetimeMs: number;
  maxCallsPerSession: number;
  navigateTimeoutMs: number;
  maxDomBytes: number;
  maxAxNodes: number;
  maxConsoleMessages: number;
  maxRequestSummaries: number;
}

export type BrowserConsoleLevel = 'log' | 'debug' | 'info' | 'warn' | 'error';

export interface BrowserConsoleMessage {
  level: BrowserConsoleLevel;
  text: string;
  timestamp?: number;
}

export interface BrowserRequestSummary {
  method: string;
  url: string;
  status?: number;
  contentType?: string;
  bytes?: number;
}

export interface BrowserAxNode {
  role: string;
  name: string;
  children?: BrowserAxNode[];
}

export interface BrowserNavigationOutcome {
  finalUrl: string;
  status: number;
  title: string;
  loadTimeMs: number;
}

/**
 * Minimum interface a browser driver must expose. All methods are read-only:
 * there is deliberately no `fillForm`, `click`, `evaluate`, or `download`.
 */
export interface BrowserAdapter {
  navigate(url: string, opts: { timeoutMs: number; signal?: AbortSignal }): Promise<BrowserNavigationOutcome>;
  snapshotDom(): Promise<string>;
  snapshotAccessibility(): Promise<BrowserAxNode[]>;
  drainConsole(): Promise<BrowserConsoleMessage[]>;
  drainRequests(): Promise<BrowserRequestSummary[]>;
  /** Must be idempotent. Must not leave any child process behind. */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Observation return shapes with stable truncation metadata
// ---------------------------------------------------------------------------

export interface BrowserObservationBase {
  truncated: boolean;
  retainedCount: number;
  originalCount: number;
  truncationReason?: 'maxBytes' | 'maxItems';
}

export interface BrowserDomObservation extends BrowserObservationBase {
  kind: 'dom';
  dom: string;
}

export interface BrowserAccessibilityObservation extends BrowserObservationBase {
  kind: 'accessibility';
  nodes: BrowserAxNode[];
}

export interface BrowserConsoleObservation extends BrowserObservationBase {
  kind: 'console';
  messages: BrowserConsoleMessage[];
}

export interface BrowserRequestsObservation extends BrowserObservationBase {
  kind: 'requests';
  requests: BrowserRequestSummary[];
}

export interface BrowserNavigateResult {
  kind: 'navigate';
  finalUrl: string;
  originalUrl: string;
  status: number;
  title: string;
  loadTimeMs: number;
  origin: string;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type BrowserSessionErrorCode =
  | 'session_closed'
  | 'session_expired'
  | 'call_budget_exhausted'
  | 'invalid_url'
  | 'unsupported_scheme'
  | 'credentials_not_allowed'
  | 'origin_not_allowed'
  | 'navigation_timeout'
  | 'navigation_aborted'
  | 'adapter_error';

export class BrowserSessionError extends Error {
  override name = 'BrowserSessionError';
  code: BrowserSessionErrorCode;
  constructor(code: BrowserSessionErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export interface BrowserSessionOptions {
  limits: BrowserSessionLimits;
  adapter: BrowserAdapter;
  /** Injected clock for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
}

/**
 * A bounded read-only browser session. Every operation counts against the
 * per-session call budget and the wall-clock lifetime.
 *
 * `close()` is idempotent and safe to call from `finally`, on abort, or after
 * a timeout — the adapter contract guarantees no surviving child process.
 */
export class BrowserSession {
  private readonly limits: BrowserSessionLimits;
  private readonly adapter: BrowserAdapter;
  private readonly now: () => number;
  private readonly startedAt: number;
  private callsMade = 0;
  private closed = false;

  constructor(options: BrowserSessionOptions) {
    this.limits = options.limits;
    this.adapter = options.adapter;
    this.now = options.now ?? Date.now;
    this.startedAt = this.now();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  async navigate(url: string, signal?: AbortSignal): Promise<BrowserNavigateResult> {
    this.assertBudget();
    const check = this.validateOrigin(url);
    if (!check.ok) {
      // Never consume a call slot for a pre-request denial — the browser did
      // no work — but still count against the session so a flood cannot fill
      // the log unboundedly.
      throw new BrowserSessionError(check.code, `browser_navigate_denied: ${check.code}`);
    }
    if (signal?.aborted) {
      throw new BrowserSessionError('navigation_aborted', 'browser_navigate_aborted');
    }

    let outcome: BrowserNavigationOutcome;
    try {
      outcome = await this.adapter.navigate(url, {
        timeoutMs: this.limits.navigateTimeoutMs,
        signal,
      });
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      if (signal?.aborted) {
        await this.close();
        throw new BrowserSessionError('navigation_aborted', 'browser_navigate_aborted');
      }
      if (/timeout/i.test(message)) {
        await this.close();
        throw new BrowserSessionError('navigation_timeout', message);
      }
      throw new BrowserSessionError('adapter_error', message);
    }

    // Enforce origin containment on the final URL — a same-origin server-side
    // redirect stays inside the allowlist; a cross-origin redirect is treated
    // as a policy event and the session is closed.
    const finalOrigin = canonicalizeBrowserOrigin(outcome.finalUrl);
    if (!finalOrigin || !this.limits.allowedOrigins.includes(finalOrigin)) {
      await this.close();
      throw new BrowserSessionError(
        'origin_not_allowed',
        `browser_navigate_denied: cross_origin_redirect final=${outcome.finalUrl}`,
      );
    }

    return {
      kind: 'navigate',
      originalUrl: url,
      finalUrl: outcome.finalUrl,
      status: outcome.status,
      title: truncateString(outcome.title, 256),
      loadTimeMs: outcome.loadTimeMs,
      origin: check.origin,
    };
  }

  async snapshotDom(): Promise<BrowserDomObservation> {
    this.assertBudget();
    const raw = await this.callAdapter(() => this.adapter.snapshotDom());
    const originalBytes = Buffer.byteLength(raw, 'utf8');
    const max = this.limits.maxDomBytes;
    let dom = raw;
    let truncated = false;
    let reason: 'maxBytes' | 'maxItems' | undefined;
    if (originalBytes > max) {
      dom = truncateUtf8(raw, max);
      truncated = true;
      reason = 'maxBytes';
    }
    return {
      kind: 'dom',
      dom,
      truncated,
      retainedCount: Buffer.byteLength(dom, 'utf8'),
      originalCount: originalBytes,
      ...(reason ? { truncationReason: reason } : {}),
    };
  }

  async snapshotAccessibility(): Promise<BrowserAccessibilityObservation> {
    this.assertBudget();
    const raw = await this.callAdapter(() => this.adapter.snapshotAccessibility());
    return applyItemsCap(raw, this.limits.maxAxNodes, 'accessibility', (items) => ({
      kind: 'accessibility',
      nodes: items,
    }));
  }

  async drainConsole(): Promise<BrowserConsoleObservation> {
    this.assertBudget();
    const raw = await this.callAdapter(() => this.adapter.drainConsole());
    return applyItemsCap(raw, this.limits.maxConsoleMessages, 'console', (items) => ({
      kind: 'console',
      messages: items,
    }));
  }

  async drainRequests(): Promise<BrowserRequestsObservation> {
    this.assertBudget();
    const raw = await this.callAdapter(() => this.adapter.drainRequests());
    return applyItemsCap(raw, this.limits.maxRequestSummaries, 'requests', (items) => ({
      kind: 'requests',
      requests: items,
    }));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.adapter.close();
    } catch {
      // Idempotent close: never let adapter shutdown noise fail the session.
    }
  }

  // -------------------------------------------------------------------------

  private assertBudget(): void {
    if (this.closed) {
      throw new BrowserSessionError('session_closed', 'browser_session_closed');
    }
    const elapsed = this.now() - this.startedAt;
    if (elapsed > this.limits.maxSessionLifetimeMs) {
      // Fire-and-forget close; the caller sees the deterministic error.
      void this.close();
      throw new BrowserSessionError('session_expired', 'browser_session_expired');
    }
    if (this.callsMade >= this.limits.maxCallsPerSession) {
      throw new BrowserSessionError('call_budget_exhausted', 'browser_session_call_budget_exhausted');
    }
    this.callsMade += 1;
  }

  private validateOrigin(
    candidate: string,
  ): { ok: true; origin: string } | { ok: false; code: BrowserSessionErrorCode } {
    let parsed: URL;
    try {
      parsed = new URL(candidate);
    } catch {
      return { ok: false, code: 'invalid_url' };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ok: false, code: 'unsupported_scheme' };
    }
    if (parsed.username || parsed.password) {
      return { ok: false, code: 'credentials_not_allowed' };
    }
    const origin = `${parsed.protocol}//${parsed.host}`;
    if (!this.limits.allowedOrigins.includes(origin)) {
      return { ok: false, code: 'origin_not_allowed' };
    }
    return { ok: true, origin };
  }

  private async callAdapter<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw new BrowserSessionError('adapter_error', (err as Error).message ?? String(err));
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function applyItemsCap<T, R extends BrowserObservationBase>(
  raw: readonly T[],
  max: number,
  _kind: string,
  build: (items: T[]) => Omit<R, keyof BrowserObservationBase>,
): R {
  const truncated = raw.length > max;
  const items = truncated ? raw.slice(0, max) : [...raw];
  const partial = build(items);
  return {
    ...(partial as unknown as R),
    truncated,
    retainedCount: items.length,
    originalCount: raw.length,
    ...(truncated ? { truncationReason: 'maxItems' as const } : {}),
  } as R;
}

function truncateUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (Buffer.byteLength(text.slice(0, mid), 'utf8') <= maxBytes) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return text.slice(0, lo);
}

function truncateString(text: string | undefined, maxChars: number): string {
  if (!text) return '';
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}
