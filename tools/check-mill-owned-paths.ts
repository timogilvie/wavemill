import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { runGuardCli, type GuardSpec, type StructuralMatch } from './lib/source-guard.ts';
import { renderMillOwnedGitignore, renderMillOwnedShell, updateMillOwnedGeneratedFiles } from '../shared/lib/mill-owned-paths.ts';
import { millOwnedEntry } from '../shared/lib/mill-owned-paths.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Returns each statically knowable .wavemill output passed to a filesystem writer. */
function millOutputWrites(source: string, file: string): StructuralMatch[] {
  const findings: StructuralMatch[] = [];
  const call = /(?:writeFileSync|appendFileSync|createWriteStream|mkdirSync|writeFile|appendFile|mkdir)\s*\(([\s\S]{0,600}?)\)/g;
  for (const match of source.matchAll(call)) {
    const strings = [...match[1].matchAll(/['\"]([^'\"]+)['\"]/g)].map((part) => part[1]);
    const start = strings.findIndex((part) => part === '.wavemill' || part.startsWith('.wavemill/'));
    if (start < 0) continue;
    const output = strings[start] === '.wavemill' ? strings.slice(start).join('/') : strings[start];
    // Creating the container directory alone creates no artifact. A child
    // writer is checked independently when it writes a concrete path.
    if (output === '.wavemill') continue;
    if (millOwnedEntry(output)) continue;
    const offset = match.index ?? 0;
    findings.push({ line: source.slice(0, offset).split('\n').length, detail: output });
  }
  // Shell writers with a literal .wavemill subpath (dynamic subpaths cannot
  // be resolved statically and are left to the runtime ownership matcher).
  for (const match of (file.endsWith('.sh') ? source : '').matchAll(/(?:>{1,2}\s*|\btee\s+|\bmkdir\s+-p\s+)[^\n;|]*?\/.wavemill\/([A-Za-z0-9_.\/-]+)/g)) {
    const lineStart = source.lastIndexOf('\n', match.index - 1) + 1;
    if (source.slice(lineStart, match.index).trimStart().startsWith('#')) continue;
    const output = `.wavemill/${match[1]}`;
    if (!millOwnedEntry(output)) findings.push({ line: source.slice(0, match.index).split('\n').length, detail: output });
  }
  return findings;
}

export const MILL_OWNED_PATHS_GUARD: GuardSpec = {
  name: 'mill-owned-paths',
  findingNoun: 'parallel mill-owned path declaration(s)',
  suppressionMarker: 'allow-mill-owned-paths',
  allowlistFile: 'tools/mill-owned-paths-allowlist.txt',
  invariantPaths: ['tools/check-mill-owned-paths.ts', 'shared/lib/mill-owned-paths.ts', 'shared/lib/mill-owned-paths.sh'], // install-paths: allow source guard and generated twin
  invariantDocs: ['docs/invariants/mill-owned-paths.md'],
  patterns: [{
    name: 'per-path-dirty-allowlist',
    description: 'dirty checks must delegate to the generated mill-owned path matcher',
    lang: 'both',
    scopedPaths: ['shared/lib/wavemill-common.sh', 'shared/lib/wavemill-monitor.sh', 'shared/lib/worktree-dirty-status.ts'],
    re: /(?:GENERATED_ARTIFACT_PATTERNS|prompt-registry\.jsonl|\.wavemill\/audits|case "\$normalized_path")/,
  }],
  structuralChecks: [{
    name: 'undeclared-mill-output-write',
    description: 'a .wavemill write is not declared in MILL_OWNED_PATHS',
    find: millOutputWrites,
  }],
  remediation: ['Declare the output once in shared/lib/mill-owned-paths.ts, then regenerate its shell and .gitignore twins.'],
};

function checkGeneratedFiles(): void {
  const shell = readFileSync(join(root, 'shared/lib/mill-owned-paths.sh'), 'utf8');
  const ignore = readFileSync(join(root, '.gitignore'), 'utf8');
  const expectedBlock = `# BEGIN GENERATED MILL-OWNED PATHS\n${renderMillOwnedGitignore()}# END GENERATED MILL-OWNED PATHS`;
  if (shell !== renderMillOwnedShell()) throw new Error('mill-owned-paths.sh is stale; run npx tsx tools/check-mill-owned-paths.ts --write');
  if (!ignore.includes(expectedBlock)) throw new Error('.gitignore generated mill-owned block is stale');
}

if (process.argv.includes('--write')) updateMillOwnedGeneratedFiles(root);
else {
  runGuardCli(MILL_OWNED_PATHS_GUARD, root);
  checkGeneratedFiles();
  console.log('mill-owned paths generated files are current');
}
