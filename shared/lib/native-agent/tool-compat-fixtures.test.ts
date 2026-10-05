import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
// Pi 0.80 moved raw API implementations under `api/*`, each exporting
// `streamSimple` (HOK-3161).
import { streamSimple as streamSimpleOpenAICompletions } from '@earendil-works/pi-ai/api/openai-completions';
import { streamSimple as streamSimpleOpenAIResponses } from '@earendil-works/pi-ai/api/openai-responses';
import { normalizeContext } from '@earendil-works/pi-ai';
import { createPiContext } from './messages.ts';
import { buildOpenAiResponsesModel, buildOpenRouterModel } from './providers.ts';
import { getToolCompatFixtures, type ToolCompatFixture } from './fixtures/compat/index.ts';
import { createGitTools } from './tools/git.ts';
import { createReadOnlyTools } from './tools/read-only.ts';

const TRANSPORTS = ['openai-completions', 'openai-responses'] as const;
const FIXTURE_PROMPT = 'Use the available tool.';
const FIXTURE_SYSTEM_PROMPT = 'You are a fixture harness.';

describe('tool compat fixtures', () => {
  it('covers every read-only registry tool for every initial transport', () => {
    const fixtures = getToolCompatFixtures();
    const toolNames = [
      ...createReadOnlyTools('/tmp/wavemill-compat-fixtures'),
      ...createGitTools('/tmp/wavemill-compat-fixtures'),
    ].map((descriptor) => descriptor.metadata.name);

    for (const toolName of toolNames) {
      for (const transport of TRANSPORTS) {
        assert.ok(
          fixtures.some((fixture) => fixture.tool === toolName && fixture.transport === transport),
          `Missing compat fixture for tool "${toolName}" on transport "${transport}"`,
        );
      }
    }
  });

  it('fails on orphan fixtures', () => {
    const toolNames = new Set([
      ...createReadOnlyTools('/tmp/wavemill-compat-fixtures'),
      ...createGitTools('/tmp/wavemill-compat-fixtures'),
    ].map((descriptor) => descriptor.metadata.name));

    for (const fixture of getToolCompatFixtures()) {
      assert.ok(toolNames.has(fixture.tool), `Orphan compat fixture for tool "${fixture.tool}"`);
    }
  });

  it('builds the expected provider payload for every fixture', async () => {
    for (const fixture of getToolCompatFixtures()) {
      const payload = await captureRequestPayload(fixture);
      assert.equal(
        canonicalJson(payload),
        canonicalJson(fixture.request.expectedPayload),
        `Request payload mismatch for ${fixture.tool} on ${fixture.transport}`,
      );
    }
  });

  it('parses the expected tool call for every fixture', async () => {
    for (const fixture of getToolCompatFixtures()) {
      const toolCall = await parseToolCallFromFixture(fixture);
      assert.deepEqual(
        toolCall,
        fixture.response.expectedToolCall,
        `Parsed tool call mismatch for ${fixture.tool} on ${fixture.transport}`,
      );
    }
  });
});

async function captureRequestPayload(fixture: ToolCompatFixture): Promise<unknown> {
  const stream = getTransportStream(fixture)(buildModel(fixture), buildContext(fixture), {
    apiKey: 'fixture-key',
    onPayload: (payload: unknown) => {
      throw new PayloadCaptureError(payload);
    },
  });

  let captured: unknown;
  for await (const event of stream) {
    if (event.type === 'error' && event.error?.errorMessage?.startsWith(PayloadCaptureError.PREFIX)) {
      captured = JSON.parse(event.error.errorMessage.slice(PayloadCaptureError.PREFIX.length));
    }
  }

  assert.notEqual(captured, undefined, `Expected onPayload capture for ${fixture.tool} on ${fixture.transport}`);
  return captured;
}

async function parseToolCallFromFixture(fixture: ToolCompatFixture) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => createSseResponse(fixture.response.rawProviderResponse as unknown[]);

  try {
    const stream = getTransportStream(fixture)(buildModel(fixture), buildContext(fixture), {
      apiKey: 'fixture-key',
    });

    for await (const event of stream) {
      if (event.type === 'toolcall_end') {
        return {
          id: event.toolCall.id,
          name: event.toolCall.name,
          arguments: event.toolCall.arguments as Record<string, unknown>,
        };
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
  }

  throw new Error(`Expected toolcall_end event for ${fixture.tool} on ${fixture.transport}`);
}

function getTransportStream(fixture: ToolCompatFixture) {
  return fixture.transport === 'openai-completions'
    ? streamSimpleOpenAICompletions
    : streamSimpleOpenAIResponses;
}

function buildModel(fixture: ToolCompatFixture) {
  return fixture.transport === 'openai-completions'
    ? buildOpenRouterModel({ modelId: fixture.modelId })
    : buildOpenAiResponsesModel({ modelId: fixture.modelId });
}

function buildContext(fixture: ToolCompatFixture) {
  // Raw API modules take a normalized transcript context; a raw Context's
  // systemPrompt and tools would be ignored (HOK-3161).
  return normalizeContext(createPiContext(
    [
      { role: 'system', content: FIXTURE_SYSTEM_PROMPT },
      { role: 'user', content: FIXTURE_PROMPT },
    ],
    [fixture.toolDescriptor],
  ));
}

function createSseResponse(events: unknown[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const event of events) {
        const line = event === '[DONE]'
          ? 'data: [DONE]\n\n'
          : `data: ${JSON.stringify(event)}\n\n`;
        controller.enqueue(encoder.encode(line));
      }
      controller.close();
    },
  });

  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortValue(item));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, sortValue(nested)]),
    );
  }
  return value;
}

class PayloadCaptureError extends Error {
  static readonly PREFIX = 'PAYLOAD_CAPTURE:';

  constructor(payload: unknown) {
    super(PayloadCaptureError.PREFIX + JSON.stringify(payload));
  }
}
