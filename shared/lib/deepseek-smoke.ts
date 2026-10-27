import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import {
  buildDeepSeekLauncherEnv,
  createDeepSeekStateDir,
  MissingDeepSeekApiKeyError,
  writeDeepSeekStateDiscoveryFile,
  type BuildDeepSeekLauncherEnvOptions,
  type DeepSeekLauncherEnv,
} from './deepseek-launcher.ts';
import { getDeepSeekLauncherConfig, getDeepSeekProviderConfig } from './config.ts';
import { encodeProjectDir } from './wavemill-session-paths.ts';

const DEFAULT_SESSION = 'smoke';
const DEFAULT_ISSUE = 'HOK-1489';
const DEFAULT_MODEL = 'deepseek-v4-flash';
const DEFAULT_TIMEOUT_MS = 30_000;
const REDACTED_SECRET = '[redacted]';

export interface DeepSeekSmokeCheck {
  name: string;
  ok: boolean;
  details: string;
}

export interface DeepSeekSmokeResult {
  mode: 'dry-run' | 'live';
  ok: boolean;
  skipped?: boolean;
  exitCode: number;
  summary: string;
  checks: DeepSeekSmokeCheck[];
  keyEnvVar: string;
}

export interface RunDryRunSmokeOptions {
  repoDir?: string;
  session?: string;
  issue?: string;
  model?: string;
}

export interface RunLiveSmokeOptions extends RunDryRunSmokeOptions {
  prompt?: string;
  timeoutMs?: number;
  spawnSyncFn?: typeof spawnSync;
}

function latestMtimeMs(root: string): number {
  if (!existsSync(root)) {
    return 0;
  }

  let latest = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const entryPath = join(root, entry.name);
    if (entry.isDirectory()) {
      latest = Math.max(latest, latestMtimeMs(entryPath));
      continue;
    }
    try {
      latest = Math.max(latest, statSync(entryPath).mtimeMs);
    } catch {
      continue;
    }
  }
  return latest;
}

function hasProviderTranscript(worktreePath: string, env: DeepSeekLauncherEnv): boolean {
  const projectsDir = join(
    env.WAVEMILL_DEEPSEEK_STATE_DIR,
    'home',
    '.claude',
    'projects',
    encodeProjectDir(worktreePath),
  );
  return existsSync(projectsDir) && readdirSync(projectsDir).some((name) => name.endsWith('.jsonl'));
}

function resolveKeyEnvVar(repoDir: string): string {
  const providerConfig = getDeepSeekProviderConfig(repoDir);
  const launcherConfig = getDeepSeekLauncherConfig(repoDir);
  return launcherConfig.secretSource?.trim()
    || providerConfig.apiKeyEnv?.trim()
    || 'DEEPSEEK_API_KEY';
}

function makeLauncherOptions(options: RunDryRunSmokeOptions): BuildDeepSeekLauncherEnvOptions {
  return {
    repoDir: options.repoDir,
    session: options.session || DEFAULT_SESSION,
    issue: options.issue || DEFAULT_ISSUE,
    model: options.model || DEFAULT_MODEL,
  };
}

function relPath(root: string, target: string): string {
  const relativePath = relative(root, target);
  return relativePath && !relativePath.startsWith('..') ? relativePath : target;
}

function assertCheck(name: string, ok: boolean, details: string): DeepSeekSmokeCheck {
  return { name, ok, details };
}

function summarize(checks: DeepSeekSmokeCheck[], success: string, failure: string): { ok: boolean; summary: string } {
  const ok = checks.every((check) => check.ok);
  return {
    ok,
    summary: ok ? success : failure,
  };
}

function buildSentinelEnv(repoDir: string): Record<string, string> {
  const keyEnvVar = resolveKeyEnvVar(repoDir);
  return { [keyEnvVar]: 'deepseek-smoke-sentinel' };
}

