/** Test-only source injection for negative controls without tracked-file writes. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

export async function loadContractModule<T>(current: URL, sourceOverride?: string): Promise<T> {
  if (!sourceOverride) return import(current.href) as Promise<T>;
  const root = mkdtempSync(join(tmpdir(), 'wm-contract-module-'));
  try {
    // Historical source lives in tmp; its relative dependencies still resolve
    // against the checkout. This isolates a changed decision, not the whole build.
    const source = readFileSync(sourceOverride, 'utf8').replace(
      /\bfrom\s+(['"])(\.[^'"]+)\1/g,
      (_match, _quote, relative) => `from '${pathToFileURL(resolve(dirname(fileURLToPath(current)), relative)).href}'`,
    );
    const compiled = ts.transpileModule(source, {compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
    }}).outputText;
    const file = join(root, 'negative-control.mjs');
    writeFileSync(file, compiled);
    return await import(pathToFileURL(file).href) as T;
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
}
