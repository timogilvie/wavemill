// HOK-3242: a type-only mirror of the real `readStageResult` signature.
//
// The CI guard here is a tsc swap-detection test: a fixture call site
// `readStageResult('ready', '/some/path')` must type-fail because the
// second positional is a path, not a `StageName`. The real
// `shared/lib/stage-result.ts` module is big and transitively imports
// several modules whose types are pre-existing-red under
// `tsconfig.static.json`, which would drown out the swap detection noise.
//
// Keep this file BYTE-FOR-BYTE in sync with `shared/lib/stage-result.ts`'s
// `readStageResult` overloads and `ReadStageResultOptions` definition.
// `shared/lib/stage-result.test.ts` runtime-tests the real function; this
// file only runs through tsc.

export type StageName = 'planning' | 'coding' | 'review' | 'ready';

export interface ReadStageResultOptions {
  featureDir: string;
  stage: StageName;
}

export interface StageResult {
  stage: StageName;
}

export declare function readStageResult(options: ReadStageResultOptions): Promise<StageResult | null>;
export declare function readStageResult(featureDir: string, stage: StageName): Promise<StageResult | null>;
