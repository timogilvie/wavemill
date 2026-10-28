// Crash-atomic patch application (HOK-3213).
// flushStagedFiles uses per-file atomicity (temp + rename) and an undo journal
// in the gitdir to survive SIGKILL / OOM / host sleep mid-flush. Recovery runs
// on every apply_patch call and at native-coding launch, so a half-applied
// multi-file patch is rolled back to the pre-patch state (never left partial).
// Do not revert to in-process-only rollback without gating it behind a feature
// flag or completing a new crash-atomicity design.

import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { countGitTextChanges } from './tools/git.ts';

import type {
  NativePatch,
  NativePatchEditDiffOperation,
  NativePatchEditOperation,
  NativePatchOperation,
  NativePatchRejectedResult,
  NativePatchRuntimeRejection,
} from './patch-contract.ts';
import { resolveInsideWorktree } from './tools/read-only.ts';
import type { ToolPhase } from './tools/types.ts';
import {
  commitPatchJournal,
  recoverPatchJournal,
  cleanupPatchJournal,
  atomicWriteFile,
  type PatchRecoveryLogger,
} from './patch-journal.ts';

export interface AppliedFileChange {
  path: string;
  linesAdded: number;
  linesRemoved: number;
}

export interface NativePatchAppliedResult {
  ok: true;
  atomic: true;
  appliedOperations: number;
  changedFiles: string[];
  fileChanges: AppliedFileChange[];
  linesAdded: number;
  linesRemoved: number;
  snapshots: Array<{
    path: string;
    originalDiskText: string;
    postImage: string;
  }>;
}

export type ApplyNativePatchResult = NativePatchAppliedResult | NativePatchRejectedResult;

interface StagedFile {
  absolutePath: string;
  relativePath: string;
  originalDiskText: string;
  currentDiskText: string;
  normalizedOriginalText: string;
  normalizedCurrentText: string;
  lineEnding: '\n' | '\r\n';
  hadTrailingNewline: boolean;
}

interface MatchCandidate {
  start: number;
  end: number;
}

interface ParsedHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: string[];
}

interface ApplyDiffSuccess {
  ok: true;
  updatedText: string;
}

interface ApplyDiffFailure {
  ok: false;
  code: NativePatchRuntimeRejection['code'];
  message: string;
  requestedContext: NativePatchRuntimeRejection['requestedContext'];
  hint: string;
  liveContext?: NativePatchRuntimeRejection['liveContext'];
}

type ApplyDiffResult = ApplyDiffSuccess | ApplyDiffFailure;

export async function applyNativePatch(
  worktreeAbsolute: string,
  patch: NativePatch,
  options: { phase?: ToolPhase; logger?: PatchRecoveryLogger } = {},
): Promise<ApplyNativePatchResult> {
  const phase = options.phase ?? 'coding';
  if (phase !== 'coding') {
    return rejectOperation(0, 'phase_denied', 'Native patches can only be applied during coding phase.', {
      hint: `Retry this patch during the coding phase instead of ${phase}.`,
    });
  }

  // Recover any stale patch journal from a prior crash
  await recoverPatchJournal(worktreeAbsolute, options.logger);

  const stagedFiles = new Map<string, StagedFile>();

  for (const [operationIndex, operation] of patch.operations.entries()) {
    const stagedFile = await loadStagedFile(worktreeAbsolute, operation.path, stagedFiles);
    if ('ok' in stagedFile && stagedFile.ok === false) {
      return rejectOperation(operationIndex, 'path_denied', stagedFile.message, {
        operation,
        hint: 'Use an existing repo-relative file path inside the worktree.',
      });
    }

    const result = operation.op === 'edit'
      ? applyEditOperation(stagedFile, operation)
      : applyEditDiffOperation(stagedFile, operation);

    if (!result.ok) {
      return rejectOperation(operationIndex, result.code, result.message, {
        operation,
        liveContext: result.liveContext,
        hint: result.hint,
      });
    }

    stagedFile.normalizedCurrentText = result.updatedText;
    stagedFile.currentDiskText = denormalizeStagedText(stagedFile, result.updatedText);
  }

  const changedFiles = Array.from(stagedFiles.values())
    .filter((file) => file.currentDiskText !== file.originalDiskText)
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));

  const fileChanges = await Promise.all(changedFiles.map(async (file) => {
    const counts = await countGitTextChanges(file.normalizedOriginalText, file.normalizedCurrentText);
    return {
      path: file.relativePath,
      linesAdded: counts.linesAdded,
      linesRemoved: counts.linesRemoved,
    };
  }));

  // Derive all metadata before committing the crash-atomic write transaction.
  await flushStagedFiles(worktreeAbsolute, changedFiles, options.logger);

  return {
    ok: true,
    atomic: true,
    appliedOperations: patch.operations.length,
    changedFiles: fileChanges.map((change) => change.path),
    fileChanges,
    linesAdded: fileChanges.reduce((sum, change) => sum + change.linesAdded, 0),
    linesRemoved: fileChanges.reduce((sum, change) => sum + change.linesRemoved, 0),
    snapshots: changedFiles.map((file) => ({
      path: file.relativePath,
      originalDiskText: file.originalDiskText,
      postImage: file.currentDiskText,
    })),
  };
}

