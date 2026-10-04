import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AssistantMessage } from './messages.ts';
import {
  extractProviderReportedIdentity,
  isRollingProviderAlias,
  ProviderIdentityMismatchError,
  ProviderIdentityTracker,
  providerModelMatches,
  verifyProviderIdentity,
  type ProviderIdentityExpectation,
} from './provider-identity.ts';

function msg(partial: Partial<Pick<AssistantMessage, 'responseModel' | 'responseId'>>): Pick<AssistantMessage, 'responseModel' | 'responseId'> {
  return partial;
}

test('isRollingProviderAlias detects ~-prefixed ids', () => {
  assert.equal(isRollingProviderAlias('~google/gemini-pro-latest'), true);
  assert.equal(isRollingProviderAlias('google/gemini-3.1-pro-preview'), false);
  assert.equal(isRollingProviderAlias(''), false);
});

test('extractProviderReportedIdentity: reported wins over echo', () => {
  const requested = '~google/gemini-pro-latest';
  const extracted = extractProviderReportedIdentity(
    msg({ responseModel: 'google/gemini-3.1-pro-preview', responseId: 'gen-1' }),
    requested,
  );
  assert.equal(extracted.kind, 'reported');
  assert.equal(extracted.reportedModel, 'google/gemini-3.1-pro-preview');
  assert.equal(extracted.responseId, 'gen-1');
});

test('extractProviderReportedIdentity: echo when only responseId is set', () => {
  const requested = 'google/gemini-3.1-pro-preview';
  const extracted = extractProviderReportedIdentity(
    msg({ responseId: 'gen-2' }),
    requested,
  );
  assert.equal(extracted.kind, 'echo');
  assert.equal(extracted.reportedModel, requested);
  assert.equal(extracted.responseId, 'gen-2');
});

test('extractProviderReportedIdentity: absent when no evidence', () => {
  const extracted = extractProviderReportedIdentity(msg({}), 'anything');
  assert.equal(extracted.kind, 'absent');
  assert.equal(extracted.reportedModel, null);
  assert.equal(extracted.responseId, null);
});

test('providerModelMatches: exact and case-insensitive', () => {
  assert.equal(providerModelMatches('google/gemini-3.1-pro-preview', 'google/gemini-3.1-pro-preview'), true);
  assert.equal(providerModelMatches('google/gemini-3.1-pro-preview', 'GOOGLE/Gemini-3.1-Pro-Preview'), true);
  assert.equal(providerModelMatches('a', 'b'), false);
});

test('providerModelMatches: accepts dated-snapshot suffixes', () => {
  assert.equal(
    providerModelMatches('google/gemini-3.1-pro-preview', 'google/gemini-3.1-pro-preview-20260219'),
    true,
  );
  assert.equal(
    providerModelMatches('google/gemini-3.1-pro-preview', 'google/gemini-3.1-pro-preview-2026-02-19'),
    true,
  );
});

test('providerModelMatches: -customtools is NOT a snapshot (mismatch)', () => {
  assert.equal(
    providerModelMatches('google/gemini-3.1-pro-preview', 'google/gemini-3.1-pro-preview-customtools'),
    false,
  );
});

test('providerModelMatches: suffix lookalike mismatches', () => {
  assert.equal(
    providerModelMatches('google/gemini-3.1-pro-preview', 'google/gemini-3.1-pro-preview-x'),
    false,
  );
  assert.equal(
    providerModelMatches('google/gemini-3.1-pro-preview', 'google/gemini-3.1-pro-preview2'),
    false,
  );
});

const nonAlias: ProviderIdentityExpectation = {
  requestedWireId: 'google/gemini-3.1-pro-preview',
  expectedModel: 'google/gemini-3.1-pro-preview',
  isAlias: false,
};

const alias: ProviderIdentityExpectation = {
  requestedWireId: '~google/gemini-pro-latest',
  expectedModel: 'google/gemini-3.1-pro-preview',
  isAlias: true,
};

test('verifyProviderIdentity: non-alias reported match', () => {
  const decision = verifyProviderIdentity(
    nonAlias,
    { kind: 'reported', reportedModel: 'google/gemini-3.1-pro-preview', responseId: 'r1' },
  );
  assert.equal(decision.verdict, 'match');
  assert.equal(decision.executedModel, 'google/gemini-3.1-pro-preview');
});

test('verifyProviderIdentity: non-alias echo is a match', () => {
  const decision = verifyProviderIdentity(
    nonAlias,
    { kind: 'echo', reportedModel: 'google/gemini-3.1-pro-preview', responseId: 'r1' },
  );
  assert.equal(decision.verdict, 'match');
  assert.equal(decision.executedModel, 'google/gemini-3.1-pro-preview');
});

test('verifyProviderIdentity: non-alias mismatch', () => {
  const decision = verifyProviderIdentity(
    nonAlias,
    { kind: 'reported', reportedModel: 'google/gemini-3.2-pro-preview', responseId: 'r1' },
  );
  assert.equal(decision.verdict, 'mismatch');
  assert.equal(decision.executedModel, 'google/gemini-3.2-pro-preview');
});

