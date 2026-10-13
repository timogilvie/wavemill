import crypto from 'node:crypto';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

interface PatchJournalV1 {
  version: 1;
  createdAt: string;
  worktreeAbsolute: string;
  entries: PatchJournalEntry[];
}

interface PatchJournalEntry {
  relativePath: string;
  operation: 'overwrite'; // HOK-3213 v1: overwrite only; 'create' and 'delete' reserved
  originalSha256: string;
  originalSize: number;
  backupRelative: string;
  postSha256: string;
}

export interface PatchRecoveryResult {
  recovered: boolean;
  restoredFiles?: string[];
  warnings?: string[];
  reason?: string;
}

export interface PatchRecoveryLogger {
  onRecovery(result: PatchRecoveryResult): void;
  onRecoveryError(error: unknown): void;
}

export interface CommittedJournal {
  journalDir: string;
  backupsDir: string;
}

const DEFAULT_LOGGER: PatchRecoveryLogger = {
  onRecovery(result) {
    if (result.recovered && result.restoredFiles) {
      console.warn(`[patch-journal] recovered ${result.restoredFiles.length} files`);
    }
    if (result.warnings?.length) {
      console.warn(`[patch-journal] warnings:`, result.warnings);
    }
  },
  onRecoveryError(error) {
    console.warn('[patch-journal] recovery error:', error);
  },
};

function computeSha256(data: string | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

async function resolveGitDir(worktreeAbsolute: string): Promise<string | null> {
  const gitPath = path.join(worktreeAbsolute, '.git');
  try {
    const stats = await fsPromises.stat(gitPath);
    if (stats.isDirectory()) {
      return gitPath;
    }
    if (stats.isFile()) {
      const content = await fsPromises.readFile(gitPath, 'utf8');
      const match = content.match(/^gitdir:\s*(.+?)(?:\r\n|\n)?$/m);
      if (match) {
        let gitdir = match[1].trim();
        if (!path.isAbsolute(gitdir)) {
          gitdir = path.resolve(worktreeAbsolute, gitdir);
        }
        return gitdir;
      }
    }
  } catch (error: unknown) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code !== 'ENOENT') {
      console.warn(`[patch-journal] Could not resolve gitdir: ${nodeError.message}`);
    }
  }
  return null;
}

