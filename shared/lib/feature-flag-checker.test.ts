// allow-feature-flag: this is the preflight guard's own test; fixture tokens
// (WAVEMILL_FOO_DISABLED, WAVEMILL_FOO_PERM, etc.) are not real flags.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkFeatureFlags, parseBaseline, parseFeatureFlagsDoc, scanFileForTokens, MAX_OPEN_SHADOWS } from './feature-flag-checker.ts';

const BASE_DOC = `# Feature flags

## Open shadow modes

| Shadow | Switch(es) | Owner issue | Added | Removal criterion | Removal issue | Remove by |
|---|---|---|---|---|---|---|
| \`WAVEMILL_FOO_SHADOW\` | \`WAVEMILL_FOO_SHADOW\` | HOK-1 | 2026-10-20 | retire once stable | HOK-2 | 2026-11-19 |

## Kill switches, rollbacks, skips and legacy paths

| Flag | Default | Purpose | Owner issue | Added | Removal criterion | Removal issue | Remove by |
|---|---|---|---|---|---|---|---|
| \`WAVEMILL_FOO_DISABLED\` | 0 | one-line | HOK-3 | 2026-10-20 | retire with X | HOK-4 | 2026-11-19 |

## Permanent operator settings

| Flag | Default | Purpose | Why permanent |
|---|---|---|---|
| \`WAVEMILL_FOO_PERM\` | — | tuning knob | permanent tuning |
`;