async function loadStagedFile(
  worktreeAbsolute: string,
  inputPath: string,
  stagedFiles: Map<string, StagedFile>,
): Promise<StagedFile | { ok: false; message: string }> {
  const resolved = await resolveInsideWorktree(worktreeAbsolute, inputPath);
  if (resolved.kind === 'error') {
    return { ok: false, message: resolved.message };
  }

  const key = toPosixRelativePath(resolved.relativePath);
  const existing = stagedFiles.get(key);
  if (existing) {
    return existing;
  }

  let stats;
  try {
    stats = await fsPromises.stat(resolved.absolutePath);
  } catch (error: unknown) {
    const nodeError = error as NodeJS.ErrnoException;
    return { ok: false, message: `Cannot inspect '${inputPath}': ${nodeError.message}` };
  }

  if (!stats.isFile()) {
    return { ok: false, message: `'${inputPath}' is not a file` };
  }

  const diskText = await fsPromises.readFile(resolved.absolutePath, 'utf8');
  const normalized = normalizeLineEndings(diskText);
  const stagedFile: StagedFile = {
    absolutePath: resolved.absolutePath,
    relativePath: key,
    originalDiskText: diskText,
    currentDiskText: diskText,
    normalizedOriginalText: normalized.text,
    normalizedCurrentText: normalized.text,
    lineEnding: normalized.lineEnding,
    hadTrailingNewline: normalized.hadTrailingNewline,
  };
  stagedFiles.set(key, stagedFile);
  return stagedFile;
}

function applyEditOperation(stagedFile: StagedFile, operation: NativePatchEditOperation): ApplyDiffSuccess | ApplyDiffFailure {
  const content = stagedFile.normalizedCurrentText;
  const oldText = normalizePatchText(operation.oldText);
  const newText = normalizePatchText(operation.newText);
  const matches = findAllMatches(content, oldText);

  if (matches.length === 0) {
    return {
      ok: false,
      code: 'old_text_not_found',
      message: `Could not find the requested text in ${operation.path}.`,
      requestedContext: buildRequestedContext(operation),
      liveContext: buildLiveContext(operation.path, content),
      hint: 'Refresh the patch against the latest file contents.',
    };
  }

  if (operation.expectedOccurrences !== undefined && matches.length !== operation.expectedOccurrences) {
    return {
      ok: false,
      code: 'ambiguous_anchor',
      message: `Expected ${operation.expectedOccurrences} matches in ${operation.path}, found ${matches.length}.`,
      requestedContext: buildRequestedContext(operation),
      liveContext: buildLiveContext(operation.path, content),
      hint: 'Adjust expectedOccurrences or add anchors to isolate the intended match.',
    };
  }

  const anchoredMatches = matches.filter((match) => matchSatisfiesAnchors(content, match, operation));
  if ((operation.anchorBefore || operation.anchorAfter) && anchoredMatches.length === 0) {
    return {
      ok: false,
      code: 'anchor_mismatch',
      message: `Anchors did not match the requested text in ${operation.path}.`,
      requestedContext: buildRequestedContext(operation),
      liveContext: buildLiveContext(operation.path, content),
      hint: 'Update the anchors so they directly surround the intended edit region.',
    };
  }

  const selectedMatches = anchoredMatches.length > 0 ? anchoredMatches : matches;
  if (selectedMatches.length !== 1) {
    return {
      ok: false,
      code: 'ambiguous_anchor',
      message: `The requested edit matched ${selectedMatches.length} locations in ${operation.path}.`,
      requestedContext: buildRequestedContext(operation),
      liveContext: buildLiveContext(operation.path, content),
      hint: 'Add anchorBefore/anchorAfter or tighten oldText so only one location matches.',
    };
  }

  const match = selectedMatches[0]!;
  return {
    ok: true,
    updatedText: `${content.slice(0, match.start)}${newText}${content.slice(match.end)}`,
  };
}

