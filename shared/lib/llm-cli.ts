/**
 * Shared LLM CLI integration
 *
 * Provides a unified interface for calling LLM CLIs (Claude, Codex, etc.) with:
 * - Multi-provider support (Claude CLI, Codex CLI, OpenAI API)
 * - Both sync (execSync) and stream (spawn) modes
 * - Temp file management for large prompts
 * - Configurable timeout, buffer limits, model
 * - JSON envelope unwrapping (data.result, usage extraction)
 * - Optional retry with exponential backoff
 * - Tool-call/XML tag stripping
 * - Provider-specific env injection
 *
 * @module llm-cli
 */

import { execSync, spawn, type SpawnOptions } from 'node:child_process';
import { writeFileSync, unlinkSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { escapeShellArg, execShellCommand } from './shell-utils.ts';

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

/**
 * Supported LLM providers
 */
export type LLMProvider = 'claude' | 'codex' | 'openai';

export interface LLMCallOptions {
  /** LLM provider to use (default: 'claude') */
  provider?: LLMProvider;
  /** Execution mode: 'sync' uses execSync (blocking), 'stream' uses spawn */
  mode?: 'sync' | 'stream';
  /** Model to use (e.g., 'claude-opus-4-6', 'gpt-4', 'codex-latest') */
  model?: string;
  /** Timeout in milliseconds (default: 120000 = 2 minutes) */
  timeout?: number;
  /** Max buffer size for stdout/stderr in bytes (default: 10MB) */
  maxBuffer?: number;
  /** Enable retry with exponential backoff (default: false) */
  retry?: boolean;
  /** Max retry attempts when retry is enabled (default: 2) */
  maxRetries?: number;
  /** Strip tool calls and XML tags from output (default: true) */
  stripToolCalls?: boolean;
  /** Additional CLI flags to pass to LLM command */
  cliFlags?: string[];
  /** Working directory for command execution */
  cwd?: string;
  /** Override CLI command (e.g., 'claude', 'codex', 'openai') */
  cliCmd?: string;
}

export interface LLMCallResult {
  /** Cleaned output text */
  text: string;
  /** Token usage (if available from JSON envelope) */
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  /** Cost in USD (if available from JSON envelope) */
  costUsd?: number;
  /** Raw output before cleaning */
  rawOutput: string;
  /** Provider that was used */
  provider: LLMProvider;
}

export interface CliHealthCheck {
  /** Whether CLI is available and working */
  available: boolean;
  /** CLI command that was checked */
  command: string;
  /** Version string if available */
  version?: string;
  /** Error message if check failed */
  error?: string;
  /** Detailed diagnostics */
  diagnostics?: {
    inPath: boolean;
    executable: boolean;
    authWorking?: boolean;
  };
}

// ────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT = 120_000; // 2 minutes
const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024; // 10MB
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_BACKOFF_BASE = 2000; // 2 seconds

// ────────────────────────────────────────────────────────────────
// Text Cleaning Utilities
// ────────────────────────────────────────────────────────────────

/**
 * Strip tool call XML tags and conversational preamble from Claude output.
 *
 * Removes:
 * - <tool_call>...</tool_call> blocks
 * - <tool_name>, <parameters>, and other XML-style tags
 * - Conversational text before the first markdown heading
 */
function stripToolCalls(text: string): string {
  // Remove <tool_call>...</tool_call> blocks (including multiline)
  let cleaned = text.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '');

  // Remove XML-style tags that Claude sometimes emits
  // Common tags: tool_name, parameters, prompt, command, subagent_type, pattern, file_path, etc.
  cleaned = cleaned.replace(
    /<\/?(?:tool_name|parameters|prompt|command|subagent_type|pattern|file_path|include|path|output_mode|context)[^>]*>[\s\S]*?(?:<\/(?:tool_name|parameters|prompt|command|subagent_type|pattern|file_path|include|path|output_mode|context)>)?/g,
    ''
  );

  // Strip conversational preamble before the first markdown heading or JSON
  const firstHeading = cleaned.search(/^#\s/m);
  const firstJson = cleaned.search(/\{[\s\n]/);

  if (firstHeading > 0 && (firstJson < 0 || firstHeading < firstJson)) {
    // Markdown content - strip preamble before first heading
    cleaned = cleaned.substring(firstHeading);
  } else if (firstJson > 0 && (firstHeading < 0 || firstJson < firstHeading)) {
    // JSON content - strip preamble before first {
    cleaned = cleaned.substring(firstJson);
  }

  // Collapse runs of 3+ blank lines into 2
  cleaned = cleaned.replace(/\n{4,}/g, '\n\n\n');

  return cleaned.trim();
}

// ────────────────────────────────────────────────────────────────
// JSON Envelope Unwrapping
// ────────────────────────────────────────────────────────────────

interface JsonEnvelope {
  result?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  total_cost_usd?: number;
}

/**
 * Unwrap JSON envelope from LLM CLI --output-format json.
 *
 * Extracts:
 * - data.result (the actual response text)
 * - data.usage (token counts)
 * - data.total_cost_usd (cost in USD)
 *
 * Falls back to raw output if not valid JSON envelope.
 */
function unwrapJsonEnvelope(raw: string): {
  text: string;
  usage?: LLMCallResult['usage'];
  costUsd?: number;
} {
  try {
    const data: JsonEnvelope = JSON.parse(raw);

    // Extract text from data.result if present
    const text = (data.result || raw).trim();

    // Extract usage if present
    let usage: LLMCallResult['usage'] | undefined;
    if (data.usage) {
      const u = data.usage;
      const inputTokens =
        (u.input_tokens || 0) +
        (u.cache_creation_input_tokens || 0) +
        (u.cache_read_input_tokens || 0);
      const outputTokens = u.output_tokens || 0;
      usage = {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
      };
    }

    // Extract cost if present
    const costUsd = data.total_cost_usd;

    return { text, usage, costUsd };
  } catch {
    // If JSON parse fails, treat the entire output as text (fallback)
    return { text: raw.trim() };
  }
}

// ────────────────────────────────────────────────────────────────
// Provider Configuration
// ────────────────────────────────────────────────────────────────

interface ProviderConfig {
  defaultCmd: string;
  envVarName: string;
  envVarValue: string;
  defaultArgs: string[];
}

const PROVIDER_CONFIGS: Record<LLMProvider, ProviderConfig> = {
  claude: {
    defaultCmd: 'claude',
    envVarName: 'CLAUDECODE',
    envVarValue: '',
    defaultArgs: ['-p', '--output-format', 'json'],
  },
  codex: {
    defaultCmd: 'codex',
    envVarName: 'CODEX_OUTPUT',
    envVarValue: 'json',
    defaultArgs: ['--output-format', 'json'],
  },
  openai: {
    defaultCmd: 'openai',
    envVarName: 'OPENAI_OUTPUT',
    envVarValue: 'json',
    defaultArgs: ['--format', 'json'],
  },
};

/**
 * Get provider configuration
 */
function getProviderConfig(provider: LLMProvider): ProviderConfig {
  return PROVIDER_CONFIGS[provider];
}

/**
 * Get CLI command for provider
 */
function getCliCommand(provider: LLMProvider, options: LLMCallOptions): string {
  if (options.cliCmd) {
    return options.cliCmd;
  }

  const config = getProviderConfig(provider);
  const envVarMap: Record<LLMProvider, string | undefined> = {
    claude: process.env.CLAUDE_CMD,
    codex: process.env.CODEX_CMD,
    openai: process.env.OPENAI_CMD,
  };

  return envVarMap[provider] || config.defaultCmd;
}

// ────────────────────────────────────────────────────────────────
// Execution Modes
// ────────────────────────────────────────────────────────────────

/**
 * Execute LLM CLI in synchronous mode using execSync.
 */
function executeSync(
  tmpFile: string,
  cliArgs: string[],
  options: LLMCallOptions,
  provider: LLMProvider
): string {
  const timeout = options.timeout ?? DEFAULT_TIMEOUT;
  const maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
  const cwd = options.cwd || process.cwd();

  const cliCmd = getCliCommand(provider, options);
  const command = `${escapeShellArg(cliCmd)} ${cliArgs.join(' ')} < ${escapeShellArg(tmpFile)}`;

  const config = getProviderConfig(provider);
  const env = {
    ...process.env,
    [config.envVarName]: config.envVarValue,
  };

  try {
    const raw = execShellCommand(command, {
      encoding: 'utf-8',
      timeout,
      maxBuffer,
      cwd,
      env,
    });

    return raw;
  } catch (error) {
    // Enhanced error handling with specific diagnostics
    const errorMsg = (error as Error).message;
    const promptSize = existsSync(tmpFile) ? readFileSync(tmpFile, 'utf-8').length : 0;

    // ENOENT - command not found
    if (errorMsg.includes('ENOENT') || errorMsg.includes('not found')) {
      throw new Error(
        `${provider} CLI command not found: ${cliCmd}\n\n` +
        `Command attempted: ${command}\n` +
        `Working directory: ${cwd}\n` +
        `PATH: ${process.env.PATH}\n\n` +
        `Troubleshooting:\n` +
        `  - Install Claude CLI: npm install -g @anthropic-ai/claude-cli\n` +
        `  - Verify installation: which ${cliCmd}\n` +
        `  - Check PATH includes: $(npm bin -g)\n` +
        `  - Run health check: npm run check:review\n`
      );
    }

    // ETIMEDOUT or timeout in message - timeout error
    if (errorMsg.includes('ETIMEDOUT') || errorMsg.includes('timed out') || errorMsg.includes('timeout')) {
      throw new Error(
        `${provider} CLI timed out after ${timeout}ms\n\n` +
        `Command: ${command}\n` +
        `Prompt size: ${promptSize} chars\n\n` +
        `Possible causes:\n` +
        `  - Network connectivity issues\n` +
        `  - Prompt too large for processing\n` +
        `  - Model overloaded or rate limited\n\n` +
        `Troubleshooting:\n` +
        `  - Increase timeout: REVIEW_TIMEOUT=300000 (5 min)\n` +
        `  - Check network: curl -I https://api.anthropic.com\n` +
        `  - Reduce diff size: review in smaller PRs\n` +
        `  - Try again in a few minutes\n`
      );
    }

    // 401 or authentication - auth failure
    if (errorMsg.includes('401') || errorMsg.includes('authentication') || errorMsg.includes('unauthorized')) {
      throw new Error(
        `${provider} CLI authentication failed\n\n` +
        `Troubleshooting:\n` +
        `  - Run: ${cliCmd} login\n` +
        `  - Verify auth: echo "test" | ${cliCmd} -p --model claude-haiku-4-5-20251001\n` +
        `  - Check API key: echo $ANTHROPIC_API_KEY\n` +
        `  - Run health check: npm run check:review\n`
      );
    }

    // Rate limit or quota exceeded
    if (errorMsg.includes('429') || errorMsg.includes('rate limit') || errorMsg.includes('quota')) {
      throw new Error(
        `${provider} CLI rate limit or quota exceeded\n\n` +
        `Troubleshooting:\n` +
        `  - Wait a few minutes and try again\n` +
        `  - Check usage at: https://console.anthropic.com/settings/usage\n` +
        `  - Contact support if issue persists\n`
      );
    }

    // Buffer exceeded
    if (errorMsg.includes('maxBuffer') || errorMsg.includes('stdout maxBuffer')) {
      throw new Error(
        `${provider} CLI output exceeded buffer limit (${maxBuffer} bytes)\n\n` +
        `Possible causes:\n` +
        `  - Diff is very large\n` +
        `  - LLM returned excessive output\n\n` +
        `Troubleshooting:\n` +
        `  - Review diff in smaller PRs\n` +
        `  - Increase buffer: REVIEW_MAX_BUFFER=${maxBuffer * 2}\n`
      );
    }

    // Generic error with full context
    throw new Error(
      `${provider} CLI command failed\n\n` +
      `Command: ${command}\n` +
      `Working directory: ${cwd}\n` +
      `Timeout: ${timeout}ms\n` +
      `Max buffer: ${maxBuffer} bytes\n` +
      `Model: ${options.model || '(default)'}\n` +
      `Prompt size: ${promptSize} chars\n\n` +
      `Error: ${errorMsg}\n\n` +
      `Troubleshooting:\n` +
      `  - Run health check: npm run check:review\n` +
      `  - Enable verbose mode: npx tsx tools/review-changes.ts main --verbose\n` +
      `  - Check system logs for more details\n`
    );
  }
}

/**
 * Execute LLM CLI in streaming mode using spawn.
 */
async function executeStream(
  tmpFile: string,
  cliArgs: string[],
  options: LLMCallOptions,
  provider: LLMProvider
): Promise<string> {
  return new Promise((resolve, reject) => {
    const cwd = options.cwd || process.cwd();
    const cliCmd = getCliCommand(provider, options);

    const config = getProviderConfig(provider);
    const env = {
      ...process.env,
      [config.envVarName]: config.envVarValue,
    };

    const spawnOptions: SpawnOptions = {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd,
      env,
    };

    const llmProcess = spawn(cliCmd, cliArgs, spawnOptions);

    let stdout = '';
    let stderr = '';

    llmProcess.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    llmProcess.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    llmProcess.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`${provider} CLI exited with code ${code}: ${stderr}`));
      } else {
        resolve(stdout);
      }
    });

    llmProcess.on('error', (error) => {
      reject(new Error(`Failed to spawn ${provider} CLI: ${error.message}`));
    });

    // Read prompt from temp file and send to stdin
    try {
      const prompt = readFileSync(tmpFile, 'utf-8');
      llmProcess.stdin?.write(prompt);
      llmProcess.stdin?.end();
    } catch (error) {
      reject(new Error(`Failed to read temp file: ${(error as Error).message}`));
    }
  });
}

