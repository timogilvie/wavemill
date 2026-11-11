---
title: Provider identity
---

# Provider identity

`shared/lib/native-agent/provider-identity.ts` - The provider-identity invariant (HOK-3143): every native loop turn's provider-reported `response.model` is verified against the certified identity via `extractProviderReportedIdentity` / `verifyProviderIdentity`. Alias certificates pin a concrete `resolvedTarget.model`; a mismatch (or an unverifiable alias turn) is caught in the loop's `message_end` handler, invalidates the certificate via `invalidateCertificationIdentity` (`certification/identity-invalidation.ts`), and throws `ProviderIdentityMismatchError` so the launcher writes `failureReason: 'identity_mismatch'` and `modelAttributionIneligibleReason: 'provider_substitution'`. The gate (`eligibility-gate.ts`) refuses invalidated certificates with reason `identity_mismatch`, which routes through the HOK-3142 `coding-launch-refused` reroute. **Never trust the requested wire id as `executedModel` — stage results must carry the provider-reported id and `executionEvidence.source: 'provider-response'`.** Enforced by `tools/check-provider-identity.ts`.