export async function atomicWriteFile(absolutePath: string, bytes: Buffer | string): Promise<void> {
  const buffer = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes;
  const dir = path.dirname(absolutePath);
  const filename = path.basename(absolutePath);

  // Crash hook for testing (HOK-3213)
  if (process.env.WAVEMILL_PATCH_CRASH_INSIDE_WRITE) {
    const tempSuffix = `${process.pid}-${randomBytes(8).toString('hex')}`;
    const tempPath = `${absolutePath}.wavemill-patch-${tempSuffix}.tmp`;

    try {
      const fh = await fsPromises.open(tempPath, 'wx', 0o600);
      const halfSize = Math.floor(buffer.length / 2);
      await fh.write(buffer.subarray(0, halfSize));
      // Simulate crash before rename
      process.exit(137);
    } catch (error) {
      // Cleanup on error
      try {
        await fsPromises.unlink(tempPath);
      } catch {}
      throw error;
    }
  }

  const tempSuffix = `${process.pid}-${randomBytes(8).toString('hex')}`;
  const tempPath = `${absolutePath}.wavemill-patch-${tempSuffix}.tmp`;

  try {
    const fh = await fsPromises.open(tempPath, 'wx', 0o600);
    try {
      await fh.write(buffer);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fsPromises.rename(tempPath, absolutePath);
  } catch (error) {
    try {
      await fsPromises.unlink(tempPath);
    } catch {}
    throw error;
  }
}

export async function commitPatchJournal(
  worktreeAbsolute: string,
  entries: Array<{ relativePath: string; originalDiskText: string; currentDiskText: string; absolutePath: string }>,
  logger?: PatchRecoveryLogger,
): Promise<CommittedJournal> {
  const gitDir = await resolveGitDir(worktreeAbsolute);
  const journalDir = gitDir
    ? path.join(gitDir, 'wavemill-patch-journal')
    : path.join(worktreeAbsolute, '.wavemill-patch-journal');
  const backupsDir = path.join(journalDir, 'backups');

  // Allocate journal directory
  await fsPromises.mkdir(backupsDir, { recursive: true });

  const journalEntries: PatchJournalEntry[] = [];

  // Create backups and collect entries
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!;
    const originalSha256 = computeSha256(entry.originalDiskText);
    const postSha256 = computeSha256(entry.currentDiskText);
    const originalSize = Buffer.byteLength(entry.originalDiskText, 'utf8');

    const backupName = `${originalSha256}-${index}.bak`;
    const backupRelative = `backups/${backupName}`;
    const backupPath = path.join(backupsDir, backupName);

    // Copy file to backup using reflink if available
    try {
      await fsPromises.copyFile(entry.absolutePath, backupPath, fsPromises.constants.COPYFILE_FICLONE);
    } catch (error) {
      // Non-reflink FS falls back silently in fsPromises.copyFile
      try {
        await fsPromises.copyFile(entry.absolutePath, backupPath);
      } catch (copyError) {
        // On copy failure, clean up and rethrow
        await fsPromises.rm(journalDir, { recursive: true, force: true });
        throw copyError;
      }
    }

    journalEntries.push({
      relativePath: entry.relativePath,
      operation: 'overwrite',
      originalSha256,
      originalSize,
      backupRelative,
      postSha256,
    });
  }

  // Create and atomically commit journal
  const journal: PatchJournalV1 = {
    version: 1,
    createdAt: new Date().toISOString(),
    worktreeAbsolute,
    entries: journalEntries,
  };

  const journalPath = path.join(journalDir, 'journal.json');
  const journalContent = JSON.stringify(journal, null, 2);

  await atomicWriteFile(journalPath, journalContent);

  return { journalDir, backupsDir };
}

