#!/usr/bin/env -S npx tsx
/**
 * Preflight guard (HOK-3460): one model transport per CLI, in
 * `shared/lib/model-adapters/`.
 *
 * Never implement a model CLI transport — spawning `claude`/`codex`, building
 * their argv, parsing their stdout/JSONL, or classifying their errors —
 * outside `shared/lib/model-adapters/`.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_EXCLUDED_PREFIXES, runGuardCli, type GuardSpec } from './lib/source-guard.ts';

export const MODEL_TRANSPORT_GUARD: GuardSpec = {
  name: 'model-transport',
  invariantDocs: ['docs/invariants/model-transport.md'],
  findingNoun: 'model-transport implementation(s)',
  suppressionMarker: 'allow-model-transport',
  allowlistFile: 'tools/model-transport-allowlist.txt',
  // The guard itself necessarily spells every forbidden shape in its patterns.
  invariantPaths: ['tools/check-model-transport.ts'],
  // The adapters are the one home for transport code (HOK-3460).
  excludedPrefixes: [...DEFAULT_EXCLUDED_PREFIXES, 'shared/lib/model-adapters/'],
  patterns: [
    {
      name: 'cli-spawn',
      description: 'spawning the claude/codex binary outside model-adapters duplicates a transport; use the adapter.',
      lang: 'both',
      re: /\b(?:spawn|spawnSync|execFile|execFileSync)\s*\(\s*['"](?:claude|codex)['"]/,
    },
    {
      name: 'claude-output-format-argv',
      description: 'building `--output-format json` argv outside model-adapters duplicates the claude CLI transport; use ClaudeCliAdapter.',
      lang: 'both',
      re: /--output-format\s+['"]?(?:stream-)?json\b/,
    },
    {
      name: 'claude-output-format-token',
      description: "the '--output-format' argv token belongs to the claude CLI transport; use ClaudeCliAdapter.",
      lang: 'both',
      re: /['"]--output-format['"]/,
    },
    {
      name: 'codex-json-argv',
      description: "`codex exec --json` argv outside model-adapters duplicates the codex CLI transport; use CodexCliAdapter.",
      lang: 'both',
      re: /['"]exec['"]\s*,\s*['"]--json['"]/,
    },
    {
      name: 'codex-jsonl-events',
      description: 'parsing codex JSONL events outside model-adapters duplicates CodexCliAdapter.parseResult.',
      lang: 'ts',
      re: /['"](?:turn\.completed|item\.completed|agent_message|thread\.started)['"]/,
    },
    {
      name: 'output-token-env-write',
      description: 'writing CLAUDE_CODE_MAX_OUTPUT_TOKENS outside model-adapters duplicates a transport env; use the adapter.',
      lang: 'ts',
      re: /CLAUDE_CODE_MAX_OUTPUT_TOKENS\s*[:=]/,
    },
    {
      name: 'private-llm-error-classifier',
      description: 'a private classify*LLMError duplicates the shared CLI error classifier; use retryPolicyFor/classifyCliMessage.',
      lang: 'ts',
      re: /\bfunction\s+classify\w*LLMError\b/,
    },
  ],
  remediation: [
    'Model CLI transports live in shared/lib/model-adapters/ (claude-cli-adapter.ts, codex-cli-adapter.ts, cli-process.ts, cli-error-classifier.ts).',
    'Callers get limits, argv, parse and typed errors from the adapter (adapterForProvider / resolveModelAdapter); they never spawn or parse a model CLI themselves.',
  ],
};

const filename = fileURLToPath(import.meta.url);
if (process.argv[1] === filename) {
  runGuardCli(MODEL_TRANSPORT_GUARD, process.argv[2] ?? join(dirname(filename), '..'));
}
