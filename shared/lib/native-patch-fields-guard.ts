// allow-native-patch-fields: this file *is* the NativePatch field guard;
// its patterns name the forbidden shape. It is auto-excluded from its own scan
// (see invariantPaths); the marker above is defensive.
/**
 * Preflight guard for the NativePatch field invariant (HOK-3500, enforced by
 * HOK-3236): a NativePatch payload field must only be interrogated inside the
 * contract schema and its explicitly allowed residual semantics.
 */
import type { GuardSpec } from '../../tools/lib/source-guard.ts';

export const NATIVE_PATCH_FIELDS_GUARD: GuardSpec = {
  name: 'native-patch-fields',
  findingNoun: 'private NativePatch field check(s)',
  suppressionMarker: 'allow-native-patch-fields',
  allowlistFile: 'tools/native-patch-fields-allowlist.txt',
  invariantDocs: ['docs/invariants/native-patch-fields.md'],
  invariantPaths: [
    'shared/lib/native-agent/patch-contract.ts',
    'shared/lib/native-agent/patch-runtime.ts',
    'shared/lib/native-agent/tools/apply-patch-tool.ts',
    'shared/lib/native-patch-fields-guard.ts',
    'tools/check-native-patch-fields.ts', // install-paths: allow guard reference documentation
  ],
  patterns: [
    {
      name: 'raw-envelope-field-access',
      description: 'NativePatch envelope field access outside the contract schema — validate the payload and read the returned NativePatch instead',
      lang: 'ts',
      scopedPaths: ['shared/lib/native-agent/'],
      re: /\b(?:input|patch|envelope)\.(atomic|operations|version|fuzzyMatch)\b/,
    },
    {
      name: 'raw-operation-field-access',
      description: 'NativePatch operation field access outside the contract schema or residual runtime — operate on the validated operation instead',
      lang: 'ts',
      scopedPaths: ['shared/lib/native-agent/'],
      re: /\boperation\.(op|path|oldText|newText|diff|anchorBefore|anchorAfter|expectedOccurrences)\b/,
    },
  ],
  remediation: [
    'NativePatch payload structure is owned by NATIVE_PATCH_PARAMETERS_SCHEMA in shared/lib/native-agent/patch-contract.ts.',
    'Validate payloads with validateNativePatch and read fields only from the returned typed NativePatch.',
    'Residual runtime checks (path traversal, anchor/fuzzy behaviour) live in patch-runtime.ts and apply-patch-tool.ts.',
  ],
};
