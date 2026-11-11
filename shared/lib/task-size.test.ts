import assert from 'node:assert/strict';
import posix from 'node:path/posix';
import { describe, it } from 'node:test';
import {
  DEFAULT_TASK_SIZE_ANCHOR,
  DEFAULT_TASK_SIZE_CORE_FILES,
  type TaskSizeLimits,
} from './config.ts';
import {
  estimateTaskSize,
  evaluateRecordedTaskSize,
  evaluateTaskSize,
  extractSizeSection,
  parseEstimatedAddedLines,
  parseSizeSection,
  parseSliceProposal,
  renderSizeSection,
  stripSizeSection,
  type TaskSizeEstimate,
} from './task-size.ts';
import type { RepoProbe } from './touch-set-predictor.ts';

const LIMITS: TaskSizeLimits = {
  enabled: true,
  maxAddedLines: 800,
  maxFiles: 12,
  coreFiles: DEFAULT_TASK_SIZE_CORE_FILES,
  anchorCoreFile: DEFAULT_TASK_SIZE_ANCHOR,
  maxCoreCompanions: 2,
};

function fakeProbe(files: string[]): RepoProbe {
  const set = new Set(files);
  return {
    fileExists: (path) => set.has(path),
    findByBasename: (name) => files.filter((file) => posix.basename(file) === name),
    findBySuffix: (suffix) => files.filter((file) => file.endsWith(`/${suffix}`)),
    grepFiles: () => [],
    definitionFiles: () => [],
  };
}

function packet(options: {
  files: string[];
  estimatedAddedLines?: number | null;
  extra?: string;
}): string {
  const keyFiles = options.files.map((file) => `- \`${file}\``).join('\n');
  const lines = [
    '## 1. Objective',
    '',
    'Do the thing',
    '',
    '## 2. Technical Context',
    '',
    '### Key Files',
    keyFiles,
    '',
    '## 3. Implementation Approach',
    '',
    '1. Make the change',
  ];
  if (options.estimatedAddedLines !== undefined && options.estimatedAddedLines !== null) {
    lines.push('', `Estimated added lines: ${options.estimatedAddedLines}`);
  }
  if (options.extra) lines.push('', options.extra);
  lines.push('', '## 4. Success Criteria', '', '- [ ] The thing works');
  return lines.join('\n');
}

function estimate(packetText: string, probe: RepoProbe | null = null): TaskSizeEstimate {
  return estimateTaskSize(packetText, { probe, limits: LIMITS });
}

describe('estimateTaskSize', () => {
  // protects: a listed new file is dropped from the estimate and an oversized
  // task slips past the hold.
  it('counts existing and not-yet-existing listed files', () => {
    const probe = fakeProbe(['src/existing.ts', 'shared/lib/task-size.ts']);
    const result = estimate(packet({
      files: ['src/existing.ts', 'shared/lib/task-size.ts', 'src/brand-new.ts'],
    }), probe);

    assert.deepEqual(result.files, ['shared/lib/task-size.ts', 'src/brand-new.ts', 'src/existing.ts']);
    assert.equal(result.linesSource, 'missing');
  });

  // protects: a line number written with thousands separators or a leading
  // tilde is lost, so an oversized task is never held by the lines rule.
  it('parses a formatted added-lines estimate', () => {
    assert.equal(parseEstimatedAddedLines('Estimated added lines: ~1,140'), 1140);
    assert.equal(parseEstimatedAddedLines('**Estimated added lines:** 240'), 240);
    assert.equal(parseEstimatedAddedLines('no estimate here'), null);

    const result = estimate(packet({ files: ['src/a.ts'], estimatedAddedLines: 1140 }), fakeProbe(['src/a.ts']));
    assert.equal(result.addedLines, 1140);
    assert.equal(result.linesSource, 'llm');
  });

  // protects: the core-file list is not intersected with the configured core
  // files, so the core rule can never trip (or trips on everything).
  it('records the core files among the touched files', () => {
    const probe = fakeProbe(['shared/lib/wavemill-monitor.sh', 'tools/tend.ts', 'src/a.ts']);
    const result = estimate(packet({
      files: ['shared/lib/wavemill-monitor.sh', 'tools/tend.ts', 'src/a.ts'],
    }), probe);

    assert.deepEqual(result.coreFiles, ['shared/lib/wavemill-monitor.sh', 'tools/tend.ts']);
  });

  // protects: a missing estimate aborts annotation, when it must fall back to
  // files/core only and leave the task launchable.
  it('keeps a missing lines estimate as null', () => {
    const result = estimate(packet({ files: ['src/a.ts'] }), fakeProbe(['src/a.ts']));
    assert.equal(result.addedLines, null);
    assert.equal(result.linesSource, 'missing');
  });
});

