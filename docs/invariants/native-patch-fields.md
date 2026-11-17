---
title: NativePatch fields
---

# NativePatch fields

`shared/lib/native-agent/patch-contract.ts` /
`tools/check-native-patch-fields.ts` (HOK-3500).

The NativePatch contract has one structural definition:
`NATIVE_PATCH_PARAMETERS_SCHEMA` in `patch-contract.ts`. Both the tool schema
advertised by `apply_patch` and `validateNativePatch` use that definition.

The only places that may read or discriminate NativePatch payload fields are:

- `shared/lib/native-agent/patch-contract.ts` — the schema and validator.
- `shared/lib/native-agent/patch-runtime.ts` — residual runtime semantics
  (path traversal/anchoring/fuzzy application) on a *validated* patch.
- `shared/lib/native-agent/tools/apply-patch-tool.ts` — the tool wrapper that
  passes the payload to `validateNativePatch` and reports structural errors.

Everywhere else, interrogate a payload only through `validateNativePatch` and
operate on the returned typed `NativePatch`.

Suppress a justified line with `// allow-native-patch-fields: <reason>`.
