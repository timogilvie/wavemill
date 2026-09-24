/**
 * Screenshot and visual comparison tools for the native review agent.
 *
 * Two tool descriptors:
 * - `browser_screenshot`: capture viewport image from browser session
 * - `screenshot_compare`: compare two stored image artifacts with pixelmatch
 */

import { createHash } from 'node:crypto';
import { NativeToolDescriptor, NativeToolFamilyConfig } from './types.ts';
import { storeImageArtifact, loadImageArtifact } from '../image-artifacts.ts';
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
): { descriptors: NativeToolDescriptor[] } {
  const config = getNativeScreenshotConfig();

  if (!config.enabled) {
    return { descriptors: [] };
  }

  const descriptors: NativeToolDescriptor[] = [];

  // ────────────────────────────────────────────────────────────────
  // browser_screenshot tool
  // ────────────────────────────────────────────────────────────────

  descriptors.push({
    logicalId: 'screenshot.capture',
    name: 'browser_screenshot',
    description: 'Capture a screenshot of the current browser viewport as PNG',
    class: 'read-only',
    family: 'screenshot',
    allowedPhases: config.allowedPhases,
    exposure: 'opt-in',
    executionMode: 'sequential',
    certificationRequirement: 'read-only',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
    outputCapPolicy: {
      strategy: 'truncate',
      maxBytes: 4096,
    },
    invoke: async () => {
      if (!sessionHandle) {
        return {
          success: false,
          errorCode: 'browser_disabled',
          details: { reason: 'browser session not available' },
        };
      }

      const session = await sessionHandle();
      if (!session) {
        return {
          success: false,
          errorCode: 'browser_disabled',
          details: { reason: 'browser session not available' },
        };
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
            ...(result.viewport ? { viewport: result.viewport } : {}),
            ...(result.browser ? { browser: result.browser } : {}),
            ...(result.downscaled ? {
              downscaled: result.downscaled,
              factor: result.factor,
              originalWidth: result.originalWidth,
              originalHeight: result.originalHeight,
            } : {}),
          },
        );

        return {
          success: true,
          details: {
            ref: stored.ref,
            digest: stored.digest,
            byteSize: stored.byteSize,
            mediaType: result.mediaType,
            width: result.width,
            height: result.height,
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
          },
          sourceKind: 'browser',
        };
      } catch (err) {
        const error = err instanceof BrowserSessionError ? err : new Error(String(err));
        let errorCode: string;
        let detail: Record<string, unknown> = {};

        if (error instanceof BrowserSessionError) {
          errorCode = error.code;
        } else if (error.message.includes('screenshot')) {
          errorCode = 'screenshot_not_supported';
        } else {
          errorCode = 'adapter_error';
        }

        return {
          success: false,
          errorCode,
          details: detail,
        };
      }
    },
  });

  // ────────────────────────────────────────────────────────────────
  // screenshot_compare tool
  // ────────────────────────────────────────────────────────────────

  descriptors.push({
    logicalId: 'screenshot.compare',
    name: 'screenshot_compare',
    description: 'Compare two screenshot artifacts using pixel-level diff detection',
    class: 'read-only',
    family: 'screenshot',
    allowedPhases: config.allowedPhases,
    exposure: 'opt-in',
    executionMode: 'sequential',
    certificationRequirement: 'read-only',
    inputSchema: {
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
    outputCapPolicy: {
      strategy: 'truncate',
      maxBytes: 4096,
    },
    invoke: async (params: { baselineRef: string; currentRef: string }) => {
      try {
        const result = await compareImageArtifacts({
          baselineRef: params.baselineRef,
          currentRef: params.currentRef,
          options: {
            diffThreshold: config.limits.diffThreshold,
            maxComparePixels: config.limits.maxComparePixels,
            emitDiffImage: true,
          },
        });

        if (!result.comparable) {
          return {
            success: true,
            details: {
              comparable: false,
              reason: result.reason,
              error: result.error,
              ...(result.baseline ? { baseline: result.baseline } : {}),
              ...(result.current ? { current: result.current } : {}),
            },
            sourceKind: 'wavemill_artifact',
          };
        }

        return {
          success: true,
          details: {
            comparable: true,
            width: result.width,
            height: result.height,
            totalPixels: result.totalPixels,
            diffPixels: result.diffPixels,
            diffRatio: result.diffRatio,
            threshold: result.threshold,
            ...(result.diffRef ? { diffRef: result.diffRef } : {}),
          },
          sourceKind: 'wavemill_artifact',
        };
      } catch (err) {
        return {
          success: false,
          errorCode: 'comparison_error',
          details: { error: String(err) },
        };
      }
    },
  });

  return { descriptors };
}