test('verifyProviderIdentity: alias reported matches pinned target → alias-resolved', () => {
  const decision = verifyProviderIdentity(
    alias,
    { kind: 'reported', reportedModel: 'google/gemini-3.1-pro-preview', responseId: 'r1' },
  );
  assert.equal(decision.verdict, 'alias-resolved');
  assert.equal(decision.executedModel, 'google/gemini-3.1-pro-preview');
});

test('verifyProviderIdentity: alias echo is unverifiable (never happens cleanly)', () => {
  const decision = verifyProviderIdentity(
    alias,
    { kind: 'echo', reportedModel: '~google/gemini-pro-latest', responseId: 'r1' },
  );
  assert.equal(decision.verdict, 'unverifiable');
  assert.equal(decision.executedModel, null);
});

test('verifyProviderIdentity: alias mismatch', () => {
  const decision = verifyProviderIdentity(
    alias,
    { kind: 'reported', reportedModel: 'google/gemini-3.2-pro-preview', responseId: 'r1' },
  );
  assert.equal(decision.verdict, 'mismatch');
  assert.equal(decision.executedModel, 'google/gemini-3.2-pro-preview');
});

test('verifyProviderIdentity: absent on scripted/test transports', () => {
  const decision = verifyProviderIdentity(
    nonAlias,
    { kind: 'absent', reportedModel: null, responseId: null },
  );
  assert.equal(decision.verdict, 'unverifiable');
  assert.equal(decision.executedModel, null);
});

test('ProviderIdentityTracker: empty summary', () => {
  const tracker = new ProviderIdentityTracker();
  const summary = tracker.summary();
  assert.equal(summary.identityVerdict, 'absent');
  assert.equal(summary.turnsVerified, 0);
  assert.equal(summary.providerReportedModel, null);
  assert.equal(summary.executedModel, null);
});

test('ProviderIdentityTracker: aggregates matching turns', () => {
  const tracker = new ProviderIdentityTracker();
  for (let i = 0; i < 3; i++) {
    tracker.record({
      turnIndex: i,
      reported: { kind: 'reported', reportedModel: 'google/gemini-3.1-pro-preview', responseId: `r${i}` },
      decision: verifyProviderIdentity(alias, { kind: 'reported', reportedModel: 'google/gemini-3.1-pro-preview', responseId: `r${i}` }),
    });
  }
  const summary = tracker.summary();
  assert.equal(summary.identityVerdict, 'alias-resolved');
  assert.equal(summary.turnsVerified, 3);
  assert.equal(summary.turnsReported, 3);
  assert.deepEqual(summary.distinctReportedModels, ['google/gemini-3.1-pro-preview']);
  assert.equal(summary.providerReportedModel, 'google/gemini-3.1-pro-preview');
  assert.equal(summary.executedModel, 'google/gemini-3.1-pro-preview');
  assert.equal(summary.firstResponseId, 'r0');
  assert.equal(summary.lastResponseId, 'r2');
});

test('ProviderIdentityTracker: mismatch dominates verdict', () => {
  const tracker = new ProviderIdentityTracker();
  tracker.record({
    turnIndex: 0,
    reported: { kind: 'reported', reportedModel: 'google/gemini-3.1-pro-preview', responseId: 'r0' },
    decision: verifyProviderIdentity(alias, { kind: 'reported', reportedModel: 'google/gemini-3.1-pro-preview', responseId: 'r0' }),
  });
  tracker.record({
    turnIndex: 1,
    reported: { kind: 'reported', reportedModel: 'google/gemini-3.2-pro-preview', responseId: 'r1' },
    decision: verifyProviderIdentity(alias, { kind: 'reported', reportedModel: 'google/gemini-3.2-pro-preview', responseId: 'r1' }),
  });
  const summary = tracker.summary();
  assert.equal(summary.identityVerdict, 'mismatch');
  assert.equal(summary.turnsVerified, 2);
  assert.deepEqual(summary.distinctReportedModels.sort(), ['google/gemini-3.1-pro-preview', 'google/gemini-3.2-pro-preview']);
  assert.equal(summary.providerReportedModel, null);
  assert.equal(summary.executedModel, 'google/gemini-3.2-pro-preview');
  assert.ok(summary.mismatchDetail?.includes('reported'));
});

test('ProviderIdentityMismatchError carries fields', () => {
  const err = new ProviderIdentityMismatchError({
    reason: 'identity_mismatch',
    expectedModel: 'a',
    reportedModel: 'b',
    requestedWireId: '~x/y',
    turnIndex: 2,
    isAlias: true,
    responseId: 'r1',
  });
  assert.equal(err.name, 'ProviderIdentityMismatchError');
  assert.equal(err.reason, 'identity_mismatch');
  assert.equal(err.turnIndex, 2);
  assert.ok(err.message.includes('expected=a'));
  assert.ok(err.message.includes('reported=b'));
});
