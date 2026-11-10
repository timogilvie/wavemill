# Reducing Headless Claude Usage — Codex Migration Plan

**Status:** Draft / tracking
**Scope decision:** Hot paths first (convert unattended/automated Claude calls; leave explicit-command tools on Claude for a later pass)
**Default target model:** `gpt-5.5` (codex agent)
**Owner:** TBD

## Goal

Reduce the repo's reliance on headless `claude -p` invocations by routing the
highest-volume **unattended** LLM calls through Codex (`gpt-5.5`). Explicit,
user-triggered commands stay on Claude for now and are tracked as a follow-up.

## Background — two independent layers

Headless Claude shows up in two places that need different work:

1. **Single-shot LLM utility calls** — `shared/lib/llm-cli.ts`
   (`callLLM`/`callClaude`, shelling out to `claude -p --output-format json`).
   This is the real lock-in: the module advertises a `codex` provider but the
   path is **dead code** (wrong CLI args, Claude-only JSON parsing, untested).

2. **Autonomous agent launches (mill mode)** — `shared/lib/agent-adapters.sh`.
   Already multi-agent: `codex exec` launch exists, codex status hook exists,
   phase prompts are agent-agnostic, and agent is resolved from the model prefix
   (`gpt-*` → codex). Here the only work is **flipping defaults**.

---

## Phase 0 — Foundation: make the codex provider real (blocks everything) ✅ DONE

The codex provider in `llm-cli.ts` must actually work before any consumer can
be flipped. (HOK-2225 — implemented on `tim/hok-2225-phase-0-codex-provider`.)

- [x] `shared/lib/llm-cli.ts` — `PROVIDER_CONFIGS.codex` now uses the real
      non-interactive form `codex exec --json --sandbox read-only`; prompt piped
      via stdin; stray `CODEX_OUTPUT` unset. (Verified against codex-cli 0.139.0.)
- [x] Added `unwrapCodexJsonl()` to parse codex's JSONL event stream — text from
      `item.completed`/`agent_message` events, usage from `turn.completed`
      (`input_tokens` already includes cached; reasoning tokens billed as output;
      codex reports no cost). `callLLMOnce` branches on provider.
- [x] `stripToolCalls` confirmed to pass codex output through cleanly (smoke test).
- [x] Added `checkCodexAvailability` / `ensureCodexAvailable` by generalizing the
      Claude-only preflights into provider-parameterized helpers
      (`checkCliAvailability` / `ensureCliAvailable`); Claude wrappers preserved.
- [x] Added a `codex provider` test suite in `shared/lib/llm-cli.test.ts`
      (real JSONL shape, multi-message concat, arg/stdin wiring, noise filtering).

**Acceptance (met):** `callLLM(prompt, { provider:'codex', model:'gpt-5.5' })`
returns clean text + parsed usage against the real codex CLI; all 33 llm-cli
tests + review-engine/runner consumers pass.

---

## Phase 1 — Convert hot / automated call sites to Codex ✅ DONE

These run **unattended** during mill mode and post-completion — highest Claude
burn. (HOK-2226 — implemented on `tim/hok-2226-codex-hot-paths`.)

Approach: instead of hardcoding `provider:'codex'` per site, **the provider now
follows the model**. Added `resolveProviderForModel()` in `llm-cli.ts` (registry
maps `gpt-*`/OpenAI → codex, else claude) and a shared `callHeadlessLLM()` wrapper
(`shared/lib/headless-llm.ts`) that derives the provider and translates the
Claude-only `--tools ''` / `--append-system-prompt` flags (Codex has no
equivalent, so the instruction is folded into the prompt and tool use is bounded
by the codex `--sandbox read-only` default). Default headless model is `gpt-5.5`
(overridable via `WAVEMILL_HEADLESS_MODEL`; Phase 3 will source from config).

- [x] `shared/lib/eval.ts` — eval judge default model → `gpt-5.5` (provider
      follows model; `EVAL_MODEL` / `eval.judge.model` route it back to Claude).
      ⚠️ Baseline shift — see Risks.
