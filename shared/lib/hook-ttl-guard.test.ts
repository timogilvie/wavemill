import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkGuardSource, formatGuardResult, runSourceGuard } from '../../tools/lib/source-guard.ts';
import { AGENT_BACKGROUND_WORK_GUARD, findNameMatchInsideDerive, HOOK_TTL_GUARD } from './hook-ttl-guard.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const patternsOf = (file: string, source: string) =>
  checkGuardSource(HOOK_TTL_GUARD, file, source).map((finding) => finding.pattern);

const patternsOfBg = (file: string, source: string) =>
  checkGuardSource(AGENT_BACKGROUND_WORK_GUARD, file, source).map((finding) => finding.pattern);

/** Wrap a would-be derivation body in a column-0 `deriveAgentBackgroundWork`. */
const deriveFixture = (body: string): string => [
  'export interface PaneProcess { pid: number; ppid: number; etimeSeconds: number | null; command: string }',
  'export function deriveAgentBackgroundWork(processes: PaneProcess[], agentPid: number) {',
  ...body.split('\n').map((line) => `  ${line}`),
  '}',
  '',
].join('\n');

describe('hook-ttl guard — forbidden shapes', () => {
  it('flags the TTL constant outside the primitive', () => {
    assert.deepEqual(patternsOf('a.sh', '(( age < WAVEMILL_HOOK_TTL_SECONDS ))\n'), ['hook-ttl-constant']);
    assert.deepEqual(patternsOf('a.ts', "import { HOOK_TTL_SECONDS } from './task-progress.ts';\n"), ['hook-ttl-constant']);
  });

  it('flags a raw jq timestamp read from a hook file', () => {
    assert.deepEqual(patternsOf('a.sh', 'hook_ts=$(jq -r \'.timestamp // 0\' "$hook_file" 2>/dev/null || echo 0)\n'), ['raw-hook-timestamp-read']);
    assert.deepEqual(patternsOf('a.sh', 'ts=$(jq -r \'.agentRecord.timestamp // 0\' "$hook" )\n'), ['raw-hook-timestamp-read']);
  });

  it('flags a hard-coded 300s freshness comparison', () => {
    assert.deepEqual(patternsOf('a.sh', '(( now - hook_ts < 300 )) || return 0\n'), ['hook-ttl-literal']);
    assert.deepEqual(patternsOf('a.sh', 'if (( staleness < 300 )); then\n'), ['hook-ttl-literal']);
    assert.deepEqual(patternsOf('a.sh', '[[ $hook_age -lt 300 ]] && echo fresh\n'), ['hook-ttl-literal']);
    assert.deepEqual(patternsOf('a.ts', 'const fresh = nowMs - hook.timestamp * 1000 < 300_000;\n'), ['hook-ttl-literal']);
  });
});

describe('hook-ttl guard — clean shapes', () => {
  it('ignores the primitive accessors and unrelated 300s', () => {
    const source = [
      'state=$(wavemill_hook_read "$SESSION" "$issue" state --fresh)',
      'progress=$(task_progress_json "$issue")',
      'jq -r \'.timestamp\' "$event_log"',
      'sleep 300',
      '(( elapsed < 300 ))',
      '',
    ].join('\n');
    assert.deepEqual(patternsOf('a.sh', source), []);
    assert.deepEqual(patternsOf('a.ts', 'const progress = getTaskProgress(opts);\nconst timeoutMs = 300;\n'), []);
  });

  it('honours the allow-hook-ttl suppression', () => {
    assert.deepEqual(patternsOf('a.sh', '# allow-hook-ttl: standalone fallback\n(( now - hook_ts < 300 ))\n'), []);
  });
});

describe('hook-ttl guard — repository', () => {
  it('passes at HEAD with the seeded count ratchet', () => {
    const result = runSourceGuard(HOOK_TTL_GUARD, repoRoot);
    assert.deepEqual(result.findings, [], formatGuardResult(HOOK_TTL_GUARD, result));
  });
});