function applyEditDiffOperation(stagedFile: StagedFile, operation: NativePatchEditDiffOperation): ApplyDiffResult {
  const hunks = parseUnifiedDiff(operation.diff);
  if (hunks.length === 0) {
    return {
      ok: false,
      code: 'anchor_mismatch',
      message: `Diff for ${operation.path} did not contain any hunks.`,
      requestedContext: buildRequestedContext(operation),
      hint: 'Provide a unified diff with at least one @@ hunk.',
    };
  }

  let lines = splitLinesPreserveEmpty(stagedFile.normalizedCurrentText);
  let lineOffset = 0;

  for (const hunk of hunks) {
    const applyResult = applyHunk(lines, hunk, lineOffset);
    if (!applyResult.ok) {
      return {
        ok: false,
        code: applyResult.code,
        message: applyResult.message,
        requestedContext: buildRequestedContext(operation),
        liveContext: buildLiveContext(operation.path, stagedFile.normalizedCurrentText),
        hint: applyResult.hint,
      };
    }

    lines = applyResult.lines;
    lineOffset += hunk.newCount - hunk.oldCount;
  }

  return {
    ok: true,
    updatedText: joinLines(lines),
  };
}

function applyHunk(
  lines: string[],
  hunk: ParsedHunk,
  lineOffset: number,
): { ok: true; lines: string[] } | Omit<ApplyDiffFailure, 'requestedContext' | 'liveContext'> {
  const expectedOldLines = hunk.lines.filter((line) => line.startsWith(' ') || line.startsWith('-')).map((line) => line.slice(1));
  const replacementLines = hunk.lines.filter((line) => line.startsWith(' ') || line.startsWith('+')).map((line) => line.slice(1));
  const startIndex = Math.max(0, hunk.oldStart - 1 + lineOffset);
  const actualLines = lines.slice(startIndex, startIndex + expectedOldLines.length);

  if (arrayEquals(actualLines, expectedOldLines)) {
    const updated = lines.slice();
    updated.splice(startIndex, expectedOldLines.length, ...replacementLines);
    return { ok: true, lines: updated };
  }

  const removalLines = hunk.lines.filter((line) => line.startsWith('-')).map((line) => line.slice(1));
  if (removalLines.length > 0 && !containsLineSequence(lines, removalLines)) {
    return {
      ok: false,
      code: 'old_text_not_found',
      message: 'Diff removal lines were not found in the target file.',
      hint: 'Refresh the diff against the current file contents.',
    };
  }

  return {
    ok: false,
    code: 'anchor_mismatch',
    message: 'Diff context did not match the target file at the expected location.',
    hint: 'Refresh the diff or reduce surrounding context so the intended hunk matches cleanly.',
  };
}

function parseUnifiedDiff(diff: string): ParsedHunk[] {
  const lines = normalizePatchText(diff).split('\n');
  const hunks: ParsedHunk[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index]!;
    if (!line.startsWith('@@')) {
      index += 1;
      continue;
    }

    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!match) {
      index += 1;
      continue;
    }

    const hunk: ParsedHunk = {
      oldStart: Number(match[1]),
      oldCount: Number(match[2] ?? '1'),
      newStart: Number(match[3]),
      newCount: Number(match[4] ?? '1'),
      lines: [],
    };
    index += 1;

    while (index < lines.length) {
      const hunkLine = lines[index]!;
      if (hunkLine.startsWith('@@')) {
        break;
      }
      if (hunkLine === '\\ No newline at end of file') {
        index += 1;
        continue;
      }
      if (!/^[ +\-]/.test(hunkLine)) {
        break;
      }
      hunk.lines.push(hunkLine);
      index += 1;
    }

    hunks.push(hunk);
  }

  return hunks;
}

async function flushStagedFiles(
  worktreeAbsolute: string,
  changedFiles: StagedFile[],
  logger?: PatchRecoveryLogger,
): Promise<void> {
  if (changedFiles.length === 0) {
    return;
  }

  // Commit journal with intent and backups
  const committedJournal = await commitPatchJournal(
    worktreeAbsolute,
    changedFiles.map((file) => ({
      relativePath: file.relativePath,
      originalDiskText: file.originalDiskText,
      currentDiskText: file.currentDiskText,
      absolutePath: file.absolutePath,
    })),
    logger,
  );

  // Crash hook for testing (HOK-3213)
  if (process.env.WAVEMILL_PATCH_CRASH_AFTER_N_RENAMES !== undefined) {
    const crashAfterN = parseInt(process.env.WAVEMILL_PATCH_CRASH_AFTER_N_RENAMES, 10);
    let renamedCount = 0;

    try {
      for (const file of changedFiles) {
        await atomicWriteFile(file.absolutePath, file.currentDiskText);
        renamedCount += 1;
        if (renamedCount >= crashAfterN) {
          // Simulate crash before cleanup
          process.exit(137);
        }
      }
    } catch (error) {
      await cleanupPatchJournal(committedJournal);
      throw error;
    }
  } else {
    // Normal path: write all files atomically
    try {
      for (const file of changedFiles) {
        await atomicWriteFile(file.absolutePath, file.currentDiskText);
      }
    } catch (error) {
      await cleanupPatchJournal(committedJournal);
      throw error;
    }
  }

  // All renames succeeded; cleanup the journal
  await cleanupPatchJournal(committedJournal);
}

