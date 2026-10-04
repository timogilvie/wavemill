import { test } from 'node:test';
import { strictEqual, deepStrictEqual, ok } from 'node:assert';
import {
  captureReplayIncident,
  markInstanceReady,
  markInstanceDraft,
} from './challenge-replay-capture.ts';
import type { IncidentRecord } from './wavemill-incident-model.ts';

const createTestIncident = (): IncidentRecord => ({
  id: 'test-id',
  schemaVersion: '1.1',
  fingerprint: 'test-fingerprint-12345678',
  category: 'model_task_harness_outcome',
  rootCauseClass: 'tool_stagnation',
  severity: 'high',
  confidence: 'high',
  taskId: 'task-123',
  occurrenceCount: 1,
  firstObservedAt: new Date().toISOString(),
  lastObservedAt: new Date().toISOString(),
  lifecycle: 'resolved',
  evidence: [
    {
      type: 'log_excerpt',
      source: 'task_log',
      timestamp: new Date().toISOString(),
      redactedData: 'Tool call failed',
    },
  ],
  metadata: {
    seenEventKeys: [],
  },
});

test('captureReplayIncident: creates instance with good/bad patches', () => {
  const incident = createTestIncident();
  const badPatch = 'diff --git a/file.js b/file.js\n--- a/file.js\n+++ b/file.js\n@@ -1 +1 @@\n-wrong\n+bad';
  const goodPatch = 'diff --git a/file.js b/file.js\n--- a/file.js\n+++ b/file.js\n@@ -1 +1 @@\n-wrong\n+good';

  const result = captureReplayIncident({
    incident,
    badPatchContent: badPatch,
    goodPatchContent: goodPatch,
    taskTitle: 'Test fix',
    taskDescription: 'A test task',
  });

  strictEqual(result.isComplete, true);
  strictEqual(result.missingFields.length, 0);
  strictEqual(result.instance.candidates.length, 2);
  strictEqual(result.instance.taskTitle, 'Test fix');
  ok(result.instance.id.includes('incident-'));
});

test('captureReplayIncident: missing patches marks as incomplete', () => {
  const incident = createTestIncident();

  const result = captureReplayIncident({
    incident,
    taskTitle: 'Test',
    taskDescription: 'Test description',
  });

  strictEqual(result.isComplete, false);
  strictEqual(result.missingFields.length, 2);
  strictEqual(result.missingFields.includes('badPatchContent'), true);
  strictEqual(result.missingFields.includes('goodPatchContent'), true);
});

test('captureReplayIncident: single evidence patch is not reused as good and bad', () => {
  const incident = {
    ...createTestIncident(),
    evidence: [
      {
        type: 'diff' as const,
        source: 'failed_patch',
        timestamp: new Date().toISOString(),
        redactedData: 'diff --git a/file.ts b/file.ts\n@@ -1 +1 @@\n-bad\n+still-bad',
      },
    ],
  };

  const result = captureReplayIncident({
    incident,
    taskTitle: 'Test',
    taskDescription: 'Test description',
  });

  strictEqual(result.isComplete, false);
  strictEqual(result.missingFields.includes('goodPatchContent'), true);
  strictEqual(result.instance.candidates.length, 1);
  strictEqual(result.instance.candidates[0].label, 'known-bad');
});

test('captureReplayIncident: distinct evidence patches can fill bad and good', () => {
  const badPatch = 'diff --git a/file.ts b/file.ts\n@@ -1 +1 @@\n-old\n+bad';
  const goodPatch = 'diff --git a/file.ts b/file.ts\n@@ -1 +1 @@\n-old\n+good';
  const incident = {
    ...createTestIncident(),
    evidence: [
      {
        type: 'diff' as const,
        source: 'failed_patch',
        timestamp: new Date().toISOString(),
        redactedData: badPatch,
      },
      {
        type: 'diff' as const,
        source: 'fixed_patch',
        timestamp: new Date().toISOString(),
        redactedData: goodPatch,
      },
    ],
  };

  const result = captureReplayIncident({
    incident,
    taskTitle: 'Test',
    taskDescription: 'Test description',
  });

  strictEqual(result.isComplete, true);
  strictEqual(result.instance.candidates.length, 2);
  strictEqual(result.instance.candidates[0].patch, badPatch);
  strictEqual(result.instance.candidates[1].patch, goodPatch);
});

