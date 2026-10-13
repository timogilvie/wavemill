import { describe, it, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import crypto from 'node:crypto';

import {
  commitPatchJournal,
  recoverPatchJournal,
  cleanupPatchJournal,
  atomicWriteFile,
  type PatchRecoveryLogger,
} from './patch-journal.ts';

function computeSha256(data: string | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

describe('patch-journal', () => {
  let tmpDir: string;

  before(() => {
    tmpDir = mkdtempSync(path.join('/tmp', 'patch-journal-test-'));
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('atomicWriteFile', () => {
    it('writes new file', async () => {
      const filePath = path.join(tmpDir, 'newfile.txt');
      const content = 'Hello, World!';

      await atomicWriteFile(filePath, content);

      const read = await fsPromises.readFile(filePath, 'utf8');
      assert.equal(read, content);
    });

    it('overwrites existing file', async () => {
      const filePath = path.join(tmpDir, 'existing.txt');
      await fsPromises.writeFile(filePath, 'Original', 'utf8');

      await atomicWriteFile(filePath, 'Updated');

      const read = await fsPromises.readFile(filePath, 'utf8');
      assert.equal(read, 'Updated');
    });

    it('leaves no temp file on success', async () => {
      const filePath = path.join(tmpDir, 'clean.txt');
      await atomicWriteFile(filePath, 'Content');

      const files = await fsPromises.readdir(tmpDir);
      const tempFiles = files.filter((f) => f.includes('.wavemill-patch-') && f.endsWith('.tmp'));
      assert.equal(tempFiles.length, 0, 'No temp files should remain after successful write');
    });

    it('leaves target untouched on write failure', async () => {
      const filePath = path.join(tmpDir, 'protected.txt');
      const originalContent = 'Protected';
      await fsPromises.writeFile(filePath, originalContent, 'utf8');

      // Make directory read-only to cause write failure
      const dir = path.dirname(filePath);
      await fsPromises.chmod(dir, 0o555);

      try {
        await atomicWriteFile(filePath, 'Attempted Write');
      } catch (error) {
        // Expected to fail
      } finally {
        // Restore write permission for cleanup
        await fsPromises.chmod(dir, 0o755);
      }

      const read = await fsPromises.readFile(filePath, 'utf8');
      assert.equal(read, originalContent, 'Target should be untouched after failure');
    });
  });

  describe('commitPatchJournal and recoverPatchJournal', () => {
    it('recovers nothing when no journal exists', async () => {
      const result = await recoverPatchJournal(tmpDir);
      assert.equal(result.recovered, false);
      assert.deepEqual(result.restoredFiles, []);
    });

    it('recovers when all files already restored', async () => {
      const workDir = path.join(tmpDir, 'work-untouched');
      await fsPromises.mkdir(workDir, { recursive: true });

      const file1Content = 'File 1 Original';
      const file1Path = path.join(workDir, 'file1.txt');
      await fsPromises.writeFile(file1Path, file1Content, 'utf8');

      // Commit journal (creates it but doesn't modify files yet)
      const journal = await commitPatchJournal(
        workDir,
        [
          {
            relativePath: 'file1.txt',
            originalDiskText: file1Content,
            currentDiskText: 'File 1 New',
            absolutePath: file1Path,
          },
        ],
      );

      // File is still at original content
      let read = await fsPromises.readFile(file1Path, 'utf8');
      assert.equal(read, file1Content);

      // Recover when file is already original
      const result = await recoverPatchJournal(workDir);
      assert.equal(result.recovered, false, 'Should report no recovery needed');

      read = await fsPromises.readFile(file1Path, 'utf8');
      assert.equal(read, file1Content, 'File should remain unchanged');
    });

    it('restores single file from post-state', async () => {
      const workDir = path.join(tmpDir, 'work-single-restore');
      await fsPromises.mkdir(workDir, { recursive: true });

      const originalContent = 'Original Content';
      const newContent = 'New Content';
      const filePath = path.join(workDir, 'file.txt');
      await fsPromises.writeFile(filePath, originalContent, 'utf8');

      // Commit journal
      await commitPatchJournal(
        workDir,
        [
          {
            relativePath: 'file.txt',
            originalDiskText: originalContent,
            currentDiskText: newContent,
            absolutePath: filePath,
          },
        ],
      );

      // Manually write the new content (simulating successful patch)
      await fsPromises.writeFile(filePath, newContent, 'utf8');

      // Recover
      const result = await recoverPatchJournal(workDir);
      assert.equal(result.recovered, true);
      assert.deepEqual(result.restoredFiles, ['file.txt']);

      // Verify file was restored
      const read = await fsPromises.readFile(filePath, 'utf8');
      assert.equal(read, originalContent, 'File should be restored to original');
    });

    it('restores multiple files with mixed states', async () => {
      const workDir = path.join(tmpDir, 'work-multi-restore');
      await fsPromises.mkdir(workDir, { recursive: true });

      const file1Original = 'File 1 Original';
      const file1New = 'File 1 New';
      const file2Original = 'File 2 Original';
      const file2New = 'File 2 New';

      const file1Path = path.join(workDir, 'file1.txt');
      const file2Path = path.join(workDir, 'file2.txt');

      await fsPromises.writeFile(file1Path, file1Original, 'utf8');
      await fsPromises.writeFile(file2Path, file2Original, 'utf8');

      // Commit journal
      await commitPatchJournal(
        workDir,
        [
          {
            relativePath: 'file1.txt',
            originalDiskText: file1Original,
            currentDiskText: file1New,
            absolutePath: file1Path,
          },
          {
            relativePath: 'file2.txt',
            originalDiskText: file2Original,
            currentDiskText: file2New,
            absolutePath: file2Path,
          },
        ],
      );

      // Simulate partial flush: only file1 was written, file2 still original
      await fsPromises.writeFile(file1Path, file1New, 'utf8');

      // Recover
      const result = await recoverPatchJournal(workDir);
      assert.equal(result.recovered, true);
      assert.deepEqual(result.restoredFiles, ['file1.txt']);

      // Verify states
      const read1 = await fsPromises.readFile(file1Path, 'utf8');
      const read2 = await fsPromises.readFile(file2Path, 'utf8');
      assert.equal(read1, file1Original);
      assert.equal(read2, file2Original);
    });

    it('handles missing backup gracefully', async () => {
      const workDir = path.join(tmpDir, 'work-missing-backup');
      await fsPromises.mkdir(workDir, { recursive: true });

      const originalContent = 'Original';
      const filePath = path.join(workDir, 'file.txt');
      await fsPromises.writeFile(filePath, originalContent, 'utf8');

      // Commit journal
      const journal = await commitPatchJournal(
        workDir,
        [
          {
            relativePath: 'file.txt',
            originalDiskText: originalContent,
            currentDiskText: 'New',
            absolutePath: filePath,
          },
        ],
      );

      // Simulate successful patch
      await fsPromises.writeFile(filePath, 'New', 'utf8');

      // Delete backup manually but keep journal
      const backupFiles = await fsPromises.readdir(journal.backupsDir);
      for (const backupFile of backupFiles) {
        await fsPromises.unlink(path.join(journal.backupsDir, backupFile));
      }

      // Recover
      const result = await recoverPatchJournal(workDir);
      assert.equal(result.recovered, false, 'Should report no files recovered');
      assert.ok(result.warnings?.some((w) => w.includes('Backup missing')));

      // File should be left in current state (New), not touched
      const read = await fsPromises.readFile(filePath, 'utf8');
      assert.equal(read, 'New');
    });

    it('handles malformed journal JSON', async () => {
      const workDir = path.join(tmpDir, 'work-malformed');
      await fsPromises.mkdir(workDir, { recursive: true });

      // Create a malformed journal
      const gitDir = path.join(workDir, '.git');
      const journalDir = path.join(gitDir, 'wavemill-patch-journal');
      await fsPromises.mkdir(journalDir, { recursive: true });

      const journalPath = path.join(journalDir, 'journal.json');
      await fsPromises.writeFile(journalPath, 'Invalid JSON {', 'utf8');

      // Recover
      const result = await recoverPatchJournal(workDir);
      assert.equal(result.recovered, false);
      assert.equal(result.reason, 'malformed_journal');

      // Journal should NOT be deleted (left for operator inspection)
      const exists = await fsPromises
        .stat(journalPath)
        .then(() => true)
        .catch(() => false);
      assert.equal(exists, true, 'Malformed journal should be left in place');
    });

    it('handles journal from different worktree', async () => {
      const workDir1 = path.join(tmpDir, 'work1');
      const workDir2 = path.join(tmpDir, 'work2');
      await fsPromises.mkdir(workDir1, { recursive: true });
      await fsPromises.mkdir(workDir2, { recursive: true });

      const filePath = path.join(workDir1, 'file.txt');
      await fsPromises.writeFile(filePath, 'Original', 'utf8');

      // Commit journal in workDir1
      const journal1 = await commitPatchJournal(
        workDir1,
        [
          {
            relativePath: 'file.txt',
            originalDiskText: 'Original',
            currentDiskText: 'New',
            absolutePath: filePath,
          },
        ],
      );

      // Try to recover in workDir2 with workDir1's journal
      const gitDir2 = path.join(workDir2, '.git');
      const journalDir2 = path.join(gitDir2, 'wavemill-patch-journal');

      // Copy journal from workDir1 to workDir2
      await fsPromises.mkdir(gitDir2, { recursive: true });
      await fsPromises.cp(journal1.journalDir, journalDir2, { recursive: true });

      // Recover in workDir2 should fail due to mismatch
      const result = await recoverPatchJournal(workDir2);
      assert.equal(result.recovered, false);
      assert.equal(result.reason, 'worktree_mismatch');

      // Journal should NOT be deleted
      const exists = await fsPromises
        .stat(journalDir2)
        .then(() => true)
        .catch(() => false);
      assert.equal(exists, true, 'Mismatched journal should be left in place');
    });

    it('end-to-end: apply patch, corrupt journal, recover', async () => {
      const workDir = path.join(tmpDir, 'work-e2e');
      await fsPromises.mkdir(workDir, { recursive: true });

      const file1 = 'file1.txt';
      const file2 = 'file2.txt';
      const file1Original = 'File 1 Original';
      const file2Original = 'File 2 Original';
      const file1Path = path.join(workDir, file1);
      const file2Path = path.join(workDir, file2);

      await fsPromises.writeFile(file1Path, file1Original, 'utf8');
      await fsPromises.writeFile(file2Path, file2Original, 'utf8');

      // Commit journal (simulating before-patch)
      const journal = await commitPatchJournal(
        workDir,
        [
          {
            relativePath: file1,
            originalDiskText: file1Original,
            currentDiskText: 'File 1 New',
            absolutePath: file1Path,
          },
          {
            relativePath: file2,
            originalDiskText: file2Original,
            currentDiskText: 'File 2 New',
            absolutePath: file2Path,
          },
        ],
      );

      // Simulate partial patch: write first file only
      await fsPromises.writeFile(file1Path, 'File 1 New', 'utf8');

      // Now recover (simulating crash recovery before next patch)
      const result = await recoverPatchJournal(workDir);
      assert.equal(result.recovered, true);
      assert.deepEqual(result.restoredFiles, [file1]);

      // Verify clean state
      const read1 = await fsPromises.readFile(file1Path, 'utf8');
      const read2 = await fsPromises.readFile(file2Path, 'utf8');
      assert.equal(read1, file1Original);
      assert.equal(read2, file2Original);

      // Journal should be gone
      const gitDir = path.join(workDir, '.git');
      const journalDir = path.join(gitDir, 'wavemill-patch-journal');
      const exists = await fsPromises
        .stat(journalDir)
        .then(() => true)
        .catch(() => false);
      assert.equal(exists, false, 'Journal should be cleaned up after recovery');
    });
  });
});
