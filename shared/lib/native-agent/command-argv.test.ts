import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseCommandArgv, parsedCommandFromArgv } from './command-argv.ts';

describe('parseCommandArgv', () => {
  // protects: argv tokenisation drifting away from POSIX quoting rules
  it('splits spaces and tabs', () => {
    const parsed = parseCommandArgv('npm   test\t--silent');
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.parsed.argv, ['npm', 'test', '--silent']);
    assert.equal(parsed.parsed.program, 'npm');
    assert.deepEqual(parsed.parsed.programArgs, ['test', '--silent']);
  });

  it('groups and strips double quotes', () => {
    const parsed = parseCommandArgv(`node -e "process.stdout.write('x')"`);
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.parsed.argv, ['node', '-e', "process.stdout.write('x')"]);
    assert.equal(parsed.parsed.program, 'node');
  });

  it('keeps single-quoted content literal', () => {
    const parsed = parseCommandArgv(`cmd '$HOME \\" x'`);
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.parsed.argv, ['cmd', '$HOME \\" x']);
  });

  it('handles backslash escaping', () => {
    const parsed = parseCommandArgv(`cmd a\\ b "q\\" \\\\ \\n"`);
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.parsed.argv, ['cmd', 'a b', 'q" \\ \\n']);
  });

  it('concatenates quoted segments and preserves empty quoted words', () => {
    const parsed = parseCommandArgv(`cmd --grep="a b"c x '' y`);
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.parsed.argv, ['cmd', '--grep=a bc', 'x', '', 'y']);
  });

  for (const [command, detail] of [
    ['touch x && echo created', '&&'],
    ['a || b', '||'],
    ['ls | cat', '|'],
    ['sleep 1; echo done', ';'],
    ['sleep 1 &', '&'],
    ['echo x > out', '>'],
    ['echo x >> out', '>>'],
    ['cat < in', '<'],
    ['node x 2>&1', '2>&1'],
    ['node x &> out', '&>'],
    ['echo a\n echo b', 'newline'],
  ] as const) {
    it(`rejects unsupported shell syntax ${detail}`, () => {
      const parsed = parseCommandArgv(command);
      assert.equal(parsed.ok, false);
      if (!parsed.ok) {
        assert.equal(parsed.detail, detail);
      }
    });
  }

  it('allows quoted operators as data', () => {
    const parsed = parseCommandArgv(`cmd --grep "a && b"`);
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.parsed.argv, ['cmd', '--grep', 'a && b']);
  });

  for (const command of ['$HOME', 'echo $(pwd)', '`pwd`', `echo "$HOME"`]) {
    it(`rejects expansions in ${command}`, () => {
      const parsed = parseCommandArgv(command);
      assert.equal(parsed.ok, false);
      if (!parsed.ok) {
        assert.match(parsed.detail, /\$|`/);
      }
    });
  }

  it('allows single-quoted dollars literally', () => {
    const parsed = parseCommandArgv(`echo '$HOME'`);
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.parsed.argv, ['echo', '$HOME']);
  });

  it('rejects unterminated quotes', () => {
    for (const command of [`"abc`, `'abc`]) {
      const parsed = parseCommandArgv(command);
      assert.equal(parsed.ok, false);
      if (!parsed.ok) {
        assert.equal(parsed.detail, 'unterminated quote');
      }
    }
  });

  it('rejects leading environment assignments only', () => {
    assert.equal(parseCommandArgv('CI=1 npm test').ok, false);
    const parsed = parseCommandArgv('npm test --foo=bar cmd A=b');
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.parsed.argv, ['npm', 'test', '--foo=bar', 'cmd', 'A=b']);
  });

  it('passes documented non-shell metacharacters literally', () => {
    const node = parseCommandArgv('node -e process.exit(0)');
    assert.ok(node.ok);
    assert.deepEqual(node.parsed.argv, ['node', '-e', 'process.exit(0)']);
    const vitest = parseCommandArgv('vitest run src/**/*.test.ts');
    assert.ok(vitest.ok);
    assert.deepEqual(vitest.parsed.argv, ['vitest', 'run', 'src/**/*.test.ts']);
  });

  it('rejects the junk-file repro', () => {
    const parsed = parseCommandArgv('touch /tmp/x && echo created');
    assert.equal(parsed.ok, false);
    if (!parsed.ok) {
      assert.equal(parsed.detail, '&&');
    }
  });

  describe('HOK-3383: shell-interpreter wrapper rejection', () => {
    // protects: `bash -c '…'` sneaking a nested shell script past the parser
    for (const command of [
      `bash -c 'npm test'`,
      `sh -c "bash tests/run-unit-tests.sh"`,
      `zsh -lc 'echo hi'`,
      `dash -c 'echo hi'`,
      `bash -lc 'sleep 60'`,
      `env bash -lc 'sleep 60'`,
      `env /usr/bin/bash -c 'echo hi'`,
      `/bin/bash -c 'echo hi'`,
      `bash --login -c 'echo hi'`,
    ]) {
      it(`refuses ${command}`, () => {
        const parsed = parseCommandArgv(command);
        assert.equal(parsed.ok, false, `expected refusal for: ${command}`);
        if (!parsed.ok) {
          assert.equal(parsed.reason, 'unsupported-shell-syntax');
          assert.equal(parsed.detail, 'shell interpreter wrapper');
        }
      });
    }

    // protects: direct script invocations being miscategorised as wrappers
    for (const command of [
      `bash tests/run-related.sh`,
      `bash tests/run-unit-tests.sh --shard 1/4`,
      `sh tests/foo.test.sh`,
      `/bin/bash tests/foo.test.sh`,
      `node script.js`,
      `env node tests/foo.test.js`,
    ]) {
      it(`allows ${command}`, () => {
        const parsed = parseCommandArgv(command);
        assert.ok(parsed.ok, `expected ok for: ${command}`);
      });
    }

    // protects: a `-c` positional arg passed to a script being flagged as -c option
    it(`treats -c after a script argument as a positional arg, not a shell option`, () => {
      const parsed = parseCommandArgv(`bash tests/foo.test.sh -c arg`);
      assert.ok(parsed.ok);
      assert.deepEqual(parsed.parsed.argv, ['bash', 'tests/foo.test.sh', '-c', 'arg']);
    });
  });

  describe('HOK-3383: program resolution', () => {
    // protects: downstream guards reading argv[0] directly instead of parsed.program
    it('resolves program basename from a bare command', () => {
      const parsed = parseCommandArgv('npm test');
      assert.ok(parsed.ok);
      assert.equal(parsed.parsed.program, 'npm');
      assert.deepEqual(parsed.parsed.programArgs, ['test']);
    });

    it('resolves program basename from an absolute path', () => {
      const parsed = parseCommandArgv('/usr/local/bin/node -v');
      assert.ok(parsed.ok);
      assert.equal(parsed.parsed.program, 'node');
      assert.deepEqual(parsed.parsed.programArgs, ['-v']);
    });

    it('resolves program through env', () => {
      const parsed = parseCommandArgv('env node x.js');
      assert.ok(parsed.ok);
      assert.equal(parsed.parsed.program, 'node');
      assert.deepEqual(parsed.parsed.programArgs, ['x.js']);
    });

    it('resolves program through env with -u / --chdir options', () => {
      const parsed = parseCommandArgv('env -u FOO --chdir /tmp node x.js');
      assert.ok(parsed.ok);
      assert.equal(parsed.parsed.program, 'node');
      assert.deepEqual(parsed.parsed.programArgs, ['x.js']);
    });

    it('refuses env with no program', () => {
      const parsed = parseCommandArgv('env -u FOO');
      assert.equal(parsed.ok, false);
      if (!parsed.ok) {
        assert.equal(parsed.detail, 'env missing a program');
      }
    });

    it('is not fooled by envsubst named like env', () => {
      const parsed = parseCommandArgv('envsubst < in');
      // envsubst stays non-env; the redirect < would normally reject this.
      assert.equal(parsed.ok, false);
    });
  });
});

describe('parsedCommandFromArgv', () => {
  it('resolves a plain argv', () => {
    const parsed = parsedCommandFromArgv(['node', '-e', 'process.exit(0)']);
    assert.ok(parsed);
    assert.equal(parsed.program, 'node');
    assert.deepEqual(parsed.programArgs, ['-e', 'process.exit(0)']);
  });

  it('resolves through env in the slice', () => {
    const parsed = parsedCommandFromArgv(['env', 'node', 'x.js']);
    assert.ok(parsed);
    assert.equal(parsed.program, 'node');
    assert.deepEqual(parsed.programArgs, ['x.js']);
  });

  it('returns null for a shell wrapper', () => {
    assert.equal(parsedCommandFromArgv(['bash', '-c', 'echo hi']), null);
    assert.equal(parsedCommandFromArgv(['env', 'bash', '-lc', 'sleep 60']), null);
  });

  it('returns null for an empty slice', () => {
    assert.equal(parsedCommandFromArgv([]), null);
  });
});
