// Browser session management for read-only inspection
import type { AbortSignal } from 'node:abort-controller';
import { buildTrustMetadata } from '../provenance.ts';
import type { ToolDescriptor, WavemillToolResult } from './tools/types.ts';
import { redactSecrets } from './tools/redaction.ts';

// Configuration interfaces
export interface BrowserInspectionConfig {
  /**
   * Allowed origins for browser navigation.
   * Must be absolute URLs with scheme, host, and optional port.
   */
  allowedOrigins: readonly string[];
  /** Session lifetime in milliseconds */
  sessionLifetimeMs: number;
  /** Navigation timeout in milliseconds */
  navigationTimeoutMs: number;
  /** Maximum output size for DOM snapshots in bytes */
  domSnapshotMaxBytes: number;
  /** Maximum output size for accessibility snapshots in bytes */
  a11ySnapshotMaxBytes: number;
  /** Maximum number of console messages to capture */
  maxConsoleMessages: number;
  /** Maximum number of network requests to capture */
  maxNetworkRequests: number;
}

export interface ResolvedBrowserConfig {
  allowedOrigins: readonly string[];
  sessionLifetimeMs: number;
  navigationTimeoutMs: number;
  domSnapshotMaxBytes: number;
  a11ySnapshotMaxBytes: number;
  maxConsoleMessages: number;
  maxNetworkRequests: number;
}

// Tool parameter interfaces (re-exported for session use)
export interface BrowserNavigateParams {
  url: string;
}

export interface BrowserDomSnapshotParams {
  selector?: string;
}

export interface BrowserA11ySnapshotParams {}

export interface BrowserConsoleMessagesParams {}

export interface BrowserNetworkRequestsParams {}

// Tool result interfaces (re-exported for session use)
export interface BrowserNavigateSuccessDetails {
  ok: true;
  tool: 'browser_navigate';
  url: string;
  finalUrl: string;
  statusCode?: number;
  title?: string;
}

export interface BrowserDomSnapshotSuccessDetails {
  ok: true;
  tool: 'browser_dom_snapshot';
  url: string;
  selector?: string;
  html: string;
  originalBytes: number;
  retainedBytes: number;
  truncated: boolean;
}

export interface BrowserA11ySnapshotSuccessDetails {
  ok: true;
  tool: 'browser_a11y_snapshot';
  url: string;
  tree: unknown;
  originalBytes: number;
  retainedBytes: number;
  truncated: boolean;
}

export interface BrowserConsoleMessage {
  type: string;
  text: string;
  timestamp: number;
  location?: string;
}

export interface BrowserConsoleMessagesSuccessDetails {
  ok: true;
  tool: 'browser_console_messages';
  url: string;
  messages: BrowserConsoleMessage[];
  originalCount: number;
  retainedCount: number;
  truncated: boolean;
}

export interface BrowserNetworkRequest {
  url: string;
  method: string;
  status?: number;
  type: string;
  timestamp: number;
}

export interface BrowserNetworkRequestsSuccessDetails {
  ok: true;
  tool: 'browser_network_requests';
  url: string;
  requests: BrowserNetworkRequest[];
  originalCount: number;
  retainedCount: number;
  truncated: boolean;
}

export interface BrowserToolErrorDetails {
  ok: false;
  tool: 'browser_navigate' | 'browser_dom_snapshot' | 'browser_a11y_snapshot' | 'browser_console_messages' | 'browser_network_requests';
  error: {
    code: 'invalid_url' | 'navigation_blocked' | 'timeout' | 'aborted' | 'not_allowed_origin' | 'network_error' | 'invalid_selector' | 'parse_error' | 'unauthorized' | 'forbidden' | 'not_found' | 'server_error' | 'too_many_redirects' | 'ssl_error' | 'malformed_url' | 'invalid_scheme' | 'navigation_timeout' | 'session_expired' | 'session_closed' | 'internal_error';
    message: string;
  };
}

// Transport abstraction for testability
export interface BrowserTransport {
  navigate(url: string, timeoutMs: number, signal?: AbortSignal): Promise<{
    finalUrl: string;
    statusCode?: number;
    title?: string;
  }>;
  
