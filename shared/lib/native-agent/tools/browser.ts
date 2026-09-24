// Browser tools for read-only inspection
import type { ToolDescriptor } from './types.ts';
import { buildTrustMetadata } from '../provenance.ts';
import { BrowserSession } from '../browser-session.ts';
import type { WavemillConfig } from '../../config.ts';

// Tool parameter interfaces
export interface BrowserNavigateParams {
  url: string;
}

export interface BrowserDomSnapshotParams {
  selector?: string;
}

export interface BrowserA11ySnapshotParams {}

export interface BrowserConsoleMessagesParams {}

export interface BrowserNetworkRequestsParams {}

// Tool result interfaces
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

export type BrowserNavigateDetails = BrowserNavigateSuccessDetails | BrowserToolErrorDetails;
export type BrowserDomSnapshotDetails = BrowserDomSnapshotSuccessDetails | BrowserToolErrorDetails;
export type BrowserA11ySnapshotDetails = BrowserA11ySnapshotSuccessDetails | BrowserToolErrorDetails;
export type BrowserConsoleMessagesDetails = BrowserConsoleMessagesSuccessDetails | BrowserToolErrorDetails;
export type BrowserNetworkRequestsDetails = BrowserNetworkRequestsSuccessDetails | BrowserToolErrorDetails;

type BrowserToolDetails = BrowserNavigateDetails | BrowserDomSnapshotDetails | BrowserA11ySnapshotDetails | BrowserConsoleMessagesDetails | BrowserNetworkRequestsDetails;

// Browser tool factory function
export function createBrowserTools(
  getSession: () => BrowserSession
): ToolDescriptor[] {
  return [
    {
      metadata: {
        name: 'browser_navigate',
        description: 'Navigate to a URL within the allowed origins. Returns page metadata and loads the page for subsequent inspection.',
        class: 'read-only',
        allowedPhases: ['review'],
        executionMode: 'sequential',
        outputCapPolicy: { strategy: 'none' },
        family: 'browser',
        logicalId: 'browser.navigate',
        exposure: 'opt-in',
        certificationRequirement: 'read-only',
        provenance: 'external-untrusted',
      },
      parameters: {
        type: 'object',
        required: ['url'],
        properties: {
          url: { 
            type: 'string', 
            description: 'Absolute URL to navigate to (must be in allowed origins)' 
          },
        },
        additionalProperties: false,
      },
      async execute(_toolCallId, params, signal) {
        return getSession().navigate(params as BrowserNavigateParams, signal);
      },
    } as ToolDescriptor<BrowserNavigateParams, BrowserNavigateDetails>,
    
    {
      metadata: {
        name: 'browser_dom_snapshot',
        description: 'Capture a DOM snapshot of the current page. Supports CSS selector filtering.',
        class: 'read-only',
        allowedPhases: ['review'],
        executionMode: 'parallel',
        outputCapPolicy: { strategy: 'truncate', maxBytes: 65536 },
        family: 'browser',
        logicalId: 'browser.dom_snapshot',
        exposure: 'opt-in',
        certificationRequirement: 'read-only',
        provenance: 'external-untrusted',
      },
      parameters: {
        type: 'object',
        properties: {
          selector: { 
            type: 'string', 
            description: 'CSS selector to limit snapshot to specific elements' 
          },
        },
        additionalProperties: false,
      },
      async execute(_toolCallId, params, signal) {
        return getSession().domSnapshot(params as BrowserDomSnapshotParams, signal);
      },
    } as ToolDescriptor<BrowserDomSnapshotParams, BrowserDomSnapshotDetails>,
    
    {
      metadata: {
        name: 'browser_a11y_snapshot',
        description: 'Capture an accessibility tree snapshot of the current page.',
        class: 'read-only',
        allowedPhases: ['review'],
        executionMode: 'parallel',
        outputCapPolicy: { strategy: 'truncate', maxBytes: 65536 },
        family: 'browser',
        logicalId: 'browser.a11y_snapshot',
        exposure: 'opt-in',
        certificationRequirement: 'read-only',
        provenance: 'external-untrusted',
      },
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      async execute(_toolCallId, params, signal) {
        return getSession().a11ySnapshot(params as BrowserA11ySnapshotParams, signal);
      },
    } as ToolDescriptor<BrowserA11ySnapshotParams, BrowserA11ySnapshotDetails>,
    
    {
      metadata: {
        name: 'browser_console_messages',
        description: 'Retrieve captured console messages from the current page.',
        class: 'read-only',
        allowedPhases: ['review'],
        executionMode: 'parallel',
        outputCapPolicy: { strategy: 'truncate', maxItems: 100 },
        family: 'browser',
        logicalId: 'browser.console_messages',
        exposure: 'opt-in',
        certificationRequirement: 'read-only',
        provenance: 'external-untrusted',
      },
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      async execute(_toolCallId, params, signal) {
        return getSession().consoleMessages(params as BrowserConsoleMessagesParams, signal);
      },
    } as ToolDescriptor<BrowserConsoleMessagesParams, BrowserConsoleMessagesDetails>,
    
    {
      metadata: {
        name: 'browser_network_requests',
        description: 'Retrieve captured network requests from the current page.',
        class: 'read-only',
        allowedPhases: ['review'],
        executionMode: 'parallel',
        outputCapPolicy: { strategy: 'truncate', maxItems: 100 },
        family: 'browser',
        logicalId: 'browser.network_requests',
        exposure: 'opt-in',
        certificationRequirement: 'read-only',
        provenance: 'external-untrusted',
      },
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      async execute(_toolCallId, params, signal) {
        return getSession().networkRequests(params as BrowserNetworkRequestsParams, signal);
      },
    } as ToolDescriptor<BrowserNetworkRequestsParams, BrowserNetworkRequestsDetails>,
  ];
}

// Helper function to get browser configuration from UI config
export function getBrowserConfigFromUiConfig(uiConfig: { 
  devServer?: string; 
  visualVerification?: boolean 
}): { allowedOrigins: string[] } | null {
  
  // Require visual verification to be enabled
  if (!uiConfig.visualVerification) {
    return null;
  }
  
  // Require devServer to be configured
  if (!uiConfig.devServer || typeof uiConfig.devServer !== 'string') {
    return null;
  }
  
  let devServerOrigin: string;
  try {
    const url = new URL(uiConfig.devServer);
    devServerOrigin = `${url.protocol}//${url.host}`;
  } catch {
    return null; // Invalid devServer URL
  }
  
  return {
    allowedOrigins: [devServerOrigin],
  };
}