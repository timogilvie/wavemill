export type {
  CertificationPhase,
  CertificationSubject,
  LiveSmokeEvidence,
  LiveCodingCanaryAttemptNote,
  LiveCodingCanaryEligibility,
  LiveCodingCanaryEvidence,
  LiveCodingCanaryFailureReason,
  LiveCodingCanaryIneligibilityReason,
  LiveCodingCanaryLimitKind,
  LiveCodingCanaryLimits,
  LiveCodingCanaryResult,
  LiveCodingCanaryStatus,
  LiveCodingCanaryUsage,
  NativeCertificationArtifact,
  AnyNativeCertificationArtifact,
  ScenarioResult,
} from './schema.ts';

export {
  CERTIFICATION_BASE_PATH,
  CERTIFICATION_SCHEMA_VERSION,
  CERTIFICATION_TTL_DAYS,
  LIVE_CODING_CANARY_SCENARIO_ID,
  LIVE_CODING_CANARY_TTL_DAYS,
  PHASE_ORDER,
  allScenariosPassed,
  evaluateLiveCodingCanaryEligibility,
  isCertificationFresh,
  isLiveCodingCanaryFresh,
  liveCodingCanaryMatchesSubject,
  phaseSatisfies,
} from './schema.ts';

export type { CertificationEligibility, IneligibilityReason, ScopedCertificationEligibility } from './loader.ts';
export type { CertificationStorageIdentity, ResolvedCertificationSubject } from './identity.ts';
export type { CertificationStorageOptions, CertificationStorageScope } from './storage.ts';
export type { SuiteCoverageOptions, SuiteCoverageResult, SuiteCoverageStatus } from './coverage.ts';
export type {
  NativeGateDecision,
  NativeGateInput,
  NativeGateLaunchPhase,
  NativeGateMode,
  NativeGateReady,
  NativeGateReject,
  NativeGateRejectReason,
} from './eligibility-gate.ts';

export {
  buildCertificationPath,
  buildGlobalCertificationPath,
  buildLegacyRepoCertificationPath,
  checkCertificationEligibility,
  checkGlobalCertificationEligibility,
  checkSharedCertificationEligibility,
  evaluateEligibility,
  isValidPathSegment,
  loadCertification,
  loadGlobalCertification,
  loadSharedCertificationWithLegacyFallback,
  parseCertificationPath,
} from './loader.ts';
export {
  GLOBAL_CERTIFICATION_ROOT_ENV,
  buildCertificationPathFromRoot,
  buildScopedCertificationPath,
  resolveCertificationStorage,
  resolveGlobalCertificationRoot,
  resolveLegacyCertificationRoot,
} from './storage.ts';
export {
  isValidCertificationPathSegment,
  resolveCertificationStorageIdentity,
  resolveCertificationSubject,
  subjectsEqual,
} from './identity.ts';
export { evaluateNativeProviderGate } from './eligibility-gate.ts';
export { evaluateSuiteCoverage } from './coverage.ts';
export {
  CANARY_COHORT_REFRESH_COMMAND,
  evaluateCanaryCohortHealth,
  refreshCanaryCohort,
  renderCanaryCohortHealth,
  resolveCanaryCohort,
} from './canary-cohort.ts';
export type {
  CanaryCohortHealth,
  CanaryCohortMember,
  CohortCertifyFn,
  CohortMemberCanaryState,
  CohortMemberStatus,
  CohortRefreshMemberOutcome,
  CohortRefreshResult,
  ResolvedCanaryCohort,
} from './canary-cohort.ts';

export type { ReadResult, StoreError, StoreErrorCode } from './store.ts';

export {
  deleteGlobalCertification,
  listCertifications,
  listGlobalCertificationSuiteVersions,
  listGlobalCertifications,
  listScopedCertifications,
  parseCertificationArtifactPath,
  readCertification,
  serializeCertification,
  validateCertificationForWrite,
  writeCertification,
  writeGlobalCertification,
  writeScopedCertification,
} from './store.ts';

export type {
  CertificationExpectations,
  ValidationError,
  ValidationErrorCode,
  ValidationResult,
} from './validator.ts';

export {
  checkIdentity,
  checkLimitations,
  checkNotExpired,
  checkPhaseSatisfies,
  checkScenarios,
  checkSchemaVersion,
  checkSubject,
  checkSuiteVersion,
  validateCertification,
} from './validator.ts';

export type {
  ScenarioClassification,
  ScenarioCategory,
  ScenarioContext,
  ScenarioAssertion,
  ScenarioAssertionOutcome,
  FailureClass,
  HarnessUnsupportedReason,
  HarnessNotRunReason,
  CertificationScenario,
} from './scenarios.ts';

export { getDefaultScenarios, DEFAULT_CERTIFICATION_SUITE_VERSION } from './scenarios.ts';

export type {
  ModelCertificationState,
  ScenarioOutcome,
  ModelCertificationReportRow,
  BuildModelCertificationReportOptions,
  SerializedReport,
} from './report.ts';

export {
  buildModelCertificationReport,
  serializeReport,
  renderReportTable,
} from './report.ts';

export type {
  HarnessScenarioStatus,
  HarnessScenarioResult,
  HarnessReport,
  RunScenariosOptions,
} from './scenario-runner.ts';

export {
  runScenarios,
  aggregateReport,
  classifyAttempt,
  toArtifactScenario,
} from './scenario-runner.ts';

export type {
  RouterCertificationRejection,
  RouterCertificationRejectionReason,
  RouterRole,
} from './router-filter.ts';

export { filterNativeModels, STAGE_PHASE_REQUIREMENT } from './router-filter.ts';
