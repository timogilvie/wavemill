import { createReadOnlyTools } from '../../tools/read-only.ts';

const tool = createReadOnlyTools('/tmp/wavemill-compat-fixtures').find(
  (descriptor) => descriptor.metadata.name === 'search_text',
);

if (!tool) {
  throw new Error('Missing search_text tool descriptor');
}

export default {
  tool: 'search_text',
  transport: 'openai-completions',
  modelId: 'openai/gpt-4o-mini',
  nativeProvider: 'openrouter',
  toolDescriptor: {
    name: tool.metadata.name,
    description: tool.metadata.description,
    parameters: tool.parameters,
  },
  request: {
    invocationArgs: {
      query: 'runWavemillLoop',
      path: 'shared/lib/native-agent',
      glob: '**/*.ts',
      caseSensitive: true,
      maxResults: 10,
    },
    expectedPayload: {
      model: 'openrouter:openai/gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are a fixture harness.' },
        { role: 'user', content: 'Use the available tool.' },
      ],
      stream: true,
      stream_options: { include_usage: true },
      store: false,
      // Pi 1.0 defaults the ceiling to the model's maxTokens when none is passed (HOK-3161).
      max_completion_tokens: 16_384,
      tools: [
        {
          type: 'function',
          function: {
            name: tool.metadata.name,
            description: tool.metadata.description,
            parameters: tool.parameters,
            strict: false,
          },
        },
      ],
    },
  },
  response: {
    rawProviderResponse: [
      {
        id: 'chatcmpl-search-text',
        model: 'openrouter:openai/gpt-4o-mini',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_search_text',
                  type: 'function',
                  function: {
                    name: 'search_text',
                    arguments: '{"query":"runWavemillLoop","path":"shared/lib/native-agent","glob":"**/*.ts","caseSensitive":true,"maxResults":10}',
                  },
                },
              ],
            },
          },
        ],
      },
      {
        id: 'chatcmpl-search-text',
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        usage: {
          prompt_tokens: 14,
          completion_tokens: 9,
          total_tokens: 23,
        },
      },
      '[DONE]',
    ],
    expectedToolCall: {
      id: 'call_search_text',
      name: 'search_text',
      arguments: {
        query: 'runWavemillLoop',
        path: 'shared/lib/native-agent',
        glob: '**/*.ts',
        caseSensitive: true,
        maxResults: 10,
      },
    },
  },
} as const;