// ────────────────────────────────────────────────────────────────
// Health Check
// ────────────────────────────────────────────────────────────────

/**
 * Check if Claude CLI is available and working.
 *
 * Performs three checks:
 * 1. Is 'claude' command in PATH?
 * 2. Can we get version info?
 * 3. Can we make a simple test call?
 *
 * @param options - Check options
 * @returns Health check result with diagnostics
 *
 * @example
 * ```typescript
 * const health = await checkClaudeAvailability({ verbose: true });
 * if (!health.available) {
 *   console.error('Claude CLI not available:', health.error);
 *   console.error('Diagnostics:', health.diagnostics);
 * }
 * ```
 */
export async function checkClaudeAvailability(
  options: { verbose?: boolean } = {}
): Promise<CliHealthCheck> {
  const verbose = options.verbose ?? false;
  const cliCmd = getCliCommand('claude', {});

  if (verbose) {
    console.error(`Checking Claude CLI availability (command: ${cliCmd})...`);
  }

  // Check 1: Is command in PATH?
  let inPath = false;
  try {
    const whichResult = execShellCommand(`which ${escapeShellArg(cliCmd)}`, {
      encoding: 'utf-8',
      timeout: 5000,
    });
    inPath = whichResult.toString().trim().length > 0;
    if (verbose) {
      console.error(`  ✓ Command found in PATH: ${whichResult.toString().trim()}`);
    }
  } catch (error) {
    if (verbose) {
      console.error(`  ✗ Command not found in PATH`);
    }
    return {
      available: false,
      command: cliCmd,
      error: `Claude CLI command '${cliCmd}' not found in PATH`,
      diagnostics: {
        inPath: false,
        executable: false,
      },
    };
  }

  // Check 2: Can we get version?
  let version: string | undefined;
  let executable = false;
  try {
    const versionResult = execShellCommand(`${escapeShellArg(cliCmd)} --version`, {
      encoding: 'utf-8',
      timeout: 5000,
    });
    version = versionResult.toString().trim();
    executable = true;
    if (verbose) {
      console.error(`  ✓ Version: ${version}`);
    }
  } catch (error) {
    if (verbose) {
      console.error(`  ✗ Could not get version: ${(error as Error).message}`);
    }
    return {
      available: false,
      command: cliCmd,
      error: `Claude CLI found but not executable: ${(error as Error).message}`,
      diagnostics: {
        inPath,
        executable: false,
      },
    };
  }

  // Check 3: Can we make a simple test call?
  let authWorking = false;
  try {
    const testPrompt = 'test';
    const tmpFile = join(tmpdir(), `wavemill-health-${Date.now()}.txt`);

    try {
      writeFileSync(tmpFile, testPrompt, 'utf-8');

      const testResult = execShellCommand(
        `${escapeShellArg(cliCmd)} -p --output-format json --model claude-haiku-4-5-20251001 < ${escapeShellArg(tmpFile)}`,
        {
          encoding: 'utf-8',
          timeout: 30000,
          maxBuffer: 1024 * 1024,
          env: {
            ...process.env,
            CLAUDECODE: '',
          },
        }
      );

      // If we got here, the test call succeeded
      authWorking = true;
      if (verbose) {
        console.error(`  ✓ Test call succeeded (auth working)`);
      }
    } finally {
      if (existsSync(tmpFile)) {
        try {
          unlinkSync(tmpFile);
        } catch {
          // Best effort cleanup
        }
      }
    }
  } catch (error) {
    const errorMsg = (error as Error).message;
    if (verbose) {
      console.error(`  ✗ Test call failed: ${errorMsg}`);
    }

    // Check if it's an auth error
    if (errorMsg.includes('401') || errorMsg.includes('authentication') || errorMsg.includes('unauthorized')) {
      return {
        available: false,
        command: cliCmd,
        version,
        error: `Claude CLI authentication failed. Run 'claude login' to authenticate.`,
        diagnostics: {
          inPath,
          executable,
          authWorking: false,
        },
      };
    }

    // Other error
    return {
      available: false,
      command: cliCmd,
      version,
      error: `Claude CLI test call failed: ${errorMsg}`,
      diagnostics: {
        inPath,
        executable,
        authWorking: false,
      },
    };
  }

  // All checks passed
  if (verbose) {
    console.error(`\n✓ Claude CLI is available and working`);
  }

  return {
    available: true,
    command: cliCmd,
    version,
    diagnostics: {
      inPath,
      executable,
      authWorking,
    },
  };
}

