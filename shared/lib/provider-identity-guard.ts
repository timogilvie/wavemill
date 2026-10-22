// allow-provider-identity: this file *is* the provider-identity guard; its
// pattern table names every forbidden shape. It is auto-excluded from its own
// scan (see invariantPaths); the marker above is defensive.
/**
 * Preflight guard for the provider-identity invariant (HOK-3143, enforced by
 * HOK-3236): a stage result's `executedModel` is the provider-reported id
 * (`response.model`, verified by shared/lib/native-agent/provider-identity.ts
 * or resolved by shared/lib/executed-model-resolver.ts), never the requested
 * wire id. Assigning `executedModel` straight from a requested / intended /
 * wire model variable is exactly the substitution HOK-3143 closed.
 *
 * Forwarding an already-resolved value (`attribution.executedModel`,
 * `summary.providerReportedModel`, `err.reportedModel`, `null`) never fires.
 */
import type { GuardSpec } from '../../tools/lib/source-guard.ts';

export const PROVIDER_IDENTITY_GUARD: GuardSpec = {
  name: 'provider-identity',
  findingNoun: 'requested-model executedModel assignment(s)',
  suppressionMarker: 'allow-provider-identity',
  allowlistFile: 'tools/provider-identity-allowlist.txt',
  invariantPaths: [
    'shared/lib/native-agent/provider-identity.ts',
    'shared/lib/executed-model-resolver.ts',
    'shared/lib/provider-identity-guard.ts',
  ],
  patterns: [
    {
      name: 'executed-model-from-request',
      description: '`executedModel` set from a requested/intended/wire model — use the provider-reported id (verifyProviderIdentity / resolveExecutedModelFromSessions)',
      lang: 'ts',
      // The assigned expression's final identifier is a request-side name; a call (`model()`) is not.
      re: /\bexecutedModel\??\s*[:=]\s*(?:[\w$]+\??\.)*(?:model|modelId|requestedModel|intendedModel|wireModel|wireId|targetModel|wireModelId)\b(?!\s*\()/,
    },
    {
      name: 'sh-executed-model-from-request',
      description: '`executedModel` built from the requested model in shell/jq — pass the resolver\'s executedModel',
      lang: 'sh',
      re: /--arg(?:json)?\s+executedModel\s+"?\$\{?(?:model|[a-z_]*(?:requested|intended|wire)[a-z_]*)\b|executedModel:\s*\(?\$(?:model|intendedModel|requestedModel)\b/,
    },
  ],
  remediation: [
    'A stage result\'s executedModel is the provider-reported identity with',
    'executionEvidence.source: \'provider-response\' (HOK-3143). Never trust the requested',
    'wire id: take it from verifyProviderIdentity / the executed-model resolver.',
  ],
};
