// wavemill-test-suite: custom
import assert from 'node:assert/strict';
import {
  fetchGenerationCost,
  fetchGenerationCostsBatched,
  type FetchLike,
} from './openrouter-generation-api.ts';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${(err as Error).message}`);
  }
}

function response(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
  } as Response;
}

console.log('\n--- openrouter-generation-api Tests ---\n');

await test('fetchGenerationCost returns parsed generation cost', async () => {
  let requestedUrl = '';
  let authHeader = '';
  const fetchFn: FetchLike = async (url, init) => {
    requestedUrl = String(url);
    authHeader = String((init?.headers as Record<string, string>).Authorization);
    return response({
      data: {
        total_cost: '0.1234',
        cache_discount: 0.5,
        provider_name: 'Together',
        model: 'z-ai/glm-5.2-20260616',
        native_tokens_prompt: 100,
        native_tokens_cached: 90,
        native_tokens_completion: 10,
      },
    });
  };

  const result = await fetchGenerationCost('gen-test', { apiKey: 'secret-key', fetchFn });
  assert.equal(result?.totalCostUsd, 0.1234);
  assert.equal(result?.cacheDiscountUsd, 0.5);
  assert.equal(result?.providerName, 'Together');
  assert.equal(result?.modelPermaslug, 'z-ai/glm-5.2-20260616');
  assert.equal(result?.nativeTokensCached, 90);
  assert.ok(requestedUrl.endsWith('/generation?id=gen-test'));
  assert.equal(authHeader, 'Bearer secret-key');
});

await test('HTTP failures return null', async () => {
  const result = await fetchGenerationCost('gen-test', {
    apiKey: 'secret-key',
    fetchFn: async () => response({ error: 'nope' }, false),
  });
  assert.equal(result, null);
});

await test('network errors return null', async () => {
  const result = await fetchGenerationCost('gen-test', {
    apiKey: 'secret-key',
    fetchFn: async () => { throw new Error('secret-key should not escape'); },
  });
  assert.equal(result, null);
});

await test('missing API key skips fetch', async () => {
  let called = false;
  const result = await fetchGenerationCost('gen-test', {
    apiKey: '',
    fetchFn: async () => {
      called = true;
      return response({});
    },
  });
  assert.equal(result, null);
  assert.equal(called, false);
});

await test('timeout aborts and returns null', async () => {
  let aborted = false;
  const result = await fetchGenerationCost('gen-test', {
    apiKey: 'secret-key',
    timeoutMs: 1,
    fetchFn: async (_url, init) => new Promise<Response>((resolve) => {
      init?.signal?.addEventListener('abort', () => {
        aborted = true;
        resolve(response({}));
      }, { once: true });
    }),
  });
  assert.equal(result, null);
  assert.equal(aborted, true);
});

await test('malformed JSON shape returns null', async () => {
  const result = await fetchGenerationCost('gen-test', {
    apiKey: 'secret-key',
    fetchFn: async () => response({ data: { total_cost: 'NaN' } }),
  });
  assert.equal(result, null);
});

await test('batched fetch preserves mapping and respects concurrency', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const fetchFn: FetchLike = async (url) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight--;
    const id = new URL(String(url)).searchParams.get('id');
    return id === 'bad'
      ? response({ error: 'bad' }, false)
      : response({ data: { total_cost: id === 'a' ? 1 : 2 } });
  };

  const result = await fetchGenerationCostsBatched(['a', 'b', 'bad', 'a'], {
    apiKey: 'secret-key',
    fetchFn,
    concurrency: 2,
  });
  assert.equal(result.get('a')?.totalCostUsd, 1);
  assert.equal(result.get('b')?.totalCostUsd, 2);
  assert.equal(result.get('bad'), null);
  assert.ok(maxInFlight <= 2);
  assert.equal(result.size, 3);
});

console.log(`\n--- Results: ${passed} passed, ${failed} failed ---\n`);

if (failed > 0) {
  process.exit(1);
}