function rejectOperation(
  operationIndex: number,
  code: NativePatchRuntimeRejection['code'],
  message: string,
  options: {
    operation?: NativePatchOperation;
    liveContext?: NativePatchRuntimeRejection['liveContext'];
    hint: string;
  },
): NativePatchRejectedResult {
  return {
    ok: false,
    atomic: true,
    appliedOperations: 0,
    rejection: {
      operationIndex,
      code,
      message,
      requestedContext: buildRequestedContext(options.operation),
      ...(options.liveContext ? { liveContext: options.liveContext } : {}),
      hint: options.hint,
    },
  };
}

function buildRequestedContext(operation?: NativePatchOperation): NativePatchRuntimeRejection['requestedContext'] {
  if (!operation) {
    return {};
  }

  return {
    ...(operation.op === 'edit' ? { oldText: operation.oldText } : { diff: operation.diff }),
    ...(operation.anchorBefore ? { anchorBefore: operation.anchorBefore } : {}),
    ...(operation.anchorAfter ? { anchorAfter: operation.anchorAfter } : {}),
  };
}

function buildLiveContext(filePath: string, content: string): NativePatchRuntimeRejection['liveContext'] {
  const excerptLines = splitTextIntoLines(content).slice(0, 8);
  return {
    path: filePath,
    excerpt: excerptLines.join('\n'),
    startLine: excerptLines.length === 0 ? undefined : 1,
    endLine: excerptLines.length === 0 ? undefined : excerptLines.length,
  };
}

function findAllMatches(content: string, needle: string): MatchCandidate[] {
  const matches: MatchCandidate[] = [];
  if (needle.length === 0) {
    return matches;
  }

  let index = 0;
  while (index <= content.length - needle.length) {
    const found = content.indexOf(needle, index);
    if (found === -1) {
      break;
    }
    matches.push({ start: found, end: found + needle.length });
    index = found + 1;
  }
  return matches;
}

function matchSatisfiesAnchors(
  content: string,
  match: MatchCandidate,
  operation: NativePatchEditOperation,
): boolean {
  if (operation.anchorBefore) {
    const anchorBefore = normalizePatchText(operation.anchorBefore);
    if (!content.slice(0, match.start).endsWith(anchorBefore)) {
      return false;
    }
  }
  if (operation.anchorAfter) {
    const anchorAfter = normalizePatchText(operation.anchorAfter);
    if (!content.slice(match.end).startsWith(anchorAfter)) {
      return false;
    }
  }
  return true;
}

function normalizeLineEndings(text: string): {
  text: string;
  lineEnding: '\n' | '\r\n';
  hadTrailingNewline: boolean;
} {
  const lineEnding = hasPureCrLf(text) ? '\r\n' : '\n';
  const normalizedText = text.replace(/\r\n/g, '\n');
  return {
    text: normalizedText,
    lineEnding,
    hadTrailingNewline: normalizedText.endsWith('\n'),
  };
}

function denormalizeStagedText(stagedFile: StagedFile, normalizedText: string): string {
  let adjusted = normalizedText;

  if (stagedFile.hadTrailingNewline && !adjusted.endsWith('\n')) {
    adjusted += '\n';
  } else if (!stagedFile.hadTrailingNewline && adjusted.endsWith('\n')) {
    adjusted = adjusted.replace(/\n$/, '');
  }

  if (stagedFile.lineEnding === '\r\n') {
    adjusted = adjusted.replace(/\n/g, '\r\n');
  }
  return adjusted;
}

function normalizePatchText(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

function hasPureCrLf(text: string): boolean {
  if (!text.includes('\r\n')) {
    return false;
  }
  return !text.replace(/\r\n/g, '').includes('\n');
}

function splitTextIntoLines(text: string): string[] {
  if (text.length === 0) {
    return [];
  }

  const lines = text.split('\n');
  if (lines.at(-1) === '') {
    lines.pop();
  }
  return lines;
}

function splitLinesPreserveEmpty(text: string): string[] {
  return text.length === 0 ? [] : text.split('\n');
}

function joinLines(lines: string[]): string {
  if (lines.length === 0) {
    return '';
  }
  return lines.join('\n');
}

function containsLineSequence(lines: string[], sequence: string[]): boolean {
  if (sequence.length === 0) {
    return false;
  }

  for (let index = 0; index <= lines.length - sequence.length; index += 1) {
    if (arrayEquals(lines.slice(index, index + sequence.length), sequence)) {
      return true;
    }
  }
  return false;
}

function arrayEquals(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function toPosixRelativePath(relativePath: string): string {
  return relativePath.split(path.sep).join(path.posix.sep);
}