describe('agent-background-work guard — deleted classifier symbols (HOK-3374)', () => {
  it('flags every deleted HOK-3222 classifier symbol', () => {
    for (const symbol of [
      'NEUTRAL_PROCESS_BASENAME_REGEX',
      'isNeutralProcessCommand',
      'classifyPaneProcess',
      'PaneProcessClass',
      'findSubstantiveAncestor',
    ]) {
      assert.deepEqual(patternsOfBg('shared/lib/task-progress.ts', `const x = ${symbol};\n`), ['deleted-classification-symbol'], symbol);
    }
  });

  it('ignores whole-line comments naming the deleted symbols, and keeps isWavemillControllerProcess legal outside the derivation', () => {
    assert.deepEqual(patternsOfBg('a.ts', '// the old classifyPaneProcess is retired\n'), []);
    assert.deepEqual(patternsOfBg('tools/observer.ts', 'if (isWavemillControllerProcess(command)) return false;\n'), []);
  });

  it('honours the allow-agent-background-work suppression', () => {
    assert.deepEqual(
      patternsOfBg('a.ts', '// allow-agent-background-work: documented shell twin\nconst x = classifyPaneProcess;\n'),
      [],
    );
  });
});

describe('agent-background-work guard — deriveAgentBackgroundWork body (structural)', () => {
  it('flags controller-regex use inside the derivation', () => {
    const matches = findNameMatchInsideDerive(
      deriveFixture("return isWavemillControllerProcess(cmd) ? { live: false, processes: [] } : owned();"),
    );
    assert.equal(matches.length, 1);
    assert.equal(matches[0].line, 3);
    assert.match(matches[0].detail ?? '', /controller-regex use/);
  });

  it('flags command-name matching on a command/argv field inside the derivation', () => {
    for (const line of ['return p.command.test(/x/);', 'return p.command.match(/x/);', 'return p.argv.exec(0);']) {
      const matches = findNameMatchInsideDerive(deriveFixture(line));
      assert.equal(matches.length, 1, line);
      assert.match(matches[0].detail ?? '', /command-name matching/);
    }
  });

  it('flags process IO inside the derivation', () => {
    const matches = findNameMatchInsideDerive(deriveFixture("return safeExecFile('ps', ['-axo']);"));
    assert.equal(matches.length, 1);
    assert.match(matches[0].detail ?? '', /no process IO/);
  });

  it('flags a second subtree index (a second probe) but not the first', () => {
    const one = findNameMatchInsideDerive(deriveFixture('const children = new Map<number, PaneProcess[]>();'));
    assert.deepEqual(one, []);
    const two = findNameMatchInsideDerive(
      deriveFixture('const a = new Map<number, PaneProcess[]>();\nconst b = new Map<number, PaneProcess[]>();'),
    );
    assert.equal(two.length, 1);
    assert.equal(two[0].line, 4); // anchored at the second construction
    assert.match(two[0].detail ?? '', /second probe/);
  });

  it('does not flag the ownership-only body (one index, plain field reads)', () => {
    const src = deriveFixture([
      'const children = new Map<number, PaneProcess[]>();',
      "evidence.push({ pid: child.pid, command: child.command.slice(0, 200) });",
      'return { live, processes: evidence };',
    ].join('\n'));
    assert.deepEqual(findNameMatchInsideDerive(src), []);
  });

  it('honours the allow-agent-background-work suppression on the finding line or the line above', () => {
    const above = checkGuardSource(
      AGENT_BACKGROUND_WORK_GUARD,
      'shared/lib/task-progress.ts',
      deriveFixture('// allow-agent-background-work: shell-parity note\nreturn isWavemillControllerProcess(cmd);'),
    );
    assert.deepEqual(above, []);
    const unmarked = checkGuardSource(
      AGENT_BACKGROUND_WORK_GUARD,
      'shared/lib/task-progress.ts',
      deriveFixture('return isWavemillControllerProcess(cmd);'),
    );
    assert.equal(unmarked.length, 1);
    assert.equal(unmarked[0].pattern, 'name-match-inside-derive');
  });
});

describe('agent-background-work guard — repository', () => {
  it('passes at HEAD: the derivation is ownership-only and no classifier symbol remains', () => {
    const result = runSourceGuard(AGENT_BACKGROUND_WORK_GUARD, repoRoot);
    assert.deepEqual(result.findings, [], formatGuardResult(AGENT_BACKGROUND_WORK_GUARD, result));
  });
});
