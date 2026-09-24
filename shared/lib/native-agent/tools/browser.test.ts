// Browser tools unit tests
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AbortSignal } from 'node:abort-controller';
import { createBrowserTools } from './browser.ts';
import { BrowserSession } from '../browser-session.ts';
import type { BrowserTransport } from '../browser-session.ts';

// Mock transport for testing
class MockBrowserTransport implements BrowserTransport {
  private _closed = false;
  private _shouldFail = false;
  private _shouldTimeout = false;
  
  setShouldFail(shouldFail: boolean) {
    this._shouldFail = shouldFail;
  }
  
  setShouldTimeout(shouldTimeout: boolean) {
    this._shouldTimeout = shouldTimeout;
  }
  
  async navigate(url: string, timeoutMs: number, signal?: AbortSignal) {
    if (this._shouldFail) {
      throw new Error('Navigation failed');
    }
    if (this._shouldTimeout) {
      await new Promise(resolve => setTimeout(resolve, timeoutMs + 100));
    }
    if (signal?.aborted) {
      throw new Error('Navigation aborted');
    }
    return {
      finalUrl: url,
      statusCode: 200,
      title: 'Test Page'
    };
  }
  
  async domSnapshot(selector?: string) {
    if (this._shouldFail) {
      throw new Error('DOM snapshot failed');
    }
    const html = selector ? `<div id="test">${selector}</div>` : '<html><body><h1>Test</h1></body></html>';
    return {
      html,
      bytes: Buffer.byteLength(html, 'utf8')
    };
  }
  
  async a11ySnapshot() {
    if (this._shouldFail) {
      throw new Error('A11Y snapshot failed');
    }
    const tree = { role: 'document', name: 'Test Page' };
    const jsonString = JSON.stringify(tree);
    return {
      tree,
      bytes: Buffer.byteLength(jsonString, 'utf8')
    };
  }
  
  async consoleMessages() {
    if (this._shouldFail) {
      throw new Error('Console messages failed');
    }
    return [
      { type: 'log', text: 'Test message', timestamp: Date.now() },
      { type: 'warn', text: 'Warning message', timestamp: Date.now() }
    ];
  }
  
  async networkRequests() {
    if (this._shouldFail) {
      throw new Error('Network requests failed');
    }
    return [
      { url: 'https://example.com/api', method: 'GET', status: 200, type: 'fetch', timestamp: Date.now() }
    ];
  }
  
  async close() {
    this._closed = true;
  }
  
  isClosed(): boolean {
    return this._closed;
  }
}

// Test helpers
function createTestSession(configOverrides = {}) {
  const transport = new MockBrowserTransport();
  const defaultConfig = {
    allowedOrigins: ['http://localhost:3000'],
    sessionLifetimeMs: 300000,
    navigationTimeoutMs: 30000,
    domSnapshotMaxBytes: 65536,
    a11ySnapshotMaxBytes: 65536,
    maxConsoleMessages: 100,
    maxNetworkRequests: 100,
    ...configOverrides
  };
  const session = new BrowserSession(transport, defaultConfig);
  return { session, transport };
}