export async function recoverPatchJournal(
  worktreeAbsolute: string,
  logger?: PatchRecoveryLogger,
): Promise<PatchRecoveryResult> {
  const effectiveLogger = logger || DEFAULT_LOGGER;

  try {
    const gitDir = await resolveGitDir(worktreeAbsolute);
    const journalDir = gitDir
      ? path.join(gitDir, 'wavemill-patch-journal')
      : path.join(worktreeAbsolute, '.wavemill-patch-journal');

    // Check if journal exists
    let journalStats;
    try {
      journalStats = await fsPromises.stat(journalDir);
    } catch (error: unknown) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === 'ENOENT') {
        return { recovered: false, restoredFiles: [], warnings: [] };
      }
      throw error;
    }

    if (!journalStats.isDirectory()) {
      return { recovered: false, restoredFiles: [], warnings: [] };
    }

    const journalPath = path.join(journalDir, 'journal.json');
    let journalContent: string;
    try {
      journalContent = await fsPromises.readFile(journalPath, 'utf8');
    } catch (error: unknown) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === 'ENOENT') {
        // Journal dir exists but no journal.json; likely mid-commit, safe to delete
        await fsPromises.rm(journalDir, { recursive: true, force: true });
        return { recovered: false, restoredFiles: [], warnings: [] };
      }
      throw error;
    }

    let journal: PatchJournalV1;
    try {
      journal = JSON.parse(journalContent) as PatchJournalV1;
    } catch (error: unknown) {
      effectiveLogger.onRecoveryError(
        new Error(`[patch-journal] Malformed journal JSON at ${journalPath}: ${error instanceof Error ? error.message : String(error)}`),
      );
      return {
        recovered: false,
        warnings: ['Malformed journal file left in place for operator inspection'],
        reason: 'malformed_journal',
      };
    }

    // Validate journal version and worktree
    if (journal.version !== 1) {
      effectiveLogger.onRecoveryError(
        new Error(`[patch-journal] Unknown journal version: ${journal.version}`),
      );
      return {
        recovered: false,
        warnings: ['Journal has unknown version; left in place for operator inspection'],
        reason: 'unknown_version',
      };
    }

    if (journal.worktreeAbsolute !== worktreeAbsolute) {
      effectiveLogger.onRecoveryError(
        new Error(
          `[patch-journal] Journal worktree mismatch: recorded "${journal.worktreeAbsolute}", current "${worktreeAbsolute}"`,
        ),
      );
      return {
        recovered: false,
        warnings: ['Journal from different worktree; left in place for operator inspection'],
        reason: 'worktree_mismatch',
      };
    }

    const restoredFiles: string[] = [];
    const warnings: string[] = [];
    const backupsDir = path.join(journalDir, 'backups');

    // Process each entry
    for (const entry of journal.entries) {
      const absolutePath = path.join(worktreeAbsolute, entry.relativePath);

      // Read current target state
      let currentBytes: Buffer;
      let currentSha256: string;
      try {
        currentBytes = await fsPromises.readFile(absolutePath);
        currentSha256 = computeSha256(currentBytes);
      } catch (error: unknown) {
        const nodeError = error as NodeJS.ErrnoException;
        if (nodeError.code === 'ENOENT') {
          currentSha256 = '';
        } else {
          throw error;
        }
      }

      // Check if already in original state
      if (currentSha256 === entry.originalSha256) {
        // Nothing to do; target still has original content or was already restored
        continue;
      }

      // If target is at post-state, restore backup
      if (currentSha256 === entry.postSha256) {
        // File was successfully patched; restore backup to pre-state
        const backupPath = path.join(backupsDir, path.basename(entry.backupRelative));
        try {
          const backupBytes = await fsPromises.readFile(backupPath);
          await atomicWriteFile(absolutePath, backupBytes);
          restoredFiles.push(entry.relativePath);
        } catch (error: unknown) {
          const nodeError = error as NodeJS.ErrnoException;
          if (nodeError.code === 'ENOENT') {
            warnings.push(`Backup missing for ${entry.relativePath}; target left unchanged`);
          } else {
            throw error;
          }
        }
        continue;
      }

      // Target is in neither state; restore from backup anyway
      const backupPath = path.join(backupsDir, path.basename(entry.backupRelative));
      try {
        const backupBytes = await fsPromises.readFile(backupPath);
        await atomicWriteFile(absolutePath, backupBytes);
        restoredFiles.push(entry.relativePath);
        warnings.push(`File ${entry.relativePath} was in unexpected state; restored from backup`);
      } catch (error: unknown) {
        const nodeError = error as NodeJS.ErrnoException;
        if (nodeError.code === 'ENOENT') {
          warnings.push(`Backup missing for ${entry.relativePath}; target left in current state`);
        } else {
          throw error;
        }
      }
    }

    // Clean up journal after processing all entries
    try {
      await fsPromises.rm(journalDir, { recursive: true, force: true });
    } catch (error) {
      warnings.push(`Failed to clean up journal directory: ${error instanceof Error ? error.message : String(error)}`);
    }

    const result: PatchRecoveryResult = {
      recovered: restoredFiles.length > 0,
      restoredFiles,
      warnings: warnings.length > 0 ? warnings : undefined,
    };

    effectiveLogger.onRecovery(result);
    return result;
  } catch (error: unknown) {
    effectiveLogger.onRecoveryError(error);
    throw error;
  }
}

export async function cleanupPatchJournal(committedJournal: CommittedJournal): Promise<void> {
  try {
    await fsPromises.rm(committedJournal.journalDir, { recursive: true, force: true });
  } catch (error) {
    // Best-effort cleanup; don't fail if cleanup has already happened
    console.warn('[patch-journal] Cleanup warning:', error);
  }
}