describe('evaluateTaskSize', () => {
  const base = (overrides: Partial<TaskSizeEstimate> = {}): TaskSizeEstimate => ({
    addedLines: 10,
    files: ['src/a.ts'],
    coreFiles: [],
    linesSource: 'llm',
    ...overrides,
  });

  // protects: an off-by-one at the line limit holds a task that is exactly at
  // the limit (the rule is strictly greater).
  it('holds at 801 lines but not at 800', () => {
    assert.deepEqual(evaluateTaskSize(base({ addedLines: 800 }), LIMITS), { oversized: false, reasons: [] });
    assert.deepEqual(evaluateTaskSize(base({ addedLines: 801 }), LIMITS), {
      oversized: true,
      reasons: ['lines'],
    });
  });

  // protects: an off-by-one at the file limit holds a task touching exactly
  // 12 files.
  it('holds at 13 files but not at 12', () => {
    const files = Array.from({ length: 13 }, (_, index) => `src/file-${index}.ts`);
    assert.deepEqual(evaluateTaskSize(base({ files: files.slice(0, 12) }), LIMITS), {
      oversized: false,
      reasons: [],
    });
    assert.deepEqual(evaluateTaskSize(base({ files }), LIMITS), { oversized: true, reasons: ['files'] });
  });

  // protects: the core rule trips one companion early, holding tasks that
  // touch the monitor plus a single other core file.
  it('holds the monitor plus two other core files but not the monitor plus one', () => {
    const anchor = 'shared/lib/wavemill-monitor.sh';
    assert.deepEqual(evaluateTaskSize(base({ coreFiles: [anchor, 'tools/tend.ts'] }), LIMITS), {
      oversized: false,
      reasons: [],
    });
    assert.deepEqual(
      evaluateTaskSize(base({ coreFiles: [anchor, 'tools/tend.ts', 'shared/lib/wavemill-mill.sh'] }), LIMITS),
      { oversized: true, reasons: ['core'] },
    );
  });

  // protects: core files without the anchor are treated as oversized, holding
  // ordinary tasks that happen to touch two shared modules.
  it('does not apply the core rule without the anchor', () => {
    assert.deepEqual(
      evaluateTaskSize(base({ coreFiles: ['tools/tend.ts', 'shared/lib/wavemill-mill.sh'] }), LIMITS),
      { oversized: false, reasons: [] },
    );
  });

  // protects: a missing lines estimate is read as zero and the task is never
  // oversized by lines, hiding a genuinely huge task.
  it('ignores the lines rule when the estimate is missing', () => {
    assert.deepEqual(evaluateTaskSize(base({ addedLines: null, linesSource: 'missing' }), LIMITS), {
      oversized: false,
      reasons: [],
    });
  });

  // protects: `taskSize.enabled: false` still holds a huge task, so the
  // kill switch cannot restore launch-as-today.
  it('never holds when the feature is disabled', () => {
    assert.deepEqual(
      evaluateTaskSize(base({ addedLines: 5_000, files: Array.from({ length: 40 }, (_, i) => `s/${i}.ts`) }), {
        ...LIMITS,
        enabled: false,
      }),
      { oversized: false, reasons: [] },
    );
  });
});

describe('evaluateRecordedTaskSize', () => {
  // protects: the picker re-derives the verdict from the recorded count with a
  // different rule than expansion wrote.
  it('matches evaluateTaskSize for the same numbers', () => {
    const estimateResult: TaskSizeEstimate = {
      addedLines: 900,
      files: Array.from({ length: 13 }, (_, index) => `src/file-${index}.ts`),
      coreFiles: [],
      linesSource: 'llm',
    };
    const verdict = evaluateTaskSize(estimateResult, LIMITS);
    assert.deepEqual(
      evaluateRecordedTaskSize(
        { addedLines: estimateResult.addedLines, fileCount: estimateResult.files.length, coreFiles: estimateResult.coreFiles },
        LIMITS,
      ),
      verdict,
    );
  });
});

