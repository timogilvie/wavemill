import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { scanForPrTaskLookups } from './pr-task-lookup-checker.ts';

describe('pr-task-lookup-checker', () => {
  describe('scanForPrTaskLookups', () => {
    it('detects task.pr === x pattern inside a .tasks loop', () => {
      const content = `
function example() {
  for (const [taskId, task] of workflowTaskEntries(state)) {
    if (task.pr === prNumber) {
      return taskId;
    }
  }
}
`;
      const findings = scanForPrTaskLookups('test.ts', content);
      assert.equal(findings.length, 1);
      assert.equal(findings[0].line, 4);
      assert.equal(findings[0].pattern, 'inline-task-pr-match');
    });

    it('detects String(task.pr) === x pattern', () => {
      const content = `
for (const [id, task] of workflowTaskEntries(state)) {
  if (String(task.pr) === String(prNumber)) {
    return id;
  }
}
`;
      const findings = scanForPrTaskLookups('test.ts', content);
      assert.equal(findings.length, 1);
      assert.equal(findings[0].pattern, 'inline-task-pr-match');
    });

    it('detects task.branch === x pattern', () => {
      const content = `
for (const [taskId, task] of workflowTaskEntries(state)) {
  if (task.branch === branch) {
    return taskId;
  }
}
`;
      const findings = scanForPrTaskLookups('test.ts', content);
      assert.equal(findings.length, 1);
      assert.equal(findings[0].pattern, 'inline-task-branch-match');
    });

    it('detects id === opts.taskId pattern', () => {
      const content = `
for (const [id, task] of workflowTaskEntries(state)) {
  if (id === opts.taskId) {
    return task;
  }
}
`;
      const findings = scanForPrTaskLookups('test.ts', content);
      assert.equal(findings.length, 1);
      assert.equal(findings[0].pattern, 'inline-task-key-match');
    });

    it('detects taskId === taskId pattern', () => {
      const content = `
for (const [taskId, task] of workflowTaskEntries(state)) {
  if (taskId === options.taskId) {
    return task;
  }
}
`;
      const findings = scanForPrTaskLookups('test.ts', content);
      assert.equal(findings.length, 1);
      assert.equal(findings[0].pattern, 'inline-task-key-match');
    });

    it('does not detect task.phase === "ready" filter', () => {
      const content = `
for (const [taskId, task] of workflowTaskEntries(state)) {
  if (task.phase === 'ready') {
    results.push(task);
  }
}
`;
      const findings = scanForPrTaskLookups('test.ts', content);
      assert.equal(findings.length, 0);
    });

    it('does not detect task.challengePairId === x filter', () => {
      const content = `
for (const [taskId, task] of workflowTaskEntries(state)) {
  if (task.challengePairId === pairId) {
    return task;
  }
}
`;
      const findings = scanForPrTaskLookups('test.ts', content);
      assert.equal(findings.length, 0);
    });

    it('does not detect Object.values(.tasks) iteration outside resolver scope', () => {
      const content = `
const allTasks = Object.values(state.tasks).filter(t => t.phase === 'done');
`;
      const findings = scanForPrTaskLookups('test.ts', content);
      assert.equal(findings.length, 0);
    });

    it('handles t as shorthand for task variable', () => {
      const content = `
for (const [key, t] of workflowTaskEntries(state)) {
  if (t.pr === prNumber) {
    return key;
  }
}
`;
      const findings = scanForPrTaskLookups('test.ts', content);
      assert.equal(findings.length, 1);
      assert.equal(findings[0].pattern, 'inline-task-pr-match');
    });

    it('reports correct line and column numbers', () => {
      const content = `function test() {
  for (const [id, task] of workflowTaskEntries(state)) {
    if (task.pr === prNumber) { return id; }
  }
}`;
      const findings = scanForPrTaskLookups('test.ts', content);
      assert.equal(findings.length, 1);
      assert.equal(findings[0].line, 3);
      assert(findings[0].column > 0);
    });

    it('detects multiple patterns in same function', () => {
      const content = `
for (const [id, task] of workflowTaskEntries(state)) {
  if (task.pr === prNumber) {
    return id;
  }
  if (task.branch === branch) {
    return id;
  }
}
`;
      const findings = scanForPrTaskLookups('test.ts', content);
      assert.equal(findings.length, 2);
    });
  });
});