function makeFiles(contents: Record<string, string>): { files: string[]; readFile: (abs: string) => string } {
  const map = new Map<string, string>();
  for (const [rel, text] of Object.entries(contents)) {
    map.set(rel, text);
    map.set('/repo/' + rel, text);
  }
  const files = Object.keys(contents);
  return {
    files,
    readFile: (abs: string) => {
      const relAbs = abs.replace(/^\/repo\//, '');
      const found = map.get(abs) ?? map.get(relAbs);
      if (found === undefined) throw new Error(`no file ${abs}`);
      return found;
    },
  };
}

describe('scanFileForTokens', () => {
  it('finds every WAVEMILL_* token and honours the suppression marker', () => {
    // "same line or line above" suppresses, matching the HOK-3223 pattern.
    const source = [
      "if (process.env.WAVEMILL_X) {}",
      "// allow-feature-flag: just a doc",
      "// WAVEMILL_Y lives here (suppressed, previous line has the marker)",
      "process.env.WAVEMILL_Z // allow-feature-flag: fake",
      "// unrelated line, previous had the marker so this is still suppressed",
      "const q = process.env.WAVEMILL_W; // real token on its own line",
    ].join('\n');
    const findings = scanFileForTokens('foo.ts', source);
    const tokens = findings.map((f) => f.token).sort();
    assert.deepEqual(tokens, ['WAVEMILL_W', 'WAVEMILL_X']);
  });
});

describe('parseFeatureFlagsDoc', () => {
  it('counts rows per table and extracts backticked names', () => {
    const parsed = parseFeatureFlagsDoc(BASE_DOC);
    assert.equal(parsed.shadowCount, 1);
    assert.equal(parsed.rows.length, 3);
    assert.deepEqual(parsed.rows.map((r) => r.name), ['WAVEMILL_FOO_SHADOW', 'WAVEMILL_FOO_DISABLED', 'WAVEMILL_FOO_PERM']);
  });
});

describe('parseBaseline', () => {
  it('requires a # reason on each entry', () => {
    const parsed = parseBaseline(['# header', 'WAVEMILL_ONE  # plumbing', 'WAVEMILL_TWO'].join('\n'));
    assert.deepEqual(parsed.missingReason, ['WAVEMILL_TWO']);
  });
});

describe('checkFeatureFlags', () => {
  const common = { repoDir: '/repo', now: new Date('2026-10-20T00:00:00Z'), baselineContent: '# empty\n' };

  it('passes when every token is documented', () => {
    const code = makeFiles({ 'src/a.ts': 'process.env.WAVEMILL_FOO_SHADOW; process.env.WAVEMILL_FOO_DISABLED; process.env.WAVEMILL_FOO_PERM;' });
    const result = checkFeatureFlags({ ...common, docContent: BASE_DOC, ...code });
    assert.ok(result.ok, JSON.stringify(result.findings));
  });

  it('fails on an undocumented token', () => {
    const code = makeFiles({ 'src/a.ts': 'process.env.WAVEMILL_FOO_SHADOW; process.env.WAVEMILL_FOO_DISABLED; process.env.WAVEMILL_FOO_PERM; process.env.WAVEMILL_SNEAKY_DISABLED;' });
    const result = checkFeatureFlags({ ...common, docContent: BASE_DOC, ...code });
    assert.equal(result.ok, false);
    assert.ok(result.findings.some((f) => f.kind === 'undocumented-token' && f.message.includes('WAVEMILL_SNEAKY_DISABLED')));
  });

  it('matches a prefix row against a dynamic token', () => {
    const doc = BASE_DOC + '\n\n## Open shadow modes\n\n| Shadow | Switch(es) | Owner issue | Added | Removal criterion | Removal issue | Remove by |\n|---|---|---|---|---|---|---|\n| `WAVEMILL_PFX_*` | — | HOK-10 | 2026-10-20 | later | HOK-11 | 2026-11-19 |\n';
    // Prefix is in the shadow table so it also fails the 2-shadow cap test; use permanent to be safe.
    const permDoc = BASE_DOC.replace('| `WAVEMILL_FOO_PERM` | — | tuning knob | permanent tuning |', '| `WAVEMILL_FOO_PERM` | — | tuning knob | permanent tuning |\n| `WAVEMILL_PFX_*` | — | prefix for runtime names | permanent dynamic |');
    // allow-template-curly: fixture source literal fed to the scanner
    const code = makeFiles({ 'src/a.ts': 'const name = `WAVEMILL_PFX_${x}`;' });
    const result = checkFeatureFlags({ ...common, docContent: permDoc, ...code });
    // Must still find the three required canonical names, so add them too
    code.files.push('src/b.ts');
    (code.readFile as unknown as { bump?: boolean }).bump = true;
    // allow-template-curly: fixture source literal fed to the scanner
    const code2 = makeFiles({ 'src/a.ts': 'process.env.WAVEMILL_FOO_SHADOW; process.env.WAVEMILL_FOO_DISABLED; process.env.WAVEMILL_FOO_PERM; const name = `WAVEMILL_PFX_${x}`;' });
    const r2 = checkFeatureFlags({ ...common, docContent: permDoc, ...code2 });
    assert.ok(r2.ok, JSON.stringify(r2.findings));
  });

  it('fails when a kill-switch pattern token is in the baseline', () => {
    const baseline = ['WAVEMILL_SOMETHING_DISABLED  # should not be here'].join('\n');
    const code = makeFiles({ 'src/a.ts': 'process.env.WAVEMILL_FOO_SHADOW; process.env.WAVEMILL_FOO_DISABLED; process.env.WAVEMILL_FOO_PERM; process.env.WAVEMILL_SOMETHING_DISABLED;' });
    const result = checkFeatureFlags({ ...common, docContent: BASE_DOC, baselineContent: baseline, ...code });
    assert.equal(result.ok, false);
    assert.ok(result.findings.some((f) => f.kind === 'baseline-kill-switch'));
  });

  it('fails on a baseline entry that no longer appears in code', () => {
    const baseline = 'WAVEMILL_GONE  # was plumbing\n';
    const code = makeFiles({ 'src/a.ts': 'process.env.WAVEMILL_FOO_SHADOW; process.env.WAVEMILL_FOO_DISABLED; process.env.WAVEMILL_FOO_PERM;' });
    const result = checkFeatureFlags({ ...common, docContent: BASE_DOC, baselineContent: baseline, ...code });
    assert.equal(result.ok, false);
    assert.ok(result.findings.some((f) => f.kind === 'baseline-stale'));
  });

  it('fails on a doc row that no longer appears in code', () => {
    const code = makeFiles({ 'src/a.ts': 'process.env.WAVEMILL_FOO_SHADOW; process.env.WAVEMILL_FOO_PERM;' });
    const result = checkFeatureFlags({ ...common, docContent: BASE_DOC, ...code });
    assert.equal(result.ok, false);
    assert.ok(result.findings.some((f) => f.kind === 'doc-stale' && f.message.includes('WAVEMILL_FOO_DISABLED')));
  });

  it('fails on a shadow row missing a required field', () => {
    const broken = BASE_DOC.replace('HOK-1 | 2026-10-20', ' | 2026-10-20');
    const code = makeFiles({ 'src/a.ts': 'process.env.WAVEMILL_FOO_SHADOW; process.env.WAVEMILL_FOO_DISABLED; process.env.WAVEMILL_FOO_PERM;' });
    const result = checkFeatureFlags({ ...common, docContent: broken, ...code });
    assert.equal(result.ok, false);
    assert.ok(result.findings.some((f) => f.kind === 'missing-field'));
  });

  it('fails on a bad Linear issue id', () => {
    const broken = BASE_DOC.replace('HOK-1', 'not-an-id');
    const code = makeFiles({ 'src/a.ts': 'process.env.WAVEMILL_FOO_SHADOW; process.env.WAVEMILL_FOO_DISABLED; process.env.WAVEMILL_FOO_PERM;' });
    const result = checkFeatureFlags({ ...common, docContent: broken, ...code });
    assert.equal(result.ok, false);
    assert.ok(result.findings.some((f) => f.kind === 'bad-issue-id'));
  });

  it('fails when remove-by is more than 30 days past added (and policy start)', () => {
    const broken = BASE_DOC.replace('2026-11-19', '2026-12-01');
    const code = makeFiles({ 'src/a.ts': 'process.env.WAVEMILL_FOO_SHADOW; process.env.WAVEMILL_FOO_DISABLED; process.env.WAVEMILL_FOO_PERM;' });
    const result = checkFeatureFlags({ ...common, docContent: broken, ...code });
    assert.equal(result.ok, false);
    assert.ok(result.findings.some((f) => f.kind === 'remove-by-too-late'));
  });

  it('warns on an overdue row but still passes', () => {
    const code = makeFiles({ 'src/a.ts': 'process.env.WAVEMILL_FOO_SHADOW; process.env.WAVEMILL_FOO_DISABLED; process.env.WAVEMILL_FOO_PERM;' });
    const result = checkFeatureFlags({ ...common, now: new Date('2026-12-20T00:00:00Z'), docContent: BASE_DOC, ...code });
    assert.ok(result.ok, JSON.stringify(result.findings));
    assert.ok(result.warnings.some((w) => w.kind === 'overdue'));
  });

  it('rejects more than MAX_OPEN_SHADOWS rows', () => {
    const extraRows = Array.from({ length: MAX_OPEN_SHADOWS + 1 }, (_, i) =>
      `| \`WAVEMILL_EXTRA_${i}_SHADOW\` | \`WAVEMILL_EXTRA_${i}_SHADOW\` | HOK-${100 + i} | 2026-10-20 | later | HOK-${200 + i} | 2026-11-19 |`,
    ).join('\n');
    const bigDoc = `# Feature flags\n\n## Open shadow modes\n\n| Shadow | Switch(es) | Owner issue | Added | Removal criterion | Removal issue | Remove by |\n|---|---|---|---|---|---|---|\n${extraRows}\n\n## Kill switches, rollbacks, skips and legacy paths\n\n| Flag | Default | Purpose | Owner issue | Added | Removal criterion | Removal issue | Remove by |\n|---|---|---|---|---|---|---|---|\n\n## Permanent operator settings\n\n| Flag | Default | Purpose | Why permanent |\n|---|---|---|---|\n`;
    const codeSrc = Array.from({ length: MAX_OPEN_SHADOWS + 1 }, (_, i) => `process.env.WAVEMILL_EXTRA_${i}_SHADOW`).join(';');
    const code = makeFiles({ 'src/a.ts': codeSrc });
    const result = checkFeatureFlags({ ...common, docContent: bigDoc, ...code });
    assert.equal(result.ok, false);
    assert.ok(result.findings.some((f) => f.kind === 'too-many-shadows'));
  });

  it('respects the suppression marker in code', () => {
    const code = makeFiles({ 'src/a.ts': [
      'process.env.WAVEMILL_FOO_SHADOW;',
      'process.env.WAVEMILL_FOO_DISABLED;',
      'process.env.WAVEMILL_FOO_PERM;',
      '// allow-feature-flag: dynamic — the next line builds a name at runtime',
      // allow-template-curly: fixture source literal fed to the scanner
      'const x = `WAVEMILL_DYNAMIC_${y}`;',
    ].join('\n') });
    const result = checkFeatureFlags({ ...common, docContent: BASE_DOC, ...code });
    assert.ok(result.ok, JSON.stringify(result.findings));
  });
});