export function runDryRunSmoke(options: RunDryRunSmokeOptions = {}): DeepSeekSmokeResult {
  const repoDir = resolve(options.repoDir || process.cwd());
  const keyEnvVar = resolveKeyEnvVar(repoDir);
  const env = buildDeepSeekLauncherEnv({
    ...makeLauncherOptions(options),
    repoDir,
    processEnv: buildSentinelEnv(repoDir),
  });

  const stateDir = resolve(env.WAVEMILL_DEEPSEEK_STATE_DIR);
  const checks: DeepSeekSmokeCheck[] = [
    assertCheck(
      'launcher.env.key_resolution',
      env.ANTHROPIC_AUTH_TOKEN.length > 0 && env.ANTHROPIC_API_KEY.length > 0,
      `${keyEnvVar} resolves into Anthropic auth env vars without exposing the value.`,
    ),
    assertCheck(
      'launcher.env.base_url',
      env.ANTHROPIC_BASE_URL.length > 0,
      `Resolved Anthropic-compatible endpoint: ${env.ANTHROPIC_BASE_URL}`,
    ),
    assertCheck(
      'launcher.env.models',
      env.ANTHROPIC_MODEL.startsWith('deepseek-')
        && env.ANTHROPIC_DEFAULT_OPUS_MODEL.startsWith('deepseek-')
        && env.ANTHROPIC_DEFAULT_SONNET_MODEL.startsWith('deepseek-')
        && env.ANTHROPIC_DEFAULT_HAIKU_MODEL.startsWith('deepseek-')
        && env.CLAUDE_CODE_SUBAGENT_MODEL.startsWith('deepseek-'),
      `Resolved models: main=${env.ANTHROPIC_MODEL}, subagent=${env.CLAUDE_CODE_SUBAGENT_MODEL}`,
    ),
    assertCheck(
      'launcher.env.agent_kind',
      env.WAVEMILL_AGENT_KIND === 'claude-deepseek',
      `WAVEMILL_AGENT_KIND=${env.WAVEMILL_AGENT_KIND}`,
    ),
    assertCheck(
      'launcher.env.state_isolation',
      [
        env.HOME,
        env.XDG_CONFIG_HOME,
        env.XDG_DATA_HOME,
        env.CLAUDE_CONFIG_DIR,
      ].every((value) => resolve(value).startsWith(stateDir))
        && !stateDir.startsWith(resolve(homedir(), '.claude')),
      `State is isolated under ${relPath(repoDir, stateDir)}`,
    ),
    assertCheck(
      'launcher.env.real_key_optional',
      true,
      process.env[keyEnvVar]?.trim()
        ? `${keyEnvVar} is present in the current environment for optional live validation.`
        : `${keyEnvVar} is not present in the current environment; live validation would skip cleanly.`,
    ),
  ];

  const result = summarize(
    checks,
    'Dry-run validated DeepSeek launcher construction.',
    'Dry-run DeepSeek launcher validation failed.',
  );

  return {
    mode: 'dry-run',
    ok: result.ok,
    exitCode: result.ok ? 0 : 1,
    summary: result.summary,
    checks,
    keyEnvVar,
  };
}

function scrubOutput(text: string): string {
  return text.replace(/deepseek-smoke-sentinel/g, REDACTED_SECRET).trim();
}

function makeSpawnEnv(options: RunLiveSmokeOptions, repoDir: string): {
  keyEnvVar: string;
  env: DeepSeekLauncherEnv;
} {
  const keyEnvVar = resolveKeyEnvVar(repoDir);
  const launcherOptions = makeLauncherOptions(options);
  const env = buildDeepSeekLauncherEnv({
    ...launcherOptions,
    repoDir,
    processEnv: process.env as Record<string, string | undefined>,
  });
  return { keyEnvVar, env };
}

function makeLiveSkipResult(keyEnvVar: string): DeepSeekSmokeResult {
  return {
    mode: 'live',
    ok: true,
    skipped: true,
    exitCode: 0,
    summary: `${keyEnvVar} is not set; skipping live DeepSeek smoke.`,
    checks: [
      assertCheck(
        'live.credentials',
        true,
        `Live smoke is optional and was skipped because ${keyEnvVar} is not set.`,
      ),
    ],
    keyEnvVar,
  };
}

