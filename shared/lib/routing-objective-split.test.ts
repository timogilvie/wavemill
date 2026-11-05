import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveRoutingObjectiveForIssue } from './routing-objective-split.ts';

// protects: routing-objective experiment arms becoming materially imbalanced.
test('assigns approximately half of issue IDs to each objective', () => {
  const objectives = Array.from({ length: 1000 }, (_, index) => deriveRoutingObjectiveForIssue(`HOK-${index + 1}`));
  const lowestCost = objectives.filter((objective) => objective === 'lowest_cost').length;

  assert.ok(lowestCost >= 300 && lowestCost <= 700, `lowest_cost count ${lowestCost} is outside the 50% ±20% band`);
});

// protects: challenge arms drifting to a different routing objective than their primary.
test('assigns challenge arms the same objective as their primary', () => {
  assert.equal(deriveRoutingObjectiveForIssue('HOK-123'), deriveRoutingObjectiveForIssue('HOK-123_c'));
});

// protects: re-routes changing a task's assigned experiment arm.
test('is deterministic for a valid task ID', () => {
  assert.equal(deriveRoutingObjectiveForIssue('HOK-123'), deriveRoutingObjectiveForIssue('HOK-123'));
});

// protects: malformed task IDs being assigned an arbitrary routing objective.
test('fails closed for an unparseable task ID', () => {
  assert.equal(deriveRoutingObjectiveForIssue('hok-123'), undefined);
});