- [x] `shared/lib/post-completion-hook.ts` — subsystem update analysis per PR.
- [x] `shared/lib/context-updater.ts` — subsystem spec regeneration.
- [x] `shared/lib/subsystem-updater.ts` — subsystem doc updates after merge.
- [x] `shared/lib/scope-shrinker.ts` — task-packet splitting (degraded mode); DI
      seam renamed `callClaude` → `callHeadlessLLM`; dead `claudeCmd` option dropped.
- [x] Tests: new `shared/lib/headless-llm.test.ts` (provider routing + flag
      translation, both providers via mock CLIs) and `resolveProviderForModel`
      coverage in `llm-cli`. All affected suites pass.

**Note:** `tools/plan-queue.ts:235` uses `callLLM` with `taskType` and already
routes through the registry fallback ladder — it follows Codex once Phase 3
lands, with no per-file edit. Left as-is. (`shared/lib/dependency-classifier.ts`,
mentioned here historically, was deleted as dead code in HOK-3458.)

---

## Phase 2 — Flip mill-mode (autonomous) defaults to Codex ✅ DONE

The launcher already supports codex; only the hardcoded `claude` defaults needed
to change. Switching the default model to a `gpt-*` id makes the existing
`agent_resolve_from_model` pick `codex` automatically. (HOK-2227 — implemented on
`tim/hok-2227-codex-mill-defaults`.)

**Model mapping (tier-matched):** planner `gpt-5.4`, coder `gpt-5.5`, reviewer
`gpt-5.4` — preserving today's shape (sonnet-class plan/review, opus-class code).

- [x] `shared/lib/wavemill-startup-runner.sh` — per-stage default fallbacks
      flipped: `planner`/`reviewer` `claude-sonnet-4-6` → `gpt-5.4`, `coder`
      `claude-opus-4-7` → `gpt-5.5` (all occurrences: bootstrap + launch paths).
- [x] `shared/lib/agent-adapters.sh` — `agent_resolve_from_model` fallback
      `${AGENT_CMD:-claude}` → `${AGENT_CMD:-codex}`; legacy `build_routing_prompt`
      template defaults updated to the gpt tier mapping.
- [x] `shared/lib/model-router.ts` — `DEFAULT_ROUTER_OPTIONS.defaultModel` →
      `gpt-5.4`, `defaultAgent` → `codex`.

**Intentionally left:** `agent_default_model_for_cmd` already maps `codex →
gpt-5.4`. The `agent_cmd="${1:-claude}"` param defaults in `agent-adapters.sh`
(`agent_*_text` helpers, prompt builders) are agent-agnostic / always passed an
explicit agent, so flipping them is a no-op. `pretrust_directory`'s `${AGENT_CMD:-claude}`
guards a Claude-only helper that already no-ops for codex. The config-driven
session default (`mill.agentCmd`, currently `claude` via config-sync) is Phase 3.

---

## Phase 3 — Routing/registry policy (the cleanest lever)

These knobs bias selection toward Claude. Flipping them propagates to Phases 1–2
with minimal per-call edits.

- [ ] `shared/lib/config-sync.ts:104-118` — add codex models to
      `availableModels.planner`; flip `defaultModel` → `gpt-5.5` and
      `defaultAgent` → `codex`. (`agentMap` already maps `gpt-5.4/5.5 → codex`.)
- [ ] `shared/lib/config-sync.ts` (~`:130`) — Layer-2 validation hardcodes
      `model:'claude-haiku-4-5-20251001'`; point at a codex model.
- [ ] `shared/lib/model-registry.ts` — audit per-task fallback ladders and
      `defaultLadderEligible` so codex models are first-class. Note
      `gpt-5.3-codex` is `disabled:true` (`:871`) — decide whether to re-enable.

---

## Phase 4 — Direct-shellout cleanups (bypass the abstraction) ✅ DONE

- [x] `tools/backfill-stage-scores.ts:118-124` — replaced the local
      `execSync('claude -p ...')` with `callLLM` from `shared/lib/llm-cli.ts`;
      default model flipped to `gpt-5.5` (provider resolved from model via
      `resolveProviderForModel`); `--model claude-sonnet-4-6` preserves prior behavior.
