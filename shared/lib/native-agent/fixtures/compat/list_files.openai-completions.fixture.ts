import { createReadOnlyTools } from '../../tools/read-only.ts';

const tool = createReadOnlyTools('/tmp/wavemill-compat-fixtures').find(
  (descriptor) => descriptor.metadata.name === 'list_files',
);

if (!tool) {
  throw new Error('Missing list_files tool descriptor');
}

export default {
  tool: 'list_files',
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
      path: 'shared/lib/native-agent',
      glob: '**/*.ts',
      maxResults: 25,
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
        id: 'chatcmpl-list-files',
        model: 'openrouter:openai/gpt-4o-mini',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_list_files',
                  type: 'function',
                  function: {
                    name: 'list_files',
                    arguments: '{"path":"shared/lib/native-agent","glob":"**/*.ts","maxResults":25}',
                  },
                },
              ],
            },
          },
        ],
      },
      {
        id: 'chatcmpl-list-files',
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 8,
          total_tokens: 20,
        },
      },
      '[DONE]',
    ],
    expectedToolCall: {
      id: 'call_list_files',
      name: 'list_files',
      arguments: {
        path: 'shared/lib/native-agent',
        glob: '**/*.ts',
        maxResults: 25,
      },
    },
  },
} as const;
