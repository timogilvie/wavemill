import { createGitTools } from '../../tools/git.ts';

const tool = createGitTools('/tmp/wavemill-compat-fixtures').find(
  (descriptor) => descriptor.metadata.name === 'git_diff_stat',
);

if (!tool) {
  throw new Error('Missing git_diff_stat tool descriptor');
}

export default {
  tool: 'git_diff_stat',
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
      base: 'HEAD',
      path: 'shared/lib/native-agent/tools/git.ts',
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
        id: 'chatcmpl-git-diff-stat',
        model: 'openrouter:openai/gpt-4o-mini',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_git_diff_stat',
                  type: 'function',
                  function: {
                    name: 'git_diff_stat',
                    arguments: '{"base":"HEAD","path":"shared/lib/native-agent/tools/git.ts"}',
                  },
                },
              ],
            },
          },
        ],
      },
      {
        id: 'chatcmpl-git-diff-stat',
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 7,
          total_tokens: 19,
        },
      },
      '[DONE]',
    ],
    expectedToolCall: {
      id: 'call_git_diff_stat',
      name: 'git_diff_stat',
      arguments: {
        base: 'HEAD',
        path: 'shared/lib/native-agent/tools/git.ts',
      },
    },
  },
} as const;