  domSnapshot(selector?: string): Promise<{
    html: string;
    bytes: number;
  }>;
  
  a11ySnapshot(): Promise<{
    tree: unknown;
    bytes: number;
  }>;
  
  consoleMessages(): Promise<BrowserConsoleMessage[]>;
  
  networkRequests(): Promise<BrowserNetworkRequest[]>;
  
  close(): Promise<void>;
  
  isClosed(): boolean;
}

// Browser session implementation
export class BrowserSession {
  private readonly _transport: BrowserTransport;
  private readonly _config: ResolvedBrowserConfig;
  private readonly _startTime: number;
  private _closed: boolean = false;
  private _currentUrl: string | null = null;
  
  constructor(transport: BrowserTransport, config: ResolvedBrowserConfig) {
    this._transport = transport;
    this._config = config;
    this._startTime = Date.now();
  }
  
  async navigate(
    params: BrowserNavigateParams,
    signal?: AbortSignal
  ): Promise<WavemillToolResult<BrowserNavigateDetails>> {
    if (this._closed) {
      return this._errorResult('browser_navigate', 'session_closed', 'Browser session is closed');
    }
    
    if (Date.now() - this._startTime > this._config.sessionLifetimeMs) {
      this._closed = true;
      return this._errorResult('browser_navigate', 'session_expired', 'Browser session expired');
    }
    
    const urlValidation = this._validateUrl(params.url);
    if (!urlValidation.ok) {
      return this._errorResult('browser_navigate', urlValidation.errorCode, urlValidation.message);
    }
    
    const normalizedUrl = urlValidation.normalizedUrl;
    
    try {
      const result = await this._transport.navigate(
        normalizedUrl,
        this._config.navigationTimeoutMs,
        signal
      );
      
      this._currentUrl = result.finalUrl;
      
      const details: BrowserNavigateSuccessDetails = {
        ok: true,
        tool: 'browser_navigate',
        url: normalizedUrl,
        finalUrl: result.finalUrl,
        statusCode: result.statusCode,
        title: result.title,
      };
      
      return {
        content: [{ type: 'text', text: `Navigated to ${result.finalUrl}${result.title ? ` - ${result.title}` : ''}` }],
        details,
        metadata: {
          trust: buildTrustMetadata({
            sourceKind: 'provider_payload',
            details,
          }),
        },
      };
    } catch (error) {
      if (signal?.aborted) {
        return this._errorResult('browser_navigate', 'aborted', 'Navigation aborted');
      }
      
      // Handle various error conditions
      if (error instanceof Error) {
        if (error.message.includes('timeout')) {
          return this._errorResult('browser_navigate', 'navigation_timeout', `Navigation timed out: ${error.message}`);
        }
        if (error.message.includes('SSL') || error.message.includes('certificate')) {
          return this._errorResult('browser_navigate', 'ssl_error', `SSL error: ${error.message}`);
        }
        if (error.message.includes('redirect')) {
          return this._errorResult('browser_navigate', 'too_many_redirects', `Too many redirects: ${error.message}`);
        }
        if (error.message.includes('Forbidden') || error.message.includes('403')) {
          return this._errorResult('browser_navigate', 'forbidden', `Access forbidden: ${error.message}`);
        }
        if (error.message.includes('Unauthorized') || error.message.includes('401')) {
          return this._errorResult('browser_navigate', 'unauthorized', `Authentication required: ${error.message}`);
        }
        if (error.message.includes('Not Found') || error.message.includes('404')) {
          return this._errorResult('browser_navigate', 'not_found', `Page not found: ${error.message}`);
        }
        if (error.message.includes('500') || error.message.includes('Internal Server Error')) {
          return this._errorResult('browser_navigate', 'server_error', `Server error: ${error.message}`);
        }
      }
      
      return this._errorResult('browser_navigate', 'navigation_blocked', `Navigation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  
  async domSnapshot(
    params: BrowserDomSnapshotParams,
    signal?: AbortSignal
  ): Promise<WavemillToolResult<BrowserDomSnapshotDetails>> {
    if (this._closed) {
      return this._errorResult('browser_dom_snapshot', 'session_closed', 'Browser session is closed');
    }
    
    if (!this._currentUrl) {
      return this._errorResult('browser_dom_snapshot', 'navigation_blocked', 'No page loaded - navigate first');
    }
    
    try {
      const result = await this._transport.domSnapshot(params.selector);
      
      // Truncate if needed
      let html = result.html;
      const originalBytes = result.bytes;
      let retainedBytes = originalBytes;
      let truncated = false;
      
      if (originalBytes > this._config.domSnapshotMaxBytes) {
        html = this._truncateUtf8(html, this._config.domSnapshotMaxBytes);
        retainedBytes = Buffer.byteLength(html, 'utf8');
        truncated = true;
      }
      
      const details: BrowserDomSnapshotSuccessDetails = {
        ok: true,
        tool: 'browser_dom_snapshot',
        url: this._currentUrl,
        selector: params.selector,
        html,
        originalBytes,
        retainedBytes,
        truncated,
      };
      
      return {
        content: [{ type: 'text', text: html }],
        details,
        metadata: {
          trust: buildTrustMetadata({
            sourceKind: 'provider_payload',
            content: [{ type: 'text', text: html }],
            details,
          }),
        },
      };
    } catch (error) {
      if (signal?.aborted) {
        return this._errorResult('browser_dom_snapshot', 'aborted', 'DOM snapshot aborted');
      }
      
      return this._errorResult('browser_dom_snapshot', 'parse_error', `DOM snapshot failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  
  async a11ySnapshot(
    _params: BrowserA11ySnapshotParams,
    signal?: AbortSignal
  ): Promise<WavemillToolResult<BrowserA11ySnapshotDetails>> {
    if (this._closed) {
      return this._errorResult('browser_a11y_snapshot', 'session_closed', 'Browser session is closed');
    }
    
    if (!this._currentUrl) {
      return this._errorResult('browser_a11y_snapshot', 'navigation_blocked', 'No page loaded - navigate first');
    }
    
    try {
      const result = await this._transport.a11ySnapshot();
      
      // Convert to JSON string for consistent handling
      const jsonString = JSON.stringify(result.tree, null, 2);
      const originalBytes = result.bytes;
      let retainedBytes = originalBytes;
      let truncated = false;
      let json = jsonString;
      
      if (originalBytes > this._config.a11ySnapshotMaxBytes) {
        json = this._truncateUtf8(jsonString, this._config.a11ySnapshotMaxBytes);
        retainedBytes = Buffer.byteLength(json, 'utf8');
        truncated = true;
      }
      
      const details: BrowserA11ySnapshotSuccessDetails = {
        ok: true,
        tool: 'browser_a11y_snapshot',
        url: this._currentUrl,
        tree: JSON.parse(json),
        originalBytes,
        retainedBytes,
        truncated,
      };
      
      return {
        content: [{ type: 'text', text: json }],
        details,
        metadata: {
          trust: buildTrustMetadata({
            sourceKind: 'provider_payload',
            content: [{ type: 'text', text: json }],
            details,
          }),
        },
      };
    } catch (error) {
      if (signal?.aborted) {
        return this._errorResult('browser_a11y_snapshot', 'aborted', 'Accessibility snapshot aborted');
      }
      
      return this._errorResult('browser_a11y_snapshot', 'parse_error', `Accessibility snapshot failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  
  async consoleMessages(
    _params: BrowserConsoleMessagesParams,
    signal?: AbortSignal
  ): Promise<WavemillToolResult<BrowserConsoleMessagesDetails>> {
    if (this._closed) {
      return this._errorResult('browser_console_messages', 'session_closed', 'Browser session is closed');
    }
    
    if (!this._currentUrl) {
      return this._errorResult('browser_console_messages', 'navigation_blocked', 'No page loaded - navigate first');
    }
    
    try {
      const messages = await this._transport.consoleMessages();
      
      const originalCount = messages.length;
      let retainedMessages = messages;
      let truncated = false;
      
      if (originalCount > this._config.maxConsoleMessages) {
        retainedMessages = messages.slice(0, this._config.maxConsoleMessages);
        truncated = true;
      }
      
      // Redact secrets in console messages
      const redactedMessages = retainedMessages.map(msg => ({
        ...msg,
        text: redactSecrets(msg.text).text
      }));
      
      const details: BrowserConsoleMessagesSuccessDetails = {
        ok: true,
        tool: 'browser_console_messages',
        url: this._currentUrl,
        messages: redactedMessages,
        originalCount,
        retainedCount: retainedMessages.length,
        truncated,
      };
      
      const textContent = JSON.stringify(redactedMessages, null, 2);
      
      return {
        content: [{ type: 'text', text: textContent }],
        details,
        metadata: {
          trust: buildTrustMetadata({
            sourceKind: 'provider_payload',
            content: [{ type: 'text', text: textContent }],
            details,
          }),
        },
      };
    } catch (error) {
      if (signal?.aborted) {
        return this._errorResult('browser_console_messages', 'aborted', 'Console messages collection aborted');
      }
      
      return this._errorResult('browser_console_messages', 'internal_error', `Console messages collection failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  
  async networkRequests(
    _params: BrowserNetworkRequestsParams,
    signal?: AbortSignal
  ): Promise<WavemillToolResult<BrowserNetworkRequestsDetails>> {
    if (this._closed) {
      return this._errorResult('browser_network_requests', 'session_closed', 'Browser session is closed');
    }
    
    if (!this._currentUrl) {
      return this._errorResult('browser_network_requests', 'navigation_blocked', 'No page loaded - navigate first');
    }
    
    try {
      const requests = await this._transport.networkRequests();
      
      const originalCount = requests.length;
      let retainedRequests = requests;
      let truncated = false;
      
      if (originalCount > this._config.maxNetworkRequests) {
        retainedRequests = requests.slice(0, this._config.maxNetworkRequests);
        truncated = true;
      }
      
      // Redact secrets in request URLs
      const redactedRequests = retainedRequests.map(req => ({
        ...req,
        url: redactSecrets(req.url).text
      }));
      
      const details: BrowserNetworkRequestsSuccessDetails = {
        ok: true,
        tool: 'browser_network_requests',
        url: this._currentUrl,
        requests: redactedRequests,
        originalCount,
        retainedCount: retainedRequests.length,
        truncated,
      };
      
      const textContent = JSON.stringify(redactedRequests, null, 2);
      
      return {
        content: [{ type: 'text', text: textContent }],
        details,
        metadata: {
          trust: buildTrustMetadata({
            sourceKind: 'provider_payload',
            content: [{ type: 'text', text: textContent }],
            details,
          }),
        },
      };
    } catch (error) {
      if (signal?.aborted) {
        return this._errorResult('browser_network_requests', 'aborted', 'Network requests collection aborted');
      }
      
      return this._errorResult('browser_network_requests', 'internal_error', `Network requests collection failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  
  async close(): Promise<void> {
    if (!this._closed) {
      this._closed = true;
      try {
        await this._transport.close();
      } catch (error) {
        // Ignore errors during close
      }
    }
  }
  
  isClosed(): boolean {
    return this._closed || this._transport.isClosed();
  }
  
  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------
  
  private _validateUrl(url: string): 
    | { ok: true; normalizedUrl: string }
    | { ok: false; errorCode: BrowserToolErrorDetails['error']['code']; message: string } {
    
    if (!url || typeof url !== 'string') {
      return { 
        ok: false, 
        errorCode: 'invalid_url', 
        message: 'URL must be a non-empty string' 
      };
    }
    
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { 
        ok: false, 
        errorCode: 'malformed_url', 
        message: 'URL is malformed' 
      };
    }
    
    // Only allow http and https schemes
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { 
        ok: false, 
        errorCode: 'invalid_scheme', 
        message: 'Only http: and https: URLs are allowed' 
      };
    }
    
    // Check if origin is allowed
    const origin = `${parsed.protocol}//${parsed.host}`;
    if (!this._config.allowedOrigins.includes(origin)) {
      return { 
        ok: false, 
        errorCode: 'not_allowed_origin', 
        message: `Origin ${origin} is not in the allowed origins list` 
      };
    }
    
    return { ok: true, normalizedUrl: parsed.toString() };
  }
  
  private _errorResult(
    tool: BrowserToolErrorDetails['tool'],
    code: BrowserToolErrorDetails['error']['code'],
    message: string
  ): WavemillToolResult<BrowserToolErrorDetails> {
    return {
      content: [{ type: 'text', text: message }],
      details: {
        ok: false,
        tool,
        error: {
          code,
          message,
        },
      },
      metadata: {
        trust: buildTrustMetadata({
          sourceKind: 'provider_payload',
          details: {
            ok: false,
            tool,
            error: {
              code,
              message,
            },
          },
        }),
      },
    };
  }
  
  private _truncateUtf8(text: string, maxBytes: number): string {
    if (Buffer.byteLength(text, 'utf8') <= maxBytes) {
      return text;
    }
    
    let low = 0;
    let high = text.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (Buffer.byteLength(text.slice(0, mid), 'utf8') <= maxBytes) {
        low = mid;
      } else {
        high = mid - 1;
      }
    }
    return text.slice(0, low);
  }
}

// Configuration validation
export function validateBrowserConfig(config: unknown): ResolvedBrowserConfig {
  const defaultConfig: ResolvedBrowserConfig = {
    allowedOrigins: [],
    sessionLifetimeMs: 300000, // 5 minutes
    navigationTimeoutMs: 30000, // 30 seconds
    domSnapshotMaxBytes: 65536, // 64KB
    a11ySnapshotMaxBytes: 65536, // 64KB
    maxConsoleMessages: 100,
    maxNetworkRequests: 100,
  };
  
  if (!config || typeof config !== 'object') {
    return defaultConfig;
  }
  
  const cfg = config as Partial<ResolvedBrowserConfig>;
  
  // Validate allowed origins
  let allowedOrigins: string[] = [];
  if (Array.isArray(cfg.allowedOrigins)) {
    allowedOrigins = cfg.allowedOrigins
      .filter((origin): origin is string => typeof origin === 'string' && origin.length > 0)
      .filter((origin) => {
        try {
          const url = new URL(origin);
          return url.protocol === 'http:' || url.protocol === 'https:';
        } catch {
          return false;
        }
      });
  }
  
  return {
    allowedOrigins: Object.freeze(allowedOrigins),
    sessionLifetimeMs: Number.isInteger(cfg.sessionLifetimeMs) && cfg.sessionLifetimeMs! > 0 
      ? cfg.sessionLifetimeMs! 
      : defaultConfig.sessionLifetimeMs,
    navigationTimeoutMs: Number.isInteger(cfg.navigationTimeoutMs) && cfg.navigationTimeoutMs! > 0 
      ? cfg.navigationTimeoutMs! 
      : defaultConfig.navigationTimeoutMs,
    domSnapshotMaxBytes: Number.isInteger(cfg.domSnapshotMaxBytes) && cfg.domSnapshotMaxBytes! > 0 
      ? cfg.domSnapshotMaxBytes! 
      : defaultConfig.domSnapshotMaxBytes,
    a11ySnapshotMaxBytes: Number.isInteger(cfg.a11ySnapshotMaxBytes) && cfg.a11ySnapshotMaxBytes! > 0 
      ? cfg.a11ySnapshotMaxBytes! 
      : defaultConfig.a11ySnapshotMaxBytes,
    maxConsoleMessages: Number.isInteger(cfg.maxConsoleMessages) && cfg.maxConsoleMessages! > 0 
      ? cfg.maxConsoleMessages! 
      : defaultConfig.maxConsoleMessages,
    maxNetworkRequests: Number.isInteger(cfg.maxNetworkRequests) && cfg.maxNetworkRequests! > 0 
      ? cfg.maxNetworkRequests! 
      : defaultConfig.maxNetworkRequests,
  };
}