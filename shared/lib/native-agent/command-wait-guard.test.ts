import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseCommandArgv } from './command-argv.ts';
import {
  FOREGROUND_WAIT_FLOOR_SECONDS,
  classifyForegroundWait,
  describeWaitGuardRefusal,
} from './command-wait-guard.ts';

describe('classifyForegroundWait', () => {
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
      const decision = classifyForegroundWait(argv);
      assert.equal(decision.refused, true);
      assert.equal(decision.refused && decision.kind, kind);
    });
  }

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
    [],
  ];
  for (const argv of allowed) {
    it(`allows ${argv.join(' ') || '(empty)'}`, () => {
      assert.deepEqual(classifyForegroundWait(argv), { refused: false });
    });
  }

  it('refuses exactly at the floor', () => {
    assert.equal(FOREGROUND_WAIT_FLOOR_SECONDS, 5);
    assert.equal(classifyForegroundWait(['sleep', '5']).refused, true);
    assert.equal(classifyForegroundWait(['sleep', '4']).refused, false);
  });

  it('honours a custom floor', () => {
    assert.equal(classifyForegroundWait(['sleep', '5'], { floorSeconds: 10 }).refused, false);
  });

  it('classifies parsed argv, not the raw string', () => {
    const parsed = parseCommandArgv('echo "sleep 60"');
    assert.ok(parsed.ok);
    assert.deepEqual(classifyForegroundWait(parsed.argv), { refused: false });
  });
});

describe('describeWaitGuardRefusal', () => {
  it('summarises each refusal kind without echoing argv', () => {
    assert.equal(describeWaitGuardRefusal(classifyForegroundWait(['sleep', '1m'])), 'sleep 60s (>= 5s floor)');
    assert.equal(describeWaitGuardRefusal(classifyForegroundWait(['sleep', 'inf'])), 'sleep infinity (>= 5s floor)');
    assert.equal(describeWaitGuardRefusal(classifyForegroundWait(['watch', 'secret-token'])), 'watch');
    assert.equal(
      describeWaitGuardRefusal(classifyForegroundWait(['timeout', '9', 'tail', '-f', 'x'])),
      'timeout + tail -f',
    );
    assert.equal(describeWaitGuardRefusal({ refused: false }), '');
  });
});