// ────────────────────────────────────────────────────────────────
// Main API
// ────────────────────────────────────────────────────────────────

/**
 * Call LLM CLI with the given prompt.
 *
 * Features:
 * - Multi-provider support (Claude, Codex, OpenAI)
 * - Supports both sync (execSync) and stream (spawn) modes
 * - Temp file management for large prompts
 * - Configurable timeout, buffer limits, model
 * - JSON envelope unwrapping (data.result, usage extraction)
 * - Optional retry with exponential backoff
 * - Tool-call/XML tag stripping
 * - Provider-specific env injection
 *
 * @param prompt - The prompt to send to the LLM
 * @param options - Configuration options
 * @returns Result with cleaned text, usage, and cost
 *
 * @example
 * ```typescript
 * // Claude (default provider)
 * const result = await callLLM('Explain quantum computing', {
 *   mode: 'sync',
 *   model: 'claude-opus-4-6',
 *   timeout: 30000,
 *   retry: true,
 * });
 * console.log(result.text);
 * ```
 *
 * @example
 * ```typescript
 * // Codex provider
 * const result = await callLLM(prompt, {
 *   provider: 'codex',
 *   mode: 'stream',
 *   model: 'codex-latest',
 * });
 * ```
 *
 * @example
 * ```typescript
 * // Custom CLI flags
 * const result = await callLLM(prompt, {
 *   provider: 'claude',
 *   cliFlags: ['--tools', '', '--append-system-prompt', 'Be concise.'],
 * });
 * ```
 */