test('captureReplayIncident: identical explicit patches are incomplete', () => {
  const incident = createTestIncident();
  const patch = 'diff --git a/file.ts b/file.ts\n@@ -1 +1 @@\n-old\n+same';

  const result = captureReplayIncident({
    incident,
    badPatchContent: patch,
    goodPatchContent: patch,
    taskTitle: 'Test',
    taskDescription: 'Test description',
  });

  strictEqual(result.isComplete, false);
  strictEqual(result.missingFields.includes('distinctGoodAndBadPatchContent'), true);
  strictEqual(result.instance.candidates.length, 1);
});

test('captureReplayIncident: only good patch marks as incomplete', () => {
  const incident = createTestIncident();
  const goodPatch = 'patch content';

  const result = captureReplayIncident({
    incident,
    goodPatchContent: goodPatch,
    taskTitle: 'Test',
    taskDescription: 'Test description',
  });

  strictEqual(result.isComplete, false);
  strictEqual(result.missingFields.includes('badPatchContent'), true);
});

test('captureReplayIncident: missing description marks as incomplete', () => {
  const incident = createTestIncident();
  const badPatch = 'bad patch';
  const goodPatch = 'good patch';

  const result = captureReplayIncident({
    incident,
    badPatchContent: badPatch,
    goodPatchContent: goodPatch,
  });

  strictEqual(result.isComplete, false);
  strictEqual(result.missingFields.includes('taskDescription/taskTitle'), true);
});

test('captureReplayIncident: synthesizes task title from incident', () => {
  const incident = createTestIncident();
  const result = captureReplayIncident({
    incident,
    badPatchContent: 'bad',
    goodPatchContent: 'good',
  });

  ok(result.instance.taskTitle.includes('incident'));
});

test('captureReplayIncident: sets source provenance correctly', () => {
  const incident = createTestIncident();
  const result = captureReplayIncident({
    incident,
    badPatchContent: 'bad',
    goodPatchContent: 'good',
    taskTitle: 'Test',
    taskDescription: 'Test description',
  });

  strictEqual(result.instance.source.incidentFingerprint, incident.fingerprint);
  strictEqual(result.instance.source.curationRationale, 'incident_fix');
  strictEqual(result.instance.source.sanitized, true);
});

test('captureReplayIncident: does not use task id as baseSha fallback', () => {
  const incident = createTestIncident();
  const result = captureReplayIncident({
    incident,
    badPatchContent: 'bad',
    goodPatchContent: 'good',
    taskTitle: 'Test',
    taskDescription: 'Test description',
  });

  strictEqual(result.instance.baseSha, undefined);
});

test('captureReplayIncident: calculates patch sizes', () => {
  const incident = createTestIncident();
  const badPatch = 'bad patch content';
  const goodPatch = 'good patch content';

  const result = captureReplayIncident({
    incident,
    badPatchContent: badPatch,
    goodPatchContent: goodPatch,
    taskTitle: 'Test',
    taskDescription: 'Test',
  });

  const badCandidate = result.instance.candidates.find((c) => c.id.includes('bad'));
  const goodCandidate = result.instance.candidates.find((c) => c.id.includes('good'));

  ok(badCandidate);
  ok(goodCandidate);
  strictEqual(badCandidate!.patchSizeBytes, Buffer.byteLength(badPatch, 'utf8'));
  strictEqual(goodCandidate!.patchSizeBytes, Buffer.byteLength(goodPatch, 'utf8'));
});

test('markInstanceReady: marks instance as ready and updates timestamp', () => {
  const incident = createTestIncident();
  const result = captureReplayIncident({
    incident,
    badPatchContent: 'bad',
    goodPatchContent: 'good',
    taskTitle: 'Test',
    taskDescription: 'Test',
  });

  const readyInstance = markInstanceReady(result.instance, false);

  strictEqual(readyInstance.heldOut, false);
  ok(readyInstance.notes?.includes('marked ready'));
  ok(readyInstance.curatedAt >= result.instance.curatedAt);
});

test('markInstanceReady: can mark as held-out', () => {
  const incident = createTestIncident();
  const result = captureReplayIncident({
    incident,
    badPatchContent: 'bad',
    goodPatchContent: 'good',
    taskTitle: 'Test',
    taskDescription: 'Test',
  });

  const heldOutInstance = markInstanceReady(result.instance, true);

  strictEqual(heldOutInstance.heldOut, true);
});

test('markInstanceDraft: marks instance with reason', () => {
  const incident = createTestIncident();
  const result = captureReplayIncident({
    incident,
    badPatchContent: 'bad',
    goodPatchContent: 'good',
    taskTitle: 'Test',
    taskDescription: 'Test',
  });

  const draftInstance = markInstanceDraft(result.instance, 'waiting for review');

  ok(draftInstance.notes?.includes('draft'));
  ok(draftInstance.notes?.includes('waiting for review'));
});
