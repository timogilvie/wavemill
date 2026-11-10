/**
 * discover-tests - Print the tests a suite runs, one per line (HOK-3466).
 *
 * The sharded runners (tests/run-shell-suite.sh, tests/run-unit-tests.sh,
 * tests/run-custom-tests.sh) and the syntax pass in tests/check-shell.sh call
 * this instead of keeping a list. The rules live in
 * shared/lib/test-discovery.ts.
 */

import { runTool } from '../shared/lib/tool-runner.ts';
import { RUNNER_SUITES, discoverTestSuites, listShellScripts, type RunnerSuite } from '../shared/lib/test-discovery.ts';

runTool({
  name: 'discover-tests',
  description: 'Print the test files a suite runs, discovered by file pattern and suite marker',
  options: {
    suite: { type: 'string', description: `Suite to list (${RUNNER_SUITES.join('|')})` },
    'shell-scripts': { type: 'boolean', description: 'List every shell script in the repo (for bash -n) instead of a suite' },
    'repo-dir': { type: 'string', description: 'Repository directory (default: cwd)' },
  },
  examples: [
    'node tools/discover-tests.ts --suite unit',
    'node tools/discover-tests.ts --shell-scripts',
  ],
  async run({ args }) {
    const repoDir = args['repo-dir'] ?? process.cwd();
    let lines: string[];
    if (args['shell-scripts']) {
      lines = listShellScripts(repoDir);
    } else {
      const suite = args.suite;
      if (!suite || !(RUNNER_SUITES as readonly string[]).includes(suite)) {
        throw new Error(`--suite is required (${RUNNER_SUITES.join('|')}), or pass --shell-scripts`);
      }
      lines = discoverTestSuites(repoDir)[suite as RunnerSuite];
    }
    // Single write after discovery succeeded: a runner never sees a partial list.
    process.stdout.write(lines.length > 0 ? lines.join('\n') + '\n' : '');
  },
});