describe('renderSizeSection / parseSizeSection', () => {
  const estimateResult: TaskSizeEstimate = {
    addedLines: 1140,
    files: ['shared/lib/plan-queue-utils.ts', 'shared/lib/task-size.ts'],
    coreFiles: ['shared/lib/wavemill-monitor.sh'],
    linesSource: 'llm',
  };
  const verdict = { oversized: true, reasons: ['lines', 'files'] as const };
  const slices = [
    { title: 'Add the estimator', scope: 'Add shared/lib/task-size.ts.', files: ['shared/lib/task-size.ts'], estimatedAddedLines: 240 },
    { title: 'Wire the hold', scope: 'Wire the picker.', files: ['shared/lib/plan-queue-utils.ts'], estimatedAddedLines: 180 },
  ];

  // protects: the §12 round-trip loses numbers or slices, so the picker cannot
  // re-evaluate and the operator cannot accept what expansion proposed.
  it('round-trips the estimate, verdict and slices', () => {
    const rendered = renderSizeSection(estimateResult, verdict as never, slices);
    const parsed = parseSizeSection(`## 11. Proposed Labels\n\n- x\n\n${rendered}`);

    assert.ok(parsed);
    assert.equal(parsed.addedLines, 1140);
    assert.deepEqual(parsed.files, estimateResult.files);
    assert.deepEqual(parsed.coreFiles, estimateResult.coreFiles);
    assert.equal(parsed.linesSource, 'llm');
    assert.equal(parsed.slicesUnavailable, false);
    assert.deepEqual(parsed.slices, slices);
  });

  // protects: an unavailable proposal is read back as an empty proposal and
  // the operator is offered nothing to accept.
  it('round-trips an unavailable slice proposal', () => {
    const rendered = renderSizeSection(estimateResult, verdict as never, [], { slicesUnavailable: true });
    const parsed = parseSizeSection(rendered);
    assert.ok(parsed);
    assert.equal(parsed.slicesUnavailable, true);
    assert.deepEqual(parsed.slices, []);
  });

  // protects: a packet expanded before HOK-3469 is treated as having a size
  // section and wrongly held.
  it('returns null for a packet without §12', () => {
    assert.equal(parseSizeSection(packet({ files: ['src/a.ts'] })), null);
    assert.equal(extractSizeSection(packet({ files: ['src/a.ts'] })), null);
  });

  // protects: re-expansion appends a second §12 block instead of replacing
  // the first, so the picker reads the stale estimate.
  it('replaces a previous §12 on re-annotation', () => {
    const first = renderSizeSection(estimateResult, verdict as never, slices);
    const recomposed = stripSizeSection(`# Header\n\n## 1. Objective\n\n${first}\n## 13. Rollback Plan\n\nRevert.\n`);
    assert.equal(parseSizeSection(recomposed), null);
    assert.match(recomposed, /## 13\. Rollback Plan/);
    assert.doesNotMatch(recomposed, /## 12\. Size Estimate/);
  });
});

describe('parseSliceProposal', () => {
  const slice = (title: string) => ({ title, scope: 's', files: ['a.ts'], estimatedAddedLines: 100 });

  // protects: a one-slice proposal is accepted and the task is "split" into
  // itself.
  it('rejects fewer than two slices', () => {
    assert.equal(parseSliceProposal(JSON.stringify([slice('one')])), null);
  });

  // protects: a runaway proposal creates a fan of tiny slices.
  it('rejects more than four slices', () => {
    assert.equal(parseSliceProposal(JSON.stringify([1, 2, 3, 4, 5].map((n) => slice(`s${n}`)))), null);
  });

  // protects: a malformed response throws out of expansion instead of
  // degrading to "slices: unavailable".
  it('returns null for malformed JSON', () => {
    assert.equal(parseSliceProposal('not json at all'), null);
    assert.equal(parseSliceProposal('{"title":"x"}'), null);
  });

  // protects: fenced JSON from the model is rejected, so every real proposal
  // degrades to unavailable.
  it('accepts a fenced JSON array and normalizes it', () => {
    const parsed = parseSliceProposal(`\`\`\`json\n${JSON.stringify([slice('a'), slice('b')])}\n\`\`\``);
    assert.deepEqual(parsed?.map((item) => item.title), ['a', 'b']);
  });
});