export async function callLLM(
  prompt: string,
  options: LLMCallOptions = {}
): Promise<LLMCallResult> {
  const provider = options.provider || 'claude';
  const retry = options.retry ?? false;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;

  if (retry) {
    return callLLMWithRetry(prompt, options, provider, maxRetries);
  }

  return callLLMOnce(prompt, options, provider);
}

/**
 * Backward compatibility: callClaude() is an alias for callLLM() with provider='claude'
 */
export async function callClaude(
  prompt: string,
  options: Omit<LLMCallOptions, 'provider'> = {}
): Promise<LLMCallResult> {
  return callLLM(prompt, { ...options, provider: 'claude' });
}

/**
 * Internal: Single LLM CLI call without retry.
 */
async function callLLMOnce(
  prompt: string,
  options: LLMCallOptions,
  provider: LLMProvider
): Promise<LLMCallResult> {
  const mode = options.mode || 'sync';
  const stripCalls = options.stripToolCalls ?? true;

  // Create temp file for prompt
  const tmpFile = join(tmpdir(), `wavemill-${provider}-${Date.now()}.txt`);

  try {
    writeFileSync(tmpFile, prompt, 'utf-8');

    // Build CLI arguments
    const config = getProviderConfig(provider);
    const cliArgs = [...config.defaultArgs];

    // Add model if specified
    if (options.model) {
      cliArgs.push('--model', options.model);
    }

    // Add custom CLI flags
    if (options.cliFlags && options.cliFlags.length > 0) {
      cliArgs.push(...options.cliFlags);
    }

    // Execute based on mode
    let rawOutput: string;
    if (mode === 'sync') {
      rawOutput = executeSync(tmpFile, cliArgs, options, provider);
    } else {
      rawOutput = await executeStream(tmpFile, cliArgs, options, provider);
    }

    // Unwrap JSON envelope
    const { text: unwrappedText, usage, costUsd } = unwrapJsonEnvelope(rawOutput);

    // Strip tool calls if enabled
    const cleanedText = stripCalls ? stripToolCalls(unwrappedText) : unwrappedText;

    return {
      text: cleanedText,
      usage,
      costUsd,
      rawOutput,
      provider,
    };
  } finally {
    // Clean up temp file
    if (existsSync(tmpFile)) {
      try {
        unlinkSync(tmpFile);
      } catch {
        // Best effort cleanup
      }
    }
  }
}