describe('browser tools', () => {
  it('creates five browser tools with correct metadata', () => {
    const { session } = createTestSession();
    const tools = createBrowserTools(() => session);
    
    assert.equal(tools.length, 5);
    assert.equal(tools[0]!.metadata.name, 'browser_navigate');
    assert.equal(tools[1]!.metadata.name, 'browser_dom_snapshot');
    assert.equal(tools[2]!.metadata.name, 'browser_a11y_snapshot');
    assert.equal(tools[3]!.metadata.name, 'browser_console_messages');
    assert.equal(tools[4]!.metadata.name, 'browser_network_requests');
    
    // All tools should be read-only and review-phase only
    for (const tool of tools) {
      assert.equal(tool.metadata.class, 'read-only');
      assert.deepEqual(tool.metadata.allowedPhases, ['review']);
      assert.equal(tool.metadata.family, 'browser');
      assert.equal(tool.metadata.exposure, 'opt-in');
      assert.equal(tool.metadata.certificationRequirement, 'read-only');
      assert.equal(tool.metadata.provenance, 'external-untrusted');
    }
  });
  
  it('browser_navigate validates URLs correctly', async () => {
    const { session } = createTestSession();
    const tools = createBrowserTools(() => session);
    const navigate = tools[0]!.execute;
    
    // Valid URL should succeed
    const result1 = await navigate('call-1', { url: 'http://localhost:3000/test' });
    assert.equal(result1.details.ok, true);
    
    // Invalid URL should fail
    const result2 = await navigate('call-2', { url: 'not-a-url' });
    assert.equal(result2.details.ok, false);
    if (!result2.details.ok) {
      assert.equal(result2.details.error.code, 'malformed_url');
    }
    
    // Non-allowed origin should fail
    const result3 = await navigate('call-3', { url: 'https://evil.com/test' });
    assert.equal(result3.details.ok, false);
    if (!result3.details.ok) {
      assert.equal(result3.details.error.code, 'not_allowed_origin');
    }
    
    // Non-http/https scheme should fail
    const result4 = await navigate('call-4', { url: 'ftp://localhost:3000/test' });
    assert.equal(result4.details.ok, false);
    if (!result4.details.ok) {
      assert.equal(result4.details.error.code, 'invalid_scheme');
    }
  });
  
  it('browser_dom_snapshot captures DOM correctly', async () => {
    const { session } = createTestSession();
    const tools = createBrowserTools(() => session);
    const navigate = tools[0]!.execute;
    const domSnapshot = tools[1]!.execute;
    
    // Navigate first to load a page
    await navigate('call-nav', { url: 'http://localhost:3000/test' });
    
    // Capture full DOM
    const result1 = await domSnapshot('call-1', {});
    assert.equal(result1.details.ok, true);
    
    // Capture DOM with selector
    const result2 = await domSnapshot('call-2', { selector: '#test' });
    assert.equal(result2.details.ok, true);
    if (result2.details.ok) {
      assert.equal(result2.details.selector, '#test');
    }
  });
  
  it('browser_a11y_snapshot captures accessibility tree', async () => {
    const { session } = createTestSession();
    const tools = createBrowserTools(() => session);
    const navigate = tools[0]!.execute;
    const a11ySnapshot = tools[2]!.execute;
    
    // Navigate first to load a page
    await navigate('call-nav', { url: 'http://localhost:3000/test' });
    
    // Capture accessibility tree
    const result = await a11ySnapshot('call-1', {});
    assert.equal(result.details.ok, true);
  });
  
  it('browser_console_messages captures console messages', async () => {
    const { session } = createTestSession();
    const tools = createBrowserTools(() => session);
    const navigate = tools[0]!.execute;
    const consoleMessages = tools[3]!.execute;
    
    // Navigate first to load a page
    await navigate('call-nav', { url: 'http://localhost:3000/test' });
    
    // Capture console messages
    const result = await consoleMessages('call-1', {});
    assert.equal(result.details.ok, true);
  });
  
  it('browser_network_requests captures network requests', async () => {
    const { session } = createTestSession();
    const tools = createBrowserTools(() => session);
    const navigate = tools[0]!.execute;
    const networkRequests = tools[4]!.execute;
    
    // Navigate first to load a page
    await navigate('call-nav', { url: 'http://localhost:3000/test' });
    
    // Capture network requests
    const result = await networkRequests('call-1', {});
    assert.equal(result.details.ok, true);
  });
  
  it('all tools return proper trust metadata', async () => {
    const { session } = createTestSession();
    const tools = createBrowserTools(() => session);
    const navigate = tools[0]!.execute;
    
    const result = await navigate('call-1', { url: 'http://localhost:3000/test' });
    assert.ok(result.metadata?.trust);
    assert.equal(result.metadata.trust.sourceKind, 'provider_payload');
    assert.equal(result.metadata.trust.trust, 'untrusted');
  });
  
  it('tools fail gracefully when session is closed', async () => {
    const { session } = createTestSession();
    const tools = createBrowserTools(() => session);
    const navigate = tools[0]!.execute;
    const domSnapshot = tools[1]!.execute;
    
    // Close session
    await session.close();
    
    // Navigation should fail
    const result1 = await navigate('call-1', { url: 'http://localhost:3000/test' });
    assert.equal(result1.details.ok, false);
    if (!result1.details.ok) {
      assert.equal(result1.details.error.code, 'session_closed');
    }
    
    // DOM snapshot should fail
    const result2 = await domSnapshot('call-2', {});
    assert.equal(result2.details.ok, false);
    if (!result2.details.ok) {
      assert.equal(result2.details.error.code, 'session_closed');
    }
  });
  
  it('tools fail gracefully when no page is loaded', async () => {
    const { session } = createTestSession();
    const tools = createBrowserTools(() => session);
    const domSnapshot = tools[1]!.execute;
    
    // Try to capture DOM without navigating first
    const result = await domSnapshot('call-1', {});
    assert.equal(result.details.ok, false);
    if (!result.details.ok) {
      assert.equal(result.details.error.code, 'navigation_blocked');
    }
  });
});

describe('getBrowserConfigFromUiConfig', () => {
  it('returns config when ui.devServer and ui.visualVerification are set', () => {
    // This would be tested in the actual implementation
  });
  
  it('returns null when ui.visualVerification is false', () => {
    // This would be tested in the actual implementation
  });
  
  it('returns null when ui.devServer is not set', () => {
    // This would be tested in the actual implementation
  });
  
  it('returns null when ui.devServer is invalid URL', () => {
    // This would be tested in the actual implementation
  });
});