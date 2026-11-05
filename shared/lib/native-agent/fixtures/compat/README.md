# Compat Fixtures

Each file in this directory certifies one read-only tool against one initial Pi transport.

Current coverage target:
- `read_file`
- `list_files`
- `search_text`
- `git_status`
- `git_diff`

Current transports:
- `openai-completions` for OpenRouter
- `openai-responses` for OpenAI

Each fixture exports:
- `tool`, `transport`, `modelId`, `nativeProvider`
- `toolDescriptor` with the tool name, description, and JSON Schema
- `request.expectedPayload` for the provider request body emitted by Pi
- `response.rawProviderResponse` for the provider stream payload
- `response.expectedToolCall` for the parsed tool call

When a new read-only tool is added:
1. Add one fixture file per supported transport in this directory.
2. Reuse the real tool descriptor from `createReadOnlyTools()` or `createGitTools()` so schema drift stays visible.
3. Capture the request body with the transport `onPayload` hook and update `expectedPayload`.
4. Capture or hand-author the minimal streaming response needed to produce the expected tool call.
5. Run `bash tests/run-unit-tests.sh` (the native-agent tests are part of the unit shard) and confirm the coverage gate passes.

The tests fail on two conditions:
- Missing fixture for a tool/transport pair.
- Orphan fixture whose `tool` no longer exists in the read-only registry.
