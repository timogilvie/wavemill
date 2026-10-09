import type {
  ModelFamily,
  NormalizedCatalogEntry,
} from './openrouter-catalog.ts';
import { hashLaunchPriorityFixture, hashLaunchPriorityModelRow } from './openrouter-catalog.ts';
import {
  dispatchOpenRouterRequest,
  type BlockerCategory,
  type OpenRouterTransport,
} from './openrouter-runtime.ts';

export interface SmokeReport {
  modelId: string;
  family: ModelFamily;
  status: 'ok' | 'blocker';
  requestedWireId: string;
  catalogHash: string;
  checkedAt: string;
  providerReturnedModel?: string;
  category?: BlockerCategory;
  detail?: string;
  costUsd?: number | null;
}

export async function runOpenRouterSmoke(opts: {
  entries: NormalizedCatalogEntry[];
  transport?: OpenRouterTransport;
  apiKey?: string;
  prompt?: string;
  baseUrl?: string;
  now?: () => Date;
  catalogHash?: string;
}): Promise<SmokeReport[]> {
  if (opts.entries.length === 0) {
    return [];
  }

  const now = opts.now ?? (() => new Date());
  // Per-model catalog hash (HOK-3159), matching `CertificationSubject.catalogHash`
  // for the same row. A caller-supplied hash wins; an entry without a fixture
  // row falls back to the whole-file hash so the report is never hash-less.
  let wholeFileHash: string | undefined;
  const catalogHashFor = (entry: NormalizedCatalogEntry): string => opts.catalogHash
    ?? hashLaunchPriorityModelRow(entry.wavemillAlias)
    ?? hashLaunchPriorityModelRow(entry.openrouterId)
    ?? (wholeFileHash ??= hashLaunchPriorityFixture());

  if (!opts.transport && (!opts.apiKey || opts.apiKey.trim().length === 0)) {
    return opts.entries.map((entry) => ({
      modelId: entry.wavemillAlias,
      family: entry.family,
      status: 'blocker',
      requestedWireId: entry.openrouterId,
      catalogHash: catalogHashFor(entry),
      checkedAt: now().toISOString(),
      category: 'provider_unavailable',
      detail: 'OpenRouter API key is required for live smoke runs.',
    }));
  }

  const prompt = opts.prompt ?? 'ping';
  const apiKey = opts.apiKey?.trim() || 'mock-openrouter-key';
  const reports: SmokeReport[] = [];

  for (const entry of opts.entries) {
    try {
      const result = await dispatchOpenRouterRequest(
        {
          modelId: entry.wavemillAlias,
          messages: [{ role: 'user', content: prompt }],
          maxOutputTokens: 256,
        },
        entry,
        {
          apiKey,
          baseUrl: opts.baseUrl,
          transport: opts.transport,
        },
      );

      if (result.status === 'ok') {
        reports.push({
          modelId: result.modelId,
          family: entry.family,
          status: 'ok',
          requestedWireId: entry.openrouterId,
          providerReturnedModel: extractReturnedModel(result.raw),
          catalogHash: catalogHashFor(entry),
          checkedAt: now().toISOString(),
          costUsd: result.costUsd,
        });
        continue;
      }

      reports.push({
        modelId: result.modelId,
        family: entry.family,
        status: 'blocker',
        requestedWireId: entry.openrouterId,
        catalogHash: catalogHashFor(entry),
        checkedAt: now().toISOString(),
        category: result.category,
        detail: result.detail,
      });
    } catch (error) {
      reports.push({
        modelId: entry.wavemillAlias,
        family: entry.family,
        status: 'blocker',
        requestedWireId: entry.openrouterId,
        catalogHash: catalogHashFor(entry),
        checkedAt: now().toISOString(),
        category: 'provider_unavailable',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return reports;
}

function extractReturnedModel(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const model = (raw as Record<string, unknown>).model;
  return typeof model === 'string' && model.trim().length > 0 ? model : undefined;
}
