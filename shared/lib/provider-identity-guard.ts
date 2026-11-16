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
  invariantDocs: ['docs/invariants/provider-identity.md'],
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
  structuralChecks: [
    {
      name: 'endpoint-qualification-gate',
      description: 'Endpoint qualification must resolve and load the exact endpoint subject through the common gate',
      paths: ['shared/lib/native-agent/certification/eligibility-gate.ts'],
      find(source) {
        return /endpoint:\s*input\.endpoint/.test(source) && /endpoint:\s*input\.endpoint[\s\S]*checkGlobalCertificationEligibility/.test(source)
          ? [] : [{ line: 1, detail: 'endpoint identity was lost before certification lookup' }];
      },
    },
    {
      name: 'endpoint-canary-request',
      description: 'Endpoint canaries must use the canonical exact-tag restriction and disable automatic fallback',
      paths: ['shared/lib/native-agent/certification/live-coding-canary.ts'],
      find(source) {
        return /options\.subject\.endpoint\s*\?\s*endpointRouting\(/.test(source) ? [] : [{ line: 1, detail: 'endpoint request bypasses the shared restriction' }];
      },
    },
  ],
  remediation: [
    'A stage result\'s executedModel is the provider-reported identity with',
    'executionEvidence.source: \'provider-response\' (HOK-3143). Never trust the requested',
    'wire id: take it from verifyProviderIdentity / the executed-model resolver.',
  ],
};
