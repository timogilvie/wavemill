import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import {
  OPERATOR_TOOLS_INDEX,
  checkOperatorToolsIndex,
  findUnreferencedTools,
  parseOperatorToolsIndex,
  runHelpChecks,
} from './operator-tools-index.ts';

function makeRepo(files: Record<string, string>): string {
  const repoDir = mkdtempSync(join(tmpdir(), 'operator-tools-'));
  execFileSync('git', ['init'], { cwd: repoDir, stdio: 'ignore' });
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repoDir, path)), { recursive: true });
    writeFileSync(join(repoDir, path), content);
  }
  execFileSync('git', ['add', '-A'], { cwd: repoDir });
  return repoDir;
}

describe('parseOperatorToolsIndex', () => {
  // protects: an index row is missed, so a listed tool is never --help checked
  it('reads tool paths from table rows only, in order, and reports duplicates', () => {
    const index = parseOperatorToolsIndex([
      'Mentions `tools/prose.ts` outside a table.',
      '| Tool | What | Writes |',
      '| -- | -- | -- |',
      '| `tools/a.ts` | does a | No |',
      '|  `tools/b.ts`  | does b | No |',
      '| `tools/a.ts` | again | No |',
    ].join('\n'));
    assert.deepEqual(index, { tools: ['tools/a.ts', 'tools/b.ts'], duplicates: ['tools/a.ts'] });
  });
});

describe('findUnreferencedTools', () => {
  // protects: a tool only its own tests mention counts as discoverable and is never indexed
  it('ignores references from tests, fixtures, test registries and the index itself', () => {
    const repoDir = makeRepo({
      'tools/used-by-script.ts': '',
      'tools/used-by-tool.ts': '',
      'tools/test-only.ts': '',
      'tools/indexed-only.ts': '',
      'tools/self-only.ts': 'console.log("tools/self-only.ts");',
      'tools/caller.ts': 'import "./used-by-tool.ts";',
      'tools/caller.test.ts': 'import "./test-only.ts";',
      'tests/run-unit-tests.sh': 'tools/test-only.ts',
      'tests/fixtures/x.json': '"tools/test-only.ts"',
      'shared/lib/run.sh': 'wavemill_run_tool "used-by-script.ts"',
      [OPERATOR_TOOLS_INDEX]: '| `tools/indexed-only.ts` | x | No |',
    });
    try {
      assert.deepEqual(
        findUnreferencedTools(repoDir).sort(),
        ['tools/caller.ts', 'tools/indexed-only.ts', 'tools/self-only.ts', 'tools/test-only.ts'],
      );
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});

describe('checkOperatorToolsIndex', () => {
  // protects: a new unreferenced tool, or a deleted indexed tool, passes the check unnoticed
  it('reports unindexed tools, missing files and duplicates', () => {
    const repoDir = makeRepo({
      'tools/listed.ts': '',
      'tools/unlisted.ts': '',
      [OPERATOR_TOOLS_INDEX]: [
        '| `tools/listed.ts` | x | No |',
        '| `tools/gone.ts` | x | No |',
        '| `tools/listed.ts` | x | No |',
      ].join('\n'),
    });
    try {
      assert.deepEqual(checkOperatorToolsIndex(repoDir), {
        unindexed: ['tools/unlisted.ts'],
        missingFiles: ['tools/gone.ts'],
        duplicates: ['tools/listed.ts'],
      });
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});

describe('runHelpChecks', () => {
  // protects: a tool that crashes on load, ignores --help, or prints nothing is reported as working
  it('passes only tools that exit 0 and print something', async () => {
    const repoDir = makeRepo({
      'tools/ok.ts': 'if (process.argv.includes("--help")) { console.log("usage"); process.exit(0); }\nprocess.exit(3);\n',
      'tools/crash.ts': 'throw new Error("boom");\n',
      'tools/no-help.ts': 'process.exit(2);\n',
      'tools/silent.ts': 'process.exit(0);\n',
    });
    try {
      const results = await runHelpChecks(
        ['tools/ok.ts', 'tools/crash.ts', 'tools/no-help.ts', 'tools/silent.ts'],
        { repoDir, concurrency: 2, timeoutMs: 30_000 },
      );
      assert.deepEqual(results.map((r) => [r.tool, r.ok]), [
        ['tools/ok.ts', true],
        ['tools/crash.ts', false],
        ['tools/no-help.ts', false],
        ['tools/silent.ts', false],
      ]);
      assert.match(results[1].reason, /exited 1/);
      assert.match(results[2].reason, /exited 2/);
      assert.equal(results[3].reason, 'exited 0 but printed nothing');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
