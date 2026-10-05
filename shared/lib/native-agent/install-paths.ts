/**
 * Install-relative resolution for wavemill-owned assets.
 *
 * Mill drives consumer repositories that contain no `tools/`, `shared/lib/` or
 * `dspy/artifacts/` of their own. Native launchers additionally import
 * `../shared/lib/...`, so a copy placed inside a consumer repo could not
 * resolve its own imports even if one were scaffolded there. The installation
 * copy is the only one that can ever execute.
 *
 * Anything under `tools/`, `tools/prompts/`, `shared/`, `dspy/artifacts/`,
 * `claude/` or `codex/` is wavemill-owned and must be resolved from this
 * module — never with `join(repoDir, 'tools', ...)`. `repoDir` is the repo
 * being worked on, which is only coincidentally wavemill itself when running
 * wavemill's own test suite. That coincidence is why repo-relative launcher
 * paths passed CI while failing in every other repository.
 *
 * The shell equivalents are `WAVEMILL_INSTALL_DIR` and `wavemill_tool_path`
 * in `shared/lib/wavemill-common.sh`, mirrored by `agent_wavemill_tools_dir`
 * and `agent_native_launcher_path` in `shared/lib/agent-adapters.sh`. The
 * milled repo (the repo wavemill is operating on) is the shell
 * `WAVEMILL_MILLED_REPO_DIR` / `REPO_DIR` and the TS `repoDir`.
 */

import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type NativeLauncherPhase = 'planning' | 'coding' | 'review';

const LAUNCHER_FILENAMES: Record<NativeLauncherPhase, string> = {
  planning: 'launch-native-planning.ts',
  coding: 'launch-native-coding.ts',
  review: 'launch-native-review.ts',
};

/**
 * Absolute path to the wavemill installation root.
 *
 * The running module *is* the install, so we derive from
 * `import.meta.url`. An inherited env var could point at a different
 * checkout (monitor runs from `main` while worker launchers run from
 * worktrees), so inheritance would mix versions. `WAVEMILL_DIR` is kept
 * as a test-only override.
 */
export function resolveWavemillInstallDir(): string {
  if (process.env.WAVEMILL_DIR) {
    return process.env.WAVEMILL_DIR;
  }
  // This module lives at <install>/shared/lib/native-agent/
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

/**
 * Absolute path to the wavemill installation's `tools/` directory.
 */
export function resolveWavemillToolsDir(): string {
  return join(resolveWavemillInstallDir(), 'tools');
}

/**
 * Absolute path to a tool inside the wavemill installation's `tools/`.
 *
 * @param tool - File name within `tools/`, e.g. `route-task.ts`.
 */
export function resolveWavemillToolPath(tool: string): string {
  return join(resolveWavemillToolsDir(), tool);
}

/**
 * Absolute path to the native launcher for a phase.
 *
 * @param phase - Native phase the launcher serves.
 * @returns Absolute path to the launcher inside the wavemill installation.
 */
export function resolveNativeLauncherPath(phase: NativeLauncherPhase): string {
  return join(resolveWavemillToolsDir(), LAUNCHER_FILENAMES[phase]);
}

/**
 * Absolute path to a shared prompt template in `tools/prompts/`.
 *
 * `tool-runner.ts` exposes a `resolvePromptPath(importMetaUrl, name)` for the
 * same purpose, but it derives `prompts/` from the *caller's* directory, so it
 * only works for callers that live in `tools/`. Callers under `shared/lib/`
 * must use this instead.
 *
 * @param promptName - File name within `tools/prompts/`, e.g. `issue-writer.md`.
 * @returns Absolute path to the prompt template inside the installation.
 */
export function resolveWavemillPromptPath(promptName: string): string {
  return join(resolveWavemillToolsDir(), 'prompts', promptName);
}

/**
 * Resolve an install-relative resource URI (such as `tools/prompts/x.md` or
 * `dspy/artifacts/optimized-selector.json`) against the install root.
 *
 * Absolute paths pass through unchanged — this is important for
 * resource-selection where config can supply fully qualified paths.
 *
 * @param relOrAbs - Either an absolute path or a path relative to the install root.
 */
export function resolveWavemillAssetPath(relOrAbs: string): string {
  if (isAbsolute(relOrAbs)) return relOrAbs;
  return join(resolveWavemillInstallDir(), relOrAbs);
}