/**
 * Internal: LLM CLI call with retry logic and exponential backoff.
 */
async function callLLMWithRetry(
  prompt: string,
  options: LLMCallOptions,
  provider: LLMProvider,
  maxRetries: number
): Promise<LLMCallResult> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        // Log retry attempt
        const errorPreview = lastError?.message.split('\n')[0] || 'Unknown error';
        const delay = Math.pow(2, attempt) * 1000;
        console.error(`\n⚠️  Retry attempt ${attempt}/${maxRetries}`);
        console.error(`   Previous error: ${errorPreview}`);
        console.error(`   Waiting ${delay}ms before retry...\n`);
      }

      return await callLLMOnce(prompt, options, provider);
    } catch (error) {
      lastError = error as Error;

      // Log error details
      const errorPreview = lastError.message.split('\n')[0];
      console.error(`\n❌ Attempt ${attempt + 1}/${maxRetries + 1} failed:`);
      console.error(`   ${errorPreview}`);

      if (attempt < maxRetries) {
        // Exponential backoff: 2s, 4s, 8s, ...
        const delay = Math.pow(2, attempt + 1) * 1000;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw new Error(
    `${provider} CLI call failed after ${maxRetries + 1} attempts\n\n` +
    `Last error: ${lastError?.message}\n\n` +
    `Troubleshooting:\n` +
    `  - Run health check: npm run check:review\n` +
    `  - Enable verbose mode: npx tsx tools/review-changes.ts main --verbose\n` +
    `  - Check if service is experiencing issues: https://status.anthropic.com\n`
  );
}

// ────────────────────────────────────────────────────────────────
// JSON Parsing Utilities
// ────────────────────────────────────────────────────────────────

/**
 * Parse JSON from LLM output using a 4-strategy approach.
 *
 * Strategies (in order):
 * 1. Strip markdown code fences (```json...```)
 * 2. Strip tool_call/XML tags
 * 3. Find first complete JSON object using brace-depth tracking
 * 4. Fallback to raw JSON.parse
 *
 * This consolidates all the different JSON extraction patterns found
 * across the codebase into a single, robust implementation.
 *
 * @param text - Raw text output from LLM
 * @returns Parsed JSON object
 * @throws Error if JSON parsing fails after all strategies
 *
 * @example
 * ```typescript
 * const result = parseJsonFromLLM<{ score: number }>(llmOutput);
 * console.log(result.score);
 * ```
 */
export function parseJsonFromLLM<T = any>(text: string): T {
  let cleaned = text.trim();

  // Strategy 1: Strip markdown code fences
  if (cleaned.startsWith('```json')) {
    cleaned = cleaned.replace(/^```json\s*/i, '').replace(/\s*```\s*$/m, '');
  } else if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```\s*/, '').replace(/\s*```\s*$/m, '');
  }

  // Strategy 2: Strip tool_call/XML tags
  cleaned = cleaned.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '');
  cleaned = cleaned.replace(
    /<\/?(?:tool_name|parameters|prompt|command|subagent_type|pattern|file_path|include|path|output_mode|context)[^>]*>/g,
    ''
  );

  // Strategy 3: Find first complete JSON object using brace-depth tracking
  // This is the most robust approach for extracting JSON from mixed content
  let braceDepth = 0;
  let jsonStart = -1;
  let jsonEnd = -1;

  for (let i = 0; i < cleaned.length; i++) {
    const char = cleaned[i];

    if (char === '{') {
      if (braceDepth === 0) {
        jsonStart = i;
      }
      braceDepth++;
    } else if (char === '}') {
      braceDepth--;
      if (braceDepth === 0 && jsonStart >= 0) {
        jsonEnd = i + 1;
        break;
      }
    }
  }

  if (jsonStart >= 0 && jsonEnd > jsonStart) {
    cleaned = cleaned.substring(jsonStart, jsonEnd);
  }

  // Strategy 4: Fallback to raw JSON.parse
  try {
    return JSON.parse(cleaned) as T;
  } catch (error) {
    const errorMsg = (error as Error).message;
    const preview = cleaned.substring(0, 500);
    throw new Error(
      `Failed to parse JSON from LLM output: ${errorMsg}\n\nFirst 500 chars:\n${preview}`
    );
  }
}
