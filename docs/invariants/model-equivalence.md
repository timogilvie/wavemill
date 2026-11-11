---
title: Model identity
---

# Model identity

`challenge-comparison.ts` `challengeModelIdsEquivalent()` - The one model-identity decision (HOK-3321): challenge code decides "are these two spellings of the same model?" exclusively through this registry-backed helper (canonicalises OpenRouter aliases like `qwen/qwen3-coder` ⇄ `qwen-3-coder` and provider-native ids like `claude-haiku-4-5-20251001` ⇄ `claude-haiku-4-5`), threaded with the caller's `repoDir`. The HOK-3313 incident false-invalidated a valid planning experiment as `stage_override_lost` because raw `===` saw two spellings of one registry entry. **Never compare a model-named identifier with `===`/`!==` in challenge code** (`challenge-execution-contract.ts`, `challenge-pair-recovery.ts`, `challenge-attestation-backfill.ts`, `challenge-coverage-selector.ts`, `stage-result.ts`, `executed-model-resolver.ts`, `backfill-stage-executed-model.ts`). Enforced by `tools/check-model-equivalence.ts` (`tools/model-equivalence-allowlist.txt`, `// allow-model-equivalence: <reason>` for justified exceptions such as the seal's byte-identity check).
