/**
 * Screenshot and visual comparison tools for the native review agent.
 *
 * Two tool descriptors:
 * - `browser_screenshot`: capture viewport image from browser session
 * - `screenshot_compare`: compare two stored image artifacts with pixelmatch
 */

import { createHash } from 'node:crypto';
import { buildTrustMetadata } from '../provenance.ts';
import type { ToolDescriptor, WavemillToolResult } from './types.ts';
import { storeImageArtifact } from '../image-artifacts.ts';
import { compareImageArtifacts } from '../visual-comparison.ts';
import { BrowserSession, BrowserSessionError } from '../browser-session.ts';
import { getNativeScreenshotConfig } from '../../config.ts';

export const SCREENSHOT_PATH_FIELDS: string[] = [];

/**
 * Create screenshot tool descriptors and comparison tool.
 * Requires a browser session handle for capture, which is injected from the browser tools.
 */
export function createScreenshotTools(
  sessionHandle?: () => Promise<BrowserSession | null>,
  repoDir?: string,
): { descriptors: ToolDescriptor[] } {
  const config = getNativeScreenshotConfig(repoDir);

  if (!config.enabled) {
    return { descriptors: [] };
  }

  const descriptors: ToolDescriptor[] = [];

  // ────────────────────────────────────────────────────────────────
  // browser_screenshot tool
  // ────────────────────────────────────────────────────────────────

  descriptors.push({
    metadata: {
      logicalId: 'screenshot.capture',
      name: 'browser_screenshot',
      description: 'Capture a screenshot of the current browser viewport as PNG',
      class: 'read-only', family: 'screenshot', allowedPhases: config.allowedPhases,
      exposure: 'opt-in', executionMode: 'sequential', certificationRequirement: 'read-only',
      outputCapPolicy: { strategy: 'truncate', maxBytes: 4096 },
    },
    parameters: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
    execute: async (): Promise<WavemillToolResult> => {
      if (!sessionHandle) {
        return screenshotError('browser_disabled', 'browser session not available');
      }

      const session = await sessionHandle();
      if (!session) {
        return screenshotError('browser_disabled', 'browser session not available');
      }

      try {
        const result = await session.captureScreenshot(config.limits);

        // Store the screenshot as an artifact
        const digest = createHash('sha256')
          .update(result.data)
          .digest('hex');

        const stored = storeImageArtifact(
          result.data,
          {
            mediaType: result.mediaType,
            width: result.width,
            height: result.height,
            kind: 'screenshot',
            digest,
            byteSize: result.byteSize,
            ...(result.url ? { url: result.url } : {}),
            ...(result.origin ? { origin: result.origin } : {}),
            ...(result.viewport ? { viewport: result.viewport } : {}),
            ...(result.browser ? { browser: result.browser } : {}),
            ...(result.downscaled ? {
              downscaled: result.downscaled,
              factor: result.factor,
              originalWidth: result.originalWidth,
              originalHeight: result.originalHeight,
            } : {}),
          }, repoDir,
        );
        const details = {
            ref: stored.ref,
            digest: stored.digest,
            byteSize: stored.byteSize,
            mediaType: result.mediaType,
            width: result.width,
            height: result.height,
            ...(result.url ? { url: result.url } : {}),
            ...(result.origin ? { origin: result.origin } : {}),
            ...(result.viewport ? { viewport: result.viewport } : {}),
            ...(result.browser ? { browser: result.browser } : {}),
            ...(result.downscaled ? {
              downscaled: result.downscaled,
              factor: result.factor,
              originalWidth: result.originalWidth,
              originalHeight: result.originalHeight,
            } : {}),
            limits: {
              policy: config.limits.oversizePolicy,
              maxImageBytes: config.limits.maxImageBytes,
              maxWidth: config.limits.maxWidth,
              maxHeight: config.limits.maxHeight,
            },
        };
        return screenshotSuccess(details, 'browser');
      } catch (err) {
        const error = err instanceof BrowserSessionError ? err : new Error(String(err));
        let errorCode: string;

        if (error instanceof BrowserSessionError) {
          errorCode = error.code;
        } else if (error.message.includes('screenshot')) {
          errorCode = 'screenshot_not_supported';
        } else {
          errorCode = 'adapter_error';
        }

        return screenshotError(errorCode, error.message);
      }
    },
  });

  // ────────────────────────────────────────────────────────────────
  // screenshot_compare tool
  // ────────────────────────────────────────────────────────────────

  descriptors.push({
    metadata: {
      logicalId: 'screenshot.compare', name: 'screenshot_compare',
      description: 'Compare two screenshot artifacts using pixel-level diff detection',
      class: 'read-only', family: 'screenshot', allowedPhases: config.allowedPhases,
      exposure: 'opt-in', executionMode: 'sequential', certificationRequirement: 'read-only',
      outputCapPolicy: { strategy: 'truncate', maxBytes: 4096 },
    },
    parameters: {
      type: 'object',
      properties: {
        baselineRef: {
          type: 'string',
          description: 'Baseline image artifact ref (artifact://...)',
        },
        currentRef: {
          type: 'string',
          description: 'Current image artifact ref (artifact://...)',
        },
      },
      required: ['baselineRef', 'currentRef'],
      additionalProperties: false,
    },
    execute: async (_id, params: { baselineRef: string; currentRef: string }): Promise<WavemillToolResult> => {
      try {
        const result = await compareImageArtifacts({
          baselineRef: params.baselineRef,
          currentRef: params.currentRef,
          repoDir,
          options: {
            diffThreshold: config.limits.diffThreshold,
            maxComparePixels: config.limits.maxComparePixels,
            emitDiffImage: true,
          },
        });

        if (!result.comparable) {
          return screenshotSuccess({
              comparable: false,
              reason: result.reason,
              error: result.error,
              ...(result.baseline ? { baseline: result.baseline } : {}),
              ...(result.current ? { current: result.current } : {}),
          }, 'wavemill_artifact');
        }

        return screenshotSuccess({
            comparable: true,
            width: result.width,
            height: result.height,
            totalPixels: result.totalPixels,
            diffPixels: result.diffPixels,
            diffRatio: result.diffRatio,
            threshold: result.threshold,
            ...(result.diffRef ? { diffRef: result.diffRef } : {}),
        }, 'wavemill_artifact');
      } catch (err) {
        return screenshotError('comparison_error', String(err));
      }
    },
  });

  return { descriptors };
}

function screenshotSuccess(details: Record<string, unknown>, sourceKind: 'browser' | 'wavemill_artifact'): WavemillToolResult {
  const text = JSON.stringify(details);
  return { content: [{ type: 'text', text }], details, metadata: { trust: buildTrustMetadata({ sourceKind, content: [{ type: 'text', text }], details }) } };
}

function screenshotError(error: string, message: string): WavemillToolResult {
  const details = { error, message };
  return { content: [{ type: 'text', text: JSON.stringify(details) }], details, metadata: { trust: buildTrustMetadata({ sourceKind: 'browser', details }) } };
}
