import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseCommandArgv, parsedCommandFromArgv, type ParsedCommand } from './command-argv.ts';
import {
  FOREGROUND_WAIT_FLOOR_SECONDS,
  classifyForegroundWait,
  describeWaitGuardRefusal,
} from './command-wait-guard.ts';

function parsed(argv: string[]): ParsedCommand {
  const result = parsedCommandFromArgv(argv);
  assert.ok(result, `could not build ParsedCommand for ${argv.join(' ')}`);
  return result;
}

describe('classifyForegroundWait', () => {
  // protects: polling shapes (sleep/watch/timeout tail -f) draining native budgets
  const refused: Array<[string[], string]> = [
    [['sleep', '60'], 'sleep'],
    [['sleep', '5'], 'sleep'],
    [['sleep', '1m'], 'sleep'],
    [['sleep', '2h'], 'sleep'],
    [['sleep', '60s'], 'sleep'],
    [['sleep', '3', '3'], 'sleep'],
    [['sleep', 'infinity'], 'sleep'],
    [['sleep', 'inf'], 'sleep'],
    [['/bin/sleep', '30'], 'sleep'],
    [['watch', 'gh', 'pr', 'checks'], 'watch'],
    [['watch'], 'watch'],
    [['timeout', '60', 'tail', '-f', 'log'], 'tail-f-timeout'],
    [['timeout', '60', 'tail', '-F', 'log'], 'tail-f-timeout'],
    [['timeout', '60', 'tail', '--follow=name', 'log'], 'tail-f-timeout'],
    [['timeout', '-s', 'KILL', '60', 'tail', '-fn', '20', 'log'], 'tail-f-timeout'],
    [['timeout', '120', 'sleep', '60'], 'sleep'],
  ];
  for (const [argv, kind] of refused) {
    it(`refuses ${argv.join(' ')}`, () => {
      const decision = classifyForegroundWait(parsed(argv));
      assert.equal(decision.refused, true);
      assert.equal(decision.refused && decision.kind, kind);
    });
  }

  // protects: false positives on short sleeps, "sleep" as a quoted argument, etc.
  const allowed: string[][] = [
    ['sleep', '1'],
    ['sleep', '0.5'],
    ['sleep', '4.9'],
    ['sleep'],
    ['sleep', 'abc'],
    ['timeout', '60', 'tail', '-n', '10', 'log'],
    ['timeout', '60', 'npm', 'test'],
    ['tail', '-f', 'log'],
    ['npm', 'test'],
    ['gh', 'pr', 'checks', '--watch=false'],
    ['echo', 'sleep 60'],
  ];
  for (const argv of allowed) {
    it(`allows ${argv.join(' ')}`, () => {
      assert.deepEqual(classifyForegroundWait(parsed(argv)), { refused: false });
    });
  }

  it('refuses exactly at the floor', () => {
    assert.equal(FOREGROUND_WAIT_FLOOR_SECONDS, 5);
    assert.equal(classifyForegroundWait(parsed(['sleep', '5'])).refused, true);
    assert.equal(classifyForegroundWait(parsed(['sleep', '4'])).refused, false);
  });

  it('honours a custom floor', () => {
    assert.equal(classifyForegroundWait(parsed(['sleep', '5']), { floorSeconds: 10 }).refused, false);
  });

  // protects: a quoted "sleep 60" being refused as the wait kind
  it('classifies parsed argv, not the raw string', () => {
    const result = parseCommandArgv('echo "sleep 60"');
    assert.ok(result.ok);
    assert.deepEqual(classifyForegroundWait(result.parsed), { refused: false });
  });
});

describe('describeWaitGuardRefusal', () => {
  // protects: refusal detail text drifting (consumed in message rendering)
  it('summarises each refusal kind without echoing argv', () => {
    assert.equal(describeWaitGuardRefusal(classifyForegroundWait(parsed(['sleep', '1m']))), 'sleep 60s (>= 5s floor)');
    assert.equal(describeWaitGuardRefusal(classifyForegroundWait(parsed(['sleep', 'inf']))), 'sleep infinity (>= 5s floor)');
    assert.equal(describeWaitGuardRefusal(classifyForegroundWait(parsed(['watch', 'secret-token']))), 'watch');
    assert.equal(
      describeWaitGuardRefusal(classifyForegroundWait(parsed(['timeout', '9', 'tail', '-f', 'x']))),
      'timeout + tail -f',
    );
    assert.equal(describeWaitGuardRefusal({ refused: false }), '');
  });
});
