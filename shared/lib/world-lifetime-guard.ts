// allow-world-lifetime: this file *is* the guard spec; its pattern table names
// every forbidden shape.
/**
 * Preflight guard for the test-world lifetime invariant (HOK-3329, enforced by
 * HOK-3236): every fake/journey world's lifetime is owned by the one primitive
 * in tests/fakes/lib.sh — fakes_setup records the world, fakes_spawn registers
 * long-lived children, fakes_teardown_world tears the world down, and the owner
 * watcher (tests/fakes/world-watcher.sh) handles an owner that dies untrapped.
 * The real tmux binary resolves through term_resolve_real_tmux
 * (shared/lib/terminal-backend.sh).
 *
 * Shapes caught in test code and in shared shell code:
 * - a `tmux new-session` in test code (fakes_start_world_host owns it);
 * - an ad-hoc `tmux kill-server` (fakes_teardown_world owns it);
 * - a `set -m` launch of a long-lived test process (fakes_spawn owns pgid);
 * - the `sleep 86400` placeholder the watcher replaces;
 * - a private `type -P tmux` / `command -v tmux` resolver.
 */
import type { GuardSpec } from '../../tools/lib/source-guard.ts';

export const WORLD_LIFETIME_GUARD: GuardSpec = {
  name: 'world-lifetime',
  findingNoun: 'private test-world lifetime / tmux resolution site(s)',
  suppressionMarker: 'allow-world-lifetime',
  allowlistFile: 'tools/world-lifetime-allowlist.txt',
  invariantPaths: [
    'tests/fakes/lib.sh',
    'tests/fakes/world-watcher.sh',
    'shared/lib/terminal-backend.sh',
    'shared/lib/world-lifetime-guard.ts',
  ],
  excludedPrefixes: [
    // Default list minus `tests/` so this guard still scans journey/fake code.
    // `tests/fixtures/` is rehearsal data for incident replay (pre-primitive
    // world-host shapes baked into fixture scripts), not a world owner.
    'features/', '.wavemill/', 'node_modules/', 'worktrees/', 'spike/', '.git/', 'shared/validators/', 'tests/fixtures/',
  ],
  includeTests: true,
  patterns: [
    {
      name: 'ad-hoc-tmux-new-session',
      description: 'tmux new-session in test code — fakes_setup owns the world host and its lifetime',
      lang: 'sh',
      re: /\btmux(\s+-[^\s]+)*\s+new-session\b/,
      // The mill's own control session is production, not a test world.
      // tests/claude-tmux-server-guard.test.sh replays hook payloads, so the
      // shapes are data inside it, not invocations.
      excludePaths: ['shared/lib/wavemill-mill.sh', 'tests/claude-tmux-server-guard.test.sh'],
    },
    {
      name: 'ad-hoc-kill-server',
      description: 'ad-hoc tmux kill-server — fakes_teardown_world owns it',
      lang: 'sh',
      // Invocation-shaped only: a literal `tmux ... kill-server` command line.
      // Prose and regex fragments (deny reasons, PreToolUse payload matches)
      // never fire.
      re: /\btmux\b[^;|&]*\bkill-server\b/,
      // shared/agent-bin/tmux keeps kill-server for its policy-check path.
      // The two guard-replay tests exist to invoke the denial, so they are
      // excluded here rather than marked line by line.
      excludePaths: [
        'shared/agent-bin/tmux',
        'tests/agent-tmux-runtime-guard.test.sh',
        'tests/claude-tmux-server-guard.test.sh',
      ],
    },
    {
      name: 'ad-hoc-set-m',
      description: 'set -m launching a long-lived test process — use fakes_spawn',
      lang: 'sh',
      re: /^\s*set\s+-m\b/,
    },
    {
      name: 'sleep-86400-placeholder',
      description: 'sleep 86400 placeholder — the owner watcher replaces it',
      lang: 'sh',
      re: /\bsleep\s+86400\b/,
    },
    {
      name: 'private-type-p-tmux',
      description: 'private tmux resolution — use term_resolve_real_tmux',
      lang: 'sh',
      re: /\btype\s+-P\s+tmux\b/,
    },
    {
      name: 'private-command-v-tmux',
      description: 'private tmux resolution — use term_resolve_real_tmux',
      lang: 'sh',
      // Resolution-shaped only: a command substitution *capturing* the tmux
      // path (e.g. `REAL_TMUX="$(command -v tmux ...)"`). Existence probes
      // (`command -v tmux >/dev/null 2>&1`) are liveness checks, not
      // resolvers, and are allowed.
      re: /\$\([^)]*\bcommand\s+-v\s+tmux\b/,
    },
  ],
  remediation: [
    'Every test-world host lifetime is owned by tests/fakes/lib.sh:',
    '  fakes_setup records the world, fakes_start_world_host starts its',
    '  tmux server, fakes_spawn registers its pgids,',
    '  fakes_teardown_world kills them all, and the owner watcher',
    '  (tests/fakes/world-watcher.sh) tears the world down when the',
    '  owner shell dies untrapped. The "real tmux" binary resolves',
    '  through term_resolve_real_tmux (shared/lib/terminal-backend.sh).',
  ],
};