export function runLiveSmoke(options: RunLiveSmokeOptions = {}): DeepSeekSmokeResult {
  const repoDir = resolve(options.repoDir || process.cwd());
  const prompt = options.prompt || process.env.DEEPSEEK_SMOKE_PROMPT || 'Reply with OK.';
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const spawnSyncFn = options.spawnSyncFn || spawnSync;
  const worktreePath = resolve(repoDir);

  let keyEnvVar = resolveKeyEnvVar(repoDir);
  let env: DeepSeekLauncherEnv;
  try {
    const resolved = makeSpawnEnv(options, repoDir);
    keyEnvVar = resolved.keyEnvVar;
    env = resolved.env;
  } catch (error) {
    if (error instanceof MissingDeepSeekApiKeyError) {
      return makeLiveSkipResult(keyEnvVar);
    }
    throw error;
  }

  createDeepSeekStateDir(env);
  writeDeepSeekStateDiscoveryFile(
    options.session || DEFAULT_SESSION,
    options.issue || DEFAULT_ISSUE,
    env.WAVEMILL_DEEPSEEK_STATE_DIR,
  );

  const realClaudeDir = join(homedir(), '.claude');
  const preRunClaudeMtime = latestMtimeMs(realClaudeDir);

  if (process.env.WAVEMILL_DEEPSEEK_SMOKE_STUB === '1') {
    return {
      mode: 'live',
      ok: true,
      exitCode: 0,
      summary: 'Live DeepSeek smoke completed via stub.',
      checks: [
        assertCheck('live.launch', true, 'Stubbed live smoke path completed without revealing secrets.'),
      ],
      keyEnvVar,
    };
  }

  const result = spawnSyncFn(
    'claude',
    ['--model', env.ANTHROPIC_MODEL, '--dangerously-skip-permissions', prompt],
    {
      cwd: worktreePath,
      encoding: 'utf-8',
      timeout: timeoutMs,
      env: {
        ...process.env,
        ...env,
      },
    },
  );

  const checks: DeepSeekSmokeCheck[] = [];
  const spawnError = result.error ? scrubOutput(result.error.message) : '';
  checks.push(assertCheck(
    'live.launch',
    result.status === 0 && !result.error,
    result.status === 0 && !result.error
      ? `Claude completed a bounded live prompt using ${env.ANTHROPIC_MODEL}.`
      : spawnError || scrubOutput(result.stderr || result.stdout || 'DeepSeek live smoke failed.'),
  ));

  if (checks[0]?.ok) {
    const transcriptFound = hasProviderTranscript(worktreePath, env);
    checks.push(assertCheck(
      'live.transcript',
      transcriptFound,
      transcriptFound
        ? `Transcript detected under ${relPath(repoDir, env.WAVEMILL_DEEPSEEK_STATE_DIR)}.`
        : 'Live smoke did not produce a transcript under the isolated DeepSeek state directory.',
    ));
  }

  if (checks.every((check) => check.ok)) {
    const postRunClaudeMtime = latestMtimeMs(realClaudeDir);
    checks.push(assertCheck(
      'live.state_isolation',
      postRunClaudeMtime <= preRunClaudeMtime,
      postRunClaudeMtime <= preRunClaudeMtime
        ? 'Real ~/.claude was not mutated by the live smoke.'
        : 'Live smoke mutated the real ~/.claude directory.',
    ));
  }

  const summary = summarize(
    checks,
    'Live DeepSeek smoke completed successfully.',
    'Live DeepSeek smoke failed.',
  );
  return {
    mode: 'live',
    ok: summary.ok,
    exitCode: summary.ok ? 0 : 1,
    summary: summary.summary,
    checks,
    keyEnvVar,
  };
}

export function runDeepSeekSmoke(repoDir = process.cwd()): DeepSeekSmokeResult {
  return runLiveSmoke({ repoDir });
}
