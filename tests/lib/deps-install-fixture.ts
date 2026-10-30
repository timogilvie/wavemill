// HOK-3315: Test fixture materializer for deps-install verification tests
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

interface InstalledPackage {
  name?: string;
  version?: string;
  link?: boolean;
  target?: string;
}

export interface DepsInstallFixture {
  dir: string;
  cleanup: () => void;
}

export function materializeFixture(
  lockfile: Record<string, unknown>,
  hiddenLockfile: Record<string, unknown>,
  packageJson: Record<string, unknown>,
  installedMetadata: Record<string, InstalledPackage>,
): DepsInstallFixture {
  const tmpDir = mkdtempSync(join(tmpdir(), 'deps-fixture-'));

  try {
    // Write package.json
    writeFileSync(
      join(tmpDir, 'package.json'),
      JSON.stringify(packageJson, null, 2),
    );

    // Write lockfiles
    writeFileSync(
      join(tmpDir, 'package-lock.json'),
      JSON.stringify(lockfile, null, 2),
    );

    // Create node_modules structure
    mkdirSync(join(tmpDir, 'node_modules'), { recursive: true });

    // Write hidden lockfile
    writeFileSync(
      join(tmpDir, 'node_modules', '.package-lock.json'),
      JSON.stringify(hiddenLockfile, null, 2),
    );

    // Materialize installed packages
    for (const [path, metadata] of Object.entries(installedMetadata)) {
      const fullPath = join(tmpDir, path);
      const dir = fullPath.substring(0, fullPath.lastIndexOf('/'));
      mkdirSync(dir, { recursive: true });

      if (metadata.link && metadata.target) {
        // Create symlink
        symlinkSync(metadata.target, fullPath);
      } else if (metadata.version) {
        // Create package.json for this package
        mkdirSync(fullPath, { recursive: true });
        writeFileSync(
          join(fullPath, 'package.json'),
          JSON.stringify(
            {
              name: metadata.name || path.split('/').pop(),
              version: metadata.version,
            },
            null,
            2,
          ),
        );
      }
    }

    // Also create the codex workspace directory for link targets
    const codexPath = join(tmpDir, 'codex');
    mkdirSync(codexPath, { recursive: true });
    writeFileSync(
      join(codexPath, 'package.json'),
      JSON.stringify({ name: 'codex', version: '1.0.0' }, null, 2),
    );

    return {
      dir: tmpDir,
      cleanup: () => {
        // Cleanup will be handled by the test or by the test runner
      },
    };
  } catch (error) {
    throw new Error(`Failed to materialize fixture: ${error}`);
  }
}

export function loadFixture(name: 'healthy' | 'incident'): {
  lockfile: Record<string, unknown>;
  hiddenLockfile: Record<string, unknown>;
  packageJson: Record<string, unknown>;
  installedMetadata: Record<string, InstalledPackage>;
} {
  // In a real test setup, these would be loaded from the fixture files
  // For now, return the structure that tests can use
  throw new Error('loadFixture not implemented - tests should call materializeFixture directly');
}
