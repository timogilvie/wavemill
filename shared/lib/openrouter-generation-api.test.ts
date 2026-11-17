// wavemill-test-suite: custom
import assert from 'node:assert/strict';
import {
  fetchGenerationCost as fetchGenerationCostImpl,
  fetchGenerationCostsBatched,
  type FetchLike,
} from './openrouter-generation-api.ts';

const fetchGenerationCost = (id: string, options: Parameters<typeof fetchGenerationCostImpl>[1] = {}) => fetchGenerationCostImpl(id, { ...options, retry: { sleep: async () => {}, ...options.retry } });

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

await test('observed provider survives unavailable billing, never a fabricated zero', async () => {
  const result = await fetchGenerationCost('gen-pending', {
    apiKey: 'test',
    fetchFn: async () => response({ data: { provider_name: 'Host A', total_cost: null } }),
  });
  assert.deepEqual(result, { totalCostUsd: null, providerName: 'Host A' });
});

await test('invalid billing and token fields do not poison retained host evidence', async () => {
  const result = await fetchGenerationCost('gen-invalid', {
    apiKey: 'test',
    fetchFn: async () => response({ data: { provider_name: 'Host A', total_cost: ' ', native_tokens_prompt: -1, native_tokens_cached: 'NaN' } }),
  });
  assert.deepEqual(result, { totalCostUsd: null, providerName: 'Host A' });
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
    retry: { sleep: async () => {} },
  });
  assert.equal(result.get('a')?.totalCostUsd, 1);
  assert.equal(result.get('b')?.totalCostUsd, 2);
  assert.equal(result.get('bad'), null);
  assert.ok(maxInFlight <= 2);
  assert.equal(result.size, 3);
});

await test('eventual generation metadata uses bounded shared retry, never hides permanent auth refusal', async () => {
  let requests = 0;
  const result = await fetchGenerationCost('gen-delayed', { apiKey: 'test', retry: { random: () => .5 },
    fetchFn: async () => ++requests < 3 ? { ok: false, status: 404 } as Response : response({ data: { total_cost: .02, provider_name: 'Observed Host' } }) });
  assert.equal(requests, 3);
  assert.equal(result?.providerName, 'Observed Host');
  requests = 0;
  assert.equal(await fetchGenerationCost('gen-forbidden', { apiKey: 'test', fetchFn: async () => { requests++; return { ok: false, status: 401 } as Response; } }), null);
  assert.equal(requests, 1);
  requests = 0;
  assert.equal(await fetchGenerationCost('gen-missing', { apiKey: 'test', fetchFn: async () => { requests++; return { ok: false, status: 404 } as Response; } }), null);
  assert.equal(requests, 4, 'shared retry default bounds metadata lookups');
});

console.log(`\n--- Results: ${passed} passed, ${failed} failed ---\n`);

if (failed > 0) {
  process.exit(1);
}
