import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path, { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseShellArray } from '../shared/lib/shard-balance.ts';

const __filename = fileURLToPath(import.meta.url);
const defaultRepoRoot = join(dirname(__filename), '..');
const TEST_ROOTS = ['shared', 'tools', 'src'];

export interface TestRegistrationResult {
  ok: boolean;
  discovered: string[];
  registered: string[];
  unregistered: string[];
  stale: string[];
  staleCustom: string[];
  duplicates: string[];
  /** Scoped TypeScript tests registered in both the unit and custom-harness suites. */
  overlap: string[];
  /** Custom-harness registrations listed more than once across the runner's arrays. */
  customDuplicates: string[];
  /** Custom-harness registrations whose files do not exist. */
  customMissing: string[];
}

export function checkTestRegistration(repoDir = defaultRepoRoot): TestRegistrationResult {
  const discovered = TEST_ROOTS.flatMap((root) => discoverTests(join(repoDir, root), root)).sort();
  const unitRegistered = parseUnitTestRegistry(readFileSync(join(repoDir, 'tests', 'run-unit-tests.sh'), 'utf8'))
    .filter(isScopedTest)
    .sort();
  const discoveredSet = new Set(discovered);
  const duplicates = [...new Set(unitRegistered.filter((testFile, index) => unitRegistered.indexOf(testFile) !== index))]
    .sort();

  const customScript = readFileSync(join(repoDir, 'tests', 'run-custom-tests.sh'), 'utf8');
  const rawCustomTsRegistered = parseShellArray(customScript, 'CUSTOM_TS_TESTS');
  const customTsRegistered = rawCustomTsRegistered.filter(isScopedTest).sort();
  const customShRegistered = parseShellArray(customScript, 'CUSTOM_SH_TESTS');
  const registered = [...new Set([...unitRegistered, ...customTsRegistered])].sort();
  const registeredSet = new Set(registered);
  const unitRegisteredSet = new Set(unitRegistered);
  const customRegistered = [...rawCustomTsRegistered, ...customShRegistered];
  const customDuplicates = [
    ...new Set(customRegistered.filter((testFile, index) => customRegistered.indexOf(testFile) !== index)),
  ].sort();
  const customMissing = customRegistered.filter((testFile) => !existsSync(join(repoDir, testFile))).sort();
  const stale = unitRegistered.filter((testFile) => !discoveredSet.has(testFile));
  const staleCustom = rawCustomTsRegistered.filter((testFile) => !discoveredSet.has(testFile)).sort();
  const overlap = customTsRegistered.filter((testFile) => unitRegisteredSet.has(testFile));

  return {
    ok: discovered.every((testFile) => registeredSet.has(testFile))
      && stale.length === 0
      && staleCustom.length === 0
      && duplicates.length === 0
      && overlap.length === 0
      && customDuplicates.length === 0
      && customMissing.length === 0,
    discovered,
    registered,
    unregistered: discovered.filter((testFile) => !registeredSet.has(testFile)),
    stale,
    staleCustom,
    duplicates,
    overlap,
    customDuplicates,
    customMissing,
  };
}

export function formatTestRegistration(result: TestRegistrationResult): string {
  if (result.ok) {
    return `test-registration: ok (${result.discovered.length} discovered, ${result.registered.length} registered)`;
  }

  const lines = ['test-registration: test registry drift found:'];
  appendSection(lines, 'Unregistered test files:', result.unregistered);
  appendSection(lines, 'Stale unit test registrations:', result.stale);
  appendSection(lines, 'Stale custom TS registrations:', result.staleCustom);
  appendSection(lines, 'Duplicate unit test registrations:', result.duplicates);
  appendSection(lines, 'Cross-suite overlap (registered in both TESTS and CUSTOM_TS_TESTS):', result.overlap);
  appendSection(lines, 'Duplicate custom harness registrations:', result.customDuplicates);
  appendSection(lines, 'Missing custom harness test files:', result.customMissing);
  lines.push(
    '',
    'Update tests/run-unit-tests.sh and tests/run-custom-tests.sh so every scoped *.test.ts is registered in exactly one of TESTS or CUSTOM_TS_TESTS,',
    'and so every custom harness entry is unique and its file exists.'
  );
  return lines.join('\n');
}

function appendSection(lines: string[], heading: string, entries: string[]): void {
  if (entries.length === 0) return;
  lines.push('', heading, ...entries.map((entry) => `- ${entry}`));
}

function discoverTests(directory: string, relativeDirectory: string): string[] {
  try {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const relativePath = path.posix.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) {
        return discoverTests(join(directory, entry.name), relativePath);
      }
      return entry.isFile() && entry.name.endsWith('.test.ts') ? [relativePath] : [];
    });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

function parseUnitTestRegistry(script: string): string[] {
  const block = script.match(/^TESTS=\(\n(?<entries>[\s\S]*?)^\)/m)?.groups?.entries ?? '';
  return [...block.matchAll(/^\s*([^\s#][^\s]*\.test\.ts)\s*(?:#.*)?$/gm)].map((match) => match[1]);
}

function isScopedTest(testFile: string): boolean {
  return TEST_ROOTS.some((root) => testFile.startsWith(`${root}/`));
}

if (process.argv[1] === __filename) {
  const result = checkTestRegistration(process.argv[2] ?? defaultRepoRoot);
  const message = formatTestRegistration(result);
  if (!result.ok) {
    console.error(message);
    process.exit(1);
  }
  console.log(message);
}
