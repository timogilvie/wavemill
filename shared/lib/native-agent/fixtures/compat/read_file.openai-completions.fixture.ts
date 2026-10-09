import { createReadOnlyTools } from '../../tools/read-only.ts';

const tool = createReadOnlyTools('/tmp/wavemill-compat-fixtures').find(
  (descriptor) => descriptor.metadata.name === 'read_file',
);

if (!tool) {
  throw new Error('Missing read_file tool descriptor');
}

export default {
  tool: 'read_file',
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
      path: 'package.json',
      startLine: 1,
      maxLines: 20,
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
        id: 'chatcmpl-read-file',
        model: 'openrouter:openai/gpt-4o-mini',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_read_file',
                  type: 'function',
                  function: {
                    name: 'read_file',
                    arguments: '{"path":"package.json","startLine":1,"maxLines":20}',
                  },
                },
              ],
            },
          },
        ],
      },
      {
        id: 'chatcmpl-read-file',
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: 'tool_calls',
          },
        ],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 7,
          total_tokens: 19,
        },
      },
      '[DONE]',
    ],
    expectedToolCall: {
      id: 'call_read_file',
      name: 'read_file',
      arguments: {
        path: 'package.json',
        startLine: 1,
        maxLines: 20,
      },
    },
  },
} as const;
