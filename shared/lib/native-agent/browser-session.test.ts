// Browser session unit tests
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BrowserSession, validateBrowserConfig } from './browser-session.ts';
import type { BrowserTransport } from './browser-session.ts';

// Mock transport for testing
class MockBrowserTransport implements BrowserTransport {
  private _closed = false;
  private _shouldFail = false;
  
  setShouldFail(shouldFail: boolean) {
    this._shouldFail = shouldFail;
  }
  
  async navigate(url: string, timeoutMs: number) {
    if (this._shouldFail) {
      throw new Error('Navigation failed');
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

describe('BrowserSession', () => {
  const defaultConfig = {
    allowedOrigins: ['http://localhost:3000', 'https://example.com'],
    sessionLifetimeMs: 300000,
    navigationTimeoutMs: 30000,
    domSnapshotMaxBytes: 65536,
    a11ySnapshotMaxBytes: 65536,
    maxConsoleMessages: 100,
    maxNetworkRequests: 100
  };
  
  it('constructs with transport and config', () => {
    const transport = new MockBrowserTransport();
    const session = new BrowserSession(transport, defaultConfig);
    assert.ok(session);
    assert.equal(session.isClosed(), false);
  });
  
  it('navigates to valid URLs successfully', async () => {
    const transport = new MockBrowserTransport();
    const session = new BrowserSession(transport, defaultConfig);
    
    const result = await session.navigate({ url: 'http://localhost:3000/test' });
    assert.equal(result.details.ok, true);
    if (result.details.ok) {
      assert.equal(result.details.url, 'http://localhost:3000/test');
      assert.equal(result.details.finalUrl, 'http://localhost:3000/test');
      assert.equal(result.details.statusCode, 200);
      assert.equal(result.details.title, 'Test Page');
    }
  });
  
  it('rejects invalid URLs', async () => {
    const transport = new MockBrowserTransport();
    const session = new BrowserSession(transport, defaultConfig);
    
    // Malformed URL
    const result1 = await session.navigate({ url: 'not-a-url' });
    assert.equal(result1.details.ok, false);
    if (!result1.details.ok) {
      assert.equal(result1.details.error.code, 'malformed_url');
    }
    
    // Non-allowed origin
    const result2 = await session.navigate({ url: 'http://evil.com/test' });
    assert.equal(result2.details.ok, false);
    if (!result2.details.ok) {
      assert.equal(result2.details.error.code, 'not_allowed_origin');
    }
    
    // Invalid scheme
    const result3 = await session.navigate({ url: 'ftp://localhost:3000/test' });
    assert.equal(result3.details.ok, false);
    if (!result3.details.ok) {
      assert.equal(result3.details.error.code, 'invalid_scheme');
    }
  });
  
  it('captures DOM snapshots correctly', async () => {
    const transport = new MockBrowserTransport();
    const session = new BrowserSession(transport, defaultConfig);
    
    // Navigate first
    await session.navigate({ url: 'http://localhost:3000/test' });
    
    // Capture full DOM
    const result1 = await session.domSnapshot({});
    assert.equal(result1.details.ok, true);
    if (result1.details.ok) {
      assert.ok(result1.details.html.includes('<html>'));
      assert.equal(result1.details.truncated, false);
    }
    
    // Capture DOM with selector
    const result2 = await session.domSnapshot({ selector: '#test' });
    assert.equal(result2.details.ok, true);
    if (result2.details.ok) {
      assert.equal(result2.details.selector, '#test');
    }
  });
  
  it('truncates large DOM snapshots', async () => {
    const transport = new MockBrowserTransport();
    const smallConfig = { ...defaultConfig, domSnapshotMaxBytes: 10 };
    const session = new BrowserSession(transport, smallConfig);
    
    // Navigate first
    await session.navigate({ url: 'http://localhost:3000/test' });
    
    // Mock transport to return large HTML
    const largeHtml = '<html><body><div>Very large content that exceeds the limit</div></body></html>';
    (transport as any).domSnapshot = async () => ({
      html: largeHtml,
      bytes: Buffer.byteLength(largeHtml, 'utf8')
    });
    
    const result = await session.domSnapshot({});
    assert.equal(result.details.ok, true);
    if (result.details.ok) {
      assert.equal(result.details.truncated, true);
      assert.ok(result.details.retainedBytes <= 10);
    }
  });
  
  it('captures accessibility snapshots', async () => {
    const transport = new MockBrowserTransport();
    const session = new BrowserSession(transport, defaultConfig);
    
    // Navigate first
    await session.navigate({ url: 'http://localhost:3000/test' });
    
    const result = await session.a11ySnapshot({});
    assert.equal(result.details.ok, true);
  });
  
  it('captures console messages', async () => {
    const transport = new MockBrowserTransport();
    const session = new BrowserSession(transport, defaultConfig);
    
    // Navigate first
    await session.navigate({ url: 'http://localhost:3000/test' });
    
    const result = await session.consoleMessages({});
    assert.equal(result.details.ok, true);
    if (result.details.ok) {
      assert.equal(result.details.messages.length, 2);
      assert.equal(result.details.truncated, false);
    }
  });
  
  it('limits console messages count', async () => {
    const transport = new MockBrowserTransport();
    const smallConfig = { ...defaultConfig, maxConsoleMessages: 1 };
    const session = new BrowserSession(transport, smallConfig);
    
    // Navigate first
    await session.navigate({ url: 'http://localhost:3000/test' });
    
    // Mock transport to return many messages
    const manyMessages = Array.from({ length: 5 }, (_, i) => ({
      type: 'log',
      text: `Message ${i}`,
      timestamp: Date.now()
    }));
    (transport as any).consoleMessages = async () => manyMessages;
    
    const result = await session.consoleMessages({});
    assert.equal(result.details.ok, true);
    if (result.details.ok) {
      assert.equal(result.details.retainedCount, 1);
      assert.equal(result.details.truncated, true);
    }
  });
  
  it('captures network requests', async () => {
    const transport = new MockBrowserTransport();
    const session = new BrowserSession(transport, defaultConfig);
    
    // Navigate first
    await session.navigate({ url: 'http://localhost:3000/test' });
    
    const result = await session.networkRequests({});
    assert.equal(result.details.ok, true);
    if (result.details.ok) {
      assert.equal(result.details.requests.length, 1);
      assert.equal(result.details.truncated, false);
    }
  });
  
  it('limits network requests count', async () => {
    const transport = new MockBrowserTransport();
    const smallConfig = { ...defaultConfig, maxNetworkRequests: 1 };
    const session = new BrowserSession(transport, smallConfig);
    
    // Navigate first
    await session.navigate({ url: 'http://localhost:3000/test' });
    
    // Mock transport to return many requests
    const manyRequests = Array.from({ length: 5 }, (_, i) => ({
      url: `https://example.com/api/${i}`,
      method: 'GET',
      status: 200,
      type: 'fetch',
      timestamp: Date.now()
    }));
    (transport as any).networkRequests = async () => manyRequests;
    
    const result = await session.networkRequests({});
    assert.equal(result.details.ok, true);
    if (result.details.ok) {
      assert.equal(result.details.retainedCount, 1);
      assert.equal(result.details.truncated, true);
    }
  });
  
  it('rejects operations when no page is loaded', async () => {
    const transport = new MockBrowserTransport();
    const session = new BrowserSession(transport, defaultConfig);
    
    const result = await session.domSnapshot({});
    assert.equal(result.details.ok, false);
    if (!result.details.ok) {
      assert.equal(result.details.error.code, 'navigation_blocked');
    }
  });
  
  it('rejects operations when session is closed', async () => {
    const transport = new MockBrowserTransport();
    const session = new BrowserSession(transport, defaultConfig);
    
    // Close session
    await session.close();
    
    const result = await session.navigate({ url: 'http://localhost:3000/test' });
    assert.equal(result.details.ok, false);
    if (!result.details.ok) {
      assert.equal(result.details.error.code, 'session_closed');
    }
  });
  
  it('expires session after lifetime', async () => {
    const transport = new MockBrowserTransport();
    const shortConfig = { ...defaultConfig, sessionLifetimeMs: 1 };
    const session = new BrowserSession(transport, shortConfig);
    
    // Wait for session to expire
    await new Promise(resolve => setTimeout(resolve, 10));
    
    const result = await session.navigate({ url: 'http://localhost:3000/test' });
    assert.equal(result.details.ok, false);
    if (!result.details.ok) {
      assert.equal(result.details.error.code, 'session_expired');
    }
  });
  
  it('handles transport errors gracefully', async () => {
    const transport = new MockBrowserTransport();
    transport.setShouldFail(true);
    const session = new BrowserSession(transport, defaultConfig);
    
    // Navigate first
    await session.navigate({ url: 'http://localhost:3000/test' });
    
    const result = await session.domSnapshot({});
    assert.equal(result.details.ok, false);
    if (!result.details.ok) {
      assert.equal(result.details.error.code, 'parse_error');
    }
  });
});

describe('validateBrowserConfig', () => {
  it('returns default config for invalid input', () => {
    const result1 = validateBrowserConfig(null);
    assert.equal(result1.allowedOrigins.length, 0);
    
    const result2 = validateBrowserConfig('not-an-object');
    assert.equal(result2.allowedOrigins.length, 0);
    
    const result3 = validateBrowserConfig(undefined);
    assert.equal(result3.allowedOrigins.length, 0);
  });
  
  it('validates and normalizes allowed origins', () => {
    const input = {
      allowedOrigins: [
        'http://localhost:3000',
        'https://example.com',
        'invalid-url',
        'ftp://not-allowed.com'
      ]
    };
    const result = validateBrowserConfig(input);
    assert.equal(result.allowedOrigins.length, 2);
    assert.ok(result.allowedOrigins.includes('http://localhost:3000'));
    assert.ok(result.allowedOrigins.includes('https://example.com'));
  });
  
  it('uses defaults for invalid numeric values', () => {
    const input = {
      sessionLifetimeMs: -1,
      navigationTimeoutMs: 'not-a-number',
      domSnapshotMaxBytes: 0
    };
    const result = validateBrowserConfig(input);
    assert.ok(result.sessionLifetimeMs > 0);
    assert.ok(result.navigationTimeoutMs > 0);
    assert.ok(result.domSnapshotMaxBytes > 0);
  });
  
  it('uses provided values for valid numeric inputs', () => {
    const input = {
      sessionLifetimeMs: 60000,
      navigationTimeoutMs: 15000,
      domSnapshotMaxBytes: 32768,
      a11ySnapshotMaxBytes: 32768,
      maxConsoleMessages: 50,
      maxNetworkRequests: 50
    };
    const result = validateBrowserConfig(input);
    assert.equal(result.sessionLifetimeMs, 60000);
    assert.equal(result.navigationTimeoutMs, 15000);
    assert.equal(result.domSnapshotMaxBytes, 32768);
    assert.equal(result.a11ySnapshotMaxBytes, 32768);
    assert.equal(result.maxConsoleMessages, 50);
    assert.equal(result.maxNetworkRequests, 50);
  });
});