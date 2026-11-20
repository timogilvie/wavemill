import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { checkGuardSource } from './lib/source-guard.ts';
import { COMPLETION_GATE_GUARD } from '../shared/lib/completion-gate-guard.ts';

const MUTATION_TOOLS = 'shared/lib/native-agent/tools/mutation-tools.ts';

const canonical = [
  'async function executeWholeFileWrite(tool, worktreePath, targetPath, content, options) {',
  '  const refusal = codingCompleteGateRefusal(worktreePath, targetPath, options);',
  '  if (refusal) return refusal;',
  '  atomicWriteText(targetPath, content);',
  '}',
  '',
  'function codingCompleteGateRefusal(worktreePath, markerPath, options) {',
  '  return evaluateCodingCompletionGate({ dirtyPaths: [], commitPolicySatisfied: true, checksPolicySatisfied: true });',
  '}',
  '',
].join('\n');

describe('check-completion-gate guard', () => {
  // protects: HOK-3514 — the canonical marker write path reaches the gate.
  it('accepts the canonical gated write path', () => {
    assert.deepEqual(checkGuardSource(COMPLETION_GATE_GUARD, MUTATION_TOOLS, canonical), []);
  });

  // protects: HOK-3514 — dropping the gate call from the marker write path fails preflight.
  it('fires when executeWholeFileWrite no longer calls the gate', () => {
    const bypass = canonical.replace('  const refusal = codingCompleteGateRefusal(worktreePath, targetPath, options);\n  if (refusal) return refusal;\n', '');
    const findings = checkGuardSource(COMPLETION_GATE_GUARD, MUTATION_TOOLS, bypass);
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.pattern, 'marker-write-bypasses-gate');
    assert.equal(findings[0]!.line, 1);
  });

  // protects: HOK-3514 — a second create_marker tool would bypass the gate.
  it('fires on a create_marker descriptor outside mutation-tools.ts', () => {
    const source = [
      'export const tool = {',
      '  metadata: {',
      "    name: 'create_marker',",
      "    class: 'mutation',",
      '  },',
      '};',
      '',
    ].join('\n');
    const findings = checkGuardSource(COMPLETION_GATE_GUARD, 'shared/lib/native-agent/tools/other.ts', source);
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.pattern, 'second-marker-tool');
    assert.equal(findings[0]!.line, 2);
  });

  it('ignores scripted tool calls that merely name create_marker', () => {
    const source = "const turn = { type: 'tool_call', id: 'x', name: 'create_marker', arguments: {} };\n";
    assert.deepEqual(checkGuardSource(COMPLETION_GATE_GUARD, 'shared/lib/native-agent/fixtures/session.ts', source), []);
  });
});
