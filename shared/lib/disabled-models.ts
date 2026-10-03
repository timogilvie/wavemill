/**
 * Models excluded from every automatic selection path.
 *
 * `filterDisabledModels` is applied by challenge-mode, challenge-scheduler,
 * stage-aware-router, workflow-router, execution-contract and model-registry,
 * so an entry here is removed as a planner, coder, reviewer and challenger
 * alike. It does not remove the model from the registry: identity, pricing and
 * audit history are preserved, and re-enabling is a one-line revert.
 *
 * Prefer this over `routingEligible: false` in the registry as the single
 * authoritative kill-switch. Registry eligibility flags do reach challenge
 * selection (listEffectiveModelsForStage applies explainModelSupportExclusion,
 * which checks lifecycle, stages, disabled and routingEligible), but an entry
 * here is unambiguous, greppable, and reverts in one line.
 */
export const DISABLED_MODEL_IDS = new Set<string>([
  'gpt-5.3-codex',
  // Disabled 2026-08-25 for HOK-2885. Stalled with
  // `provider-transient-error: Upstream idle timeout exceeded` on 5 of 7 recent
  // challenger launches -- the most-selected challenger and the least reliable.
  // The stall is provider-side (OpenRouter tearing down an idle upstream
  // mid-stream), not a quality problem, so this is a reliability hold rather
  // than a judgement on the model's output. HOK-2885 has since landed bounded
  // phase relaunch on transient challenger failures plus single-side abort
  // scoping, so a stall no longer costs the pair -- but at a ~71% observed
  // stall rate the retry budget would still be spent mostly on this model.
  // Re-enable only after a completion-rate review shows the upstream stalls
  // have subsided (or once challenge selection weights by observed
  // completion rate).
  'llama-4-maverick',
  // Disabled 2026-09-02 after three concurrent implementation challengers
  // selected Scout via least-used-zero-record. Two received OpenRouter 429
  // upstream rate-limit responses before producing a token; the third emitted
  // apply_patch syntax as plain text, executed no tool calls, and produced no
  // completion artifact. Account credit was available, so this is a provider
  // capacity and live tool-protocol reliability hold, not a billing hold.
  // Re-enable only after a live coding certification demonstrates a structured
  // mutation tool call plus completion artifact and a completion-rate review
  // shows the upstream throttle has cleared.
  'llama-4-scout',
  // Disabled 2026-10-03 for HOK-3158. Three gemini-3.1-pro-preview challenger
  // arms cost ~$57 (token-derived) and yielded no usable Hokusai training data:
  // none finished (provider 400 INVALID_ARGUMENT after 329 turns; an account
  // 402 after a 1,620-turn / ~$40 runaway coding loop; superseded after 80
  // turns), their tool decisions were not captured on abnormal exit (recovered
  // by backfill), native cost recorded as $0, and the infra failures were
  // filed as model forfeits. This is a data-retention and spend hold, not a
  // quality judgement. Re-enable only after HOK-3158 lands (capture on
  // abnormal exit, recorded cost, per-arm budget ceiling, infra failures kept
  // out of model attribution). Both variants are paused together.
  'gemini-3.1-pro-preview',
  'gemini-3.1-pro-preview-customtools',
]);

export function isDisabledModel(modelId: string | undefined | null): boolean {
  return typeof modelId === 'string' && DISABLED_MODEL_IDS.has(modelId);
}

export function filterDisabledModels<T extends string>(models: T[]): T[] {
  return models.filter((model) => !isDisabledModel(model));
}
