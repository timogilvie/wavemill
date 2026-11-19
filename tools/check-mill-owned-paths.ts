import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { renderMillOwnedGitignore, renderMillOwnedShell, updateMillOwnedGeneratedFiles } from '../shared/lib/mill-owned-paths.ts';
import { millOwnedEntry } from '../shared/lib/mill-owned-paths.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
if (process.argv.includes('--write')) updateMillOwnedGeneratedFiles(root);
else {
  const shell = readFileSync(join(root, 'shared/lib/mill-owned-paths.sh'), 'utf8');
  const ignore = readFileSync(join(root, '.gitignore'), 'utf8');
  const expectedBlock = `# BEGIN GENERATED MILL-OWNED PATHS\n${renderMillOwnedGitignore()}# END GENERATED MILL-OWNED PATHS`;
  if (shell !== renderMillOwnedShell()) throw new Error('mill-owned-paths.sh is stale; run npx tsx tools/check-mill-owned-paths.ts --write');
  if (!ignore.includes(expectedBlock)) throw new Error('.gitignore generated mill-owned block is stale');
  const common = readFileSync(join(root, 'shared/lib/wavemill-common.sh'), 'utf8');
  const dirty = readFileSync(join(root, 'shared/lib/worktree-dirty-status.ts'), 'utf8');
  if (/grep\s+-v\s+-E|GENERATED_ARTIFACT_PATTERNS/.test(common + dirty)) throw new Error('duplicate dirty-status allowlist found');
  const monitor = readFileSync(join(root, 'shared/lib/wavemill-monitor.sh'), 'utf8');
  if (/\.wavemill\/\*|case \"\$normalized_path\"/.test(monitor)) throw new Error('duplicate owned-path decision found in monitor');
  const files = execFileSync('git', ['-C', root, 'ls-files', '-co', '--exclude-standard'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  const writeCall = /(?:writeFileSync|appendFileSync|mkdirSync|writeFile|appendFile|mkdir)\s*\([^\n]*?['"`]([^'"`]*\.wavemill\/[^'"`]*)['"`]/g;
  const undeclared: string[] = [];
  for (const relativePath of files) {
    if (!/\.(?:ts|js|sh)$/.test(relativePath) || /\.test\./.test(relativePath) || relativePath === relative(fileURLToPath(import.meta.url), root)) continue;
    let source = '';
    try { source = readFileSync(join(root, relativePath), 'utf8'); } catch { continue; }
    for (const line of source.split('\n')) {
      if (/writeFileSync\(join\([^,]+,\s*['"`]\.gitignore['"`]\)/.test(line)) continue;
      for (const match of line.matchAll(writeCall)) {
        const output = match[1];
        const pathPart = output.slice(output.indexOf('.wavemill/'));
        if (!millOwnedEntry(pathPart)) undeclared.push(`${relativePath}: ${pathPart}`);
      }
    }
  }
  if (undeclared.length) throw new Error(`undeclared .wavemill/ write path(s):\n${undeclared.join('\n')}`);
  console.log('mill-owned paths generated files are current');
}