- [x] `tools/check-review-setup.ts` — renamed `checkCLI()` → `checkClaudeCLI()`;
      added parallel `checkCodexCLI()` using `checkCodexAvailability`; both checks
      run in `run()` so exit code 1 fires when either provider is unavailable;
      added Codex troubleshooting block mirroring the Claude one; network check
      stays Anthropic-only with asymmetry documented in an inline comment.

### Phase 4 inventory (audit results — HOK-2229)

| File | Disposition | Rationale |
|---|---|---|
| `tools/backfill-stage-scores.ts:124` | **migrated** | Direct `execSync('claude -p --output-format json --model …')` replaced by `callLLM`; default model → `gpt-5.5`. |
| `tools/check-review-setup.ts:228` | **doc-only / Codex parity added** | `checkCodexCLI()` added alongside `checkClaudeCLI()`; troubleshooting block added for Codex. |
| `shared/lib/llm-cli.ts:1311` | **left** | Inside `PREFLIGHT_TROUBLESHOOTING.claude` — Claude provider troubleshooting string. Correct as-is. |
| `shared/lib/review-engine.ts:94` | **left** | Comment explaining `DEFAULT_TIMEOUT_MS`. No code change needed. |
| `dspy/claude_cli_lm.py`, `dspy/evaluators/llm_caller.py` | **out of scope** | Python DSPy training/eval pipeline run manually by humans; not an unattended hot path. |
| `shared/lib/agent-adapters.sh` references | **out of scope** | Mill-mode agent launch layer (not single-shot LLM calls); codex resolution from model prefix already works (Phase 2). |
| `shared/hooks/claude-status-hook.sh` | **out of scope** | Claude-specific status adapter; Codex has its own `codex-status-monitor.sh`. |

**Re-audit result:** `rg -n 'execSync.*claude|spawn.*claude'` → zero matches in `tools/`. Only `leave`-classified hits remain for `claude -p` patterns.

---

## Follow-up (out of scope for "hot paths first")

Explicit user-command call sites left on Claude for a later pass; convert once
Phase 0 is proven and config-driven provider selection is in place:

- `shared/lib/issue-expander.ts:181` (issue → task packet)
- `shared/lib/plan-decomposer.ts:245,361` (initiative decomposition)
- `shared/lib/concept-page-generator.ts:101` (also hardcodes `model:'claude-opus-4-6'`)
- `shared/lib/review-engine.ts:297` + `shared/lib/review-runner.ts:18` (code review)
- `shared/lib/task-packet-validator.ts:547` (Layer-2 packet validation)
- `tools/compare-prs.ts:146,171` (challenge-mode PR comparison)

## Risks / open questions

- **Output-quality regressions** on the eval judge (Phase 1): the judge scores
  every workflow; a model change shifts the eval baseline. Plan to re-baseline
  or run both for a window.
- **Codex CLI auth/availability** in unattended contexts — Phase 0 preflights
  must fail loudly.
- **gpt-5.5 cost/latency** on hot paths (frontier tier, slow). If cost matters,
  revisit a per-stage mix (gpt-5.4 for eval/classify, gpt-5.5 for planning/review).
- The DeepSeek launcher still drives the `claude` binary (via Anthropic-compatible
  base URL); not addressed here — decide separately whether that counts as
  "headless Claude" to reduce.

### Eval-judge re-baseline decision

**Decision:** dual-run for a 14-day window (2026-06-23 through 2026-07-07).

Run both the Claude judge and the Codex judge in parallel for all new workflow
completions during this window. Compare score deltas at the window boundary;
if deltas are within ±0.05 on average, cut over to the Codex judge exclusively.

**Rationale:** Avoids retroactive re-scoring of historical records (out of scope)
while providing a forward-looking baseline comparison before permanently replacing
the Claude judge. The `EVAL_MODEL` environment variable and `eval.judge.model`
config key remain as escape hatches to revert to the Claude judge mid-window.

**Behavior change from Phase 4:** `tools/check-review-setup.ts` now exits
non-zero if Codex auth is missing (both providers validated). Operators in
Claude-only environments should pass `--skip-codex` (to be added if requested)
or accept the stricter check.
