// Shared stateful fake of the GitHub CLI (HOK-3226).
//
// One fake for every test that needs `gh`, instead of a per-test stub that
// encodes that test author's belief about GitHub. State lives in a JSON file
// ($FAKE_GH_STATE) and is backed by a real bare git repository
// ($FAKE_GH_ORIGIN): PR heads are read live from the origin's refs, so a
// `git push` is visible to the next `gh pr view`, and `gh pr merge` writes a
// real merge/squash commit onto the base branch.
//
// Every invocation is appended to $FAKE_GH_LOG (one JSON line). Anything the
// fake does not model is appended to $FAKE_GH_UNHANDLED and fails with exit 1,
// so a journey can assert that production code never strayed off the modelled
// surface. Faults are injected through `faults` in the state file (see
// tests/fakes/README.md).

import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const STATE = process.env.FAKE_GH_STATE;
const LOG = process.env.FAKE_GH_LOG;
const UNHANDLED = process.env.FAKE_GH_UNHANDLED;

if (!STATE) {
  process.stderr.write('fake gh: FAKE_GH_STATE is not set\n');
  process.exit(4);
}

const argv = process.argv.slice(2);
const stdinText = argv.includes('--input') ? safeReadStdin() : '';

function safeReadStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

if (LOG) {
  appendFileSync(LOG, `${JSON.stringify({ at: new Date().toISOString(), cwd: process.cwd(), argv })}\n`);
}

// ── state + locking ─────────────────────────────────────────────────────────

const LOCK = `${STATE}.lock`;

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Lock = a directory holding the owner's pid. A writer killed mid-update
// (the mill's timeouts do kill gh) leaves the directory behind; a lock whose
// owner is gone is taken over immediately instead of stalling every caller.
function ownerAlive(lock) {
  let pid;
  try {
    pid = Number(readFileSync(`${lock}/pid`, 'utf8'));
  } catch {
    // No pid yet: a live owner writes it right after mkdir, so only a young
    // lock gets the benefit of the doubt.
    try {
      return Date.now() - statSync(lock).mtimeMs < 1000;
    } catch {
      return false;
    }
  }
  if (!pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function acquireLock(lock) {
  for (let attempt = 0; ; attempt++) {
    try {
      mkdirSync(lock);
      writeFileSync(`${lock}/pid`, String(process.pid));
      return;
    } catch {
      if (attempt > 20 && !ownerAlive(lock)) {
        rmSync(lock, { recursive: true, force: true });
        continue;
      }
      if (attempt > 2000) rmSync(lock, { recursive: true, force: true });
      sleepMs(2);
    }
  }
}

function releaseLock(lock) {
  rmSync(lock, { recursive: true, force: true });
}


function withLock(fn) {
  acquireLock(LOCK);
  try {
    return fn();
  } finally {
    releaseLock(LOCK);
  }
}

function loadState() {
  const state = JSON.parse(readFileSync(STATE, 'utf8'));
  state.prs ??= {};
  state.nextPr ??= 1;
  state.faults ??= [];
  state.checks ??= { default: [{ name: 'ci', conclusion: 'SUCCESS' }] };
  state.requiredChecks ??= [];
  state.headLag ??= {};
  return state;
}

function saveState(state) {
  const tmp = `${STATE}.tmp.${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, STATE);
}

// ── argv helpers ────────────────────────────────────────────────────────────

const VALUE_FLAGS = new Set([
  '--json', '--jq', '-q', '--repo', '-R', '--state', '-s', '--base', '-B', '--head', '-H', '--label', '-l',
  '--search', '-S', '--limit', '-L', '--author', '-A', '--title', '-t', '--body', '-b', '--body-file', '-F',
  '--add-label', '--remove-label', '--comment', '-c', '--method', '-X', '--input', '--field', '-f',
  '--raw-field', '--template', '-T', '--hostname', '--header', '-H',
]);

function parseArgs(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--') && arg.includes('=')) {
      const [key, ...rest] = arg.split('=');
      push(flags, key, rest.join('='));
    } else if (VALUE_FLAGS.has(arg) && i + 1 < args.length) {
      push(flags, arg, args[++i]);
    } else if (arg.startsWith('-') && arg !== '-') {
      push(flags, arg, true);
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

function push(flags, key, value) {
  (flags[key] ??= []).push(value);
}

const one = (flags, ...keys) => {
  for (const key of keys) if (flags[key]) return flags[key][flags[key].length - 1];
  return undefined;
};
const many = (flags, ...keys) => keys.flatMap((key) => flags[key] ?? []);

// ── output ──────────────────────────────────────────────────────────────────

function fail(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function unhandled(reason) {
  if (UNHANDLED) appendFileSync(UNHANDLED, `${JSON.stringify({ argv, reason })}\n`);
  fail(`fake gh: unhandled invocation (${reason}): gh ${argv.join(' ')}`);
}

function project(value, fields) {
  if (!fields) return value;
  const keys = String(fields).split(',').map((f) => f.trim()).filter(Boolean);
  const pick = (obj) => Object.fromEntries(keys.map((key) => [key, obj[key] ?? null]));
  return Array.isArray(value) ? value.map(pick) : pick(value);
}

function emit(value, flags, { projectFields = true } = {}) {
  const fields = projectFields ? one(flags, '--json') : undefined;
  const shaped = fields ? project(value, fields) : value;
  const jq = one(flags, '--jq', '-q');
  const text = JSON.stringify(shaped);
  if (jq) {
    const res = spawnSync('jq', ['-r', jq], { input: text, encoding: 'utf8' });
    if (res.status !== 0) fail(`fake gh: jq failed: ${res.stderr}`);
    process.stdout.write(res.stdout);
  } else {
    process.stdout.write(`${text}\n`);
  }
  process.exit(0);
}

// ── git origin helpers ──────────────────────────────────────────────────────

function git(args, { allowFail = false, input } = {}) {
  const origin = process.env.FAKE_GH_ORIGIN;
  if (!origin) fail('fake gh: FAKE_GH_ORIGIN is not set');
  const res = spawnSync('git', ['--git-dir', origin, ...args], { encoding: 'utf8', input });
  if (res.status !== 0) {
    if (allowFail) return null;
    fail(`fake gh: git ${args.join(' ')} failed: ${res.stderr}`);
  }
  return res.stdout.trim();
}

const refSha = (branch) => git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { allowFail: true });

function cwdBranch() {
  const res = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' });
  return res.status === 0 ? res.stdout.trim() : null;
}

// ── PR model ────────────────────────────────────────────────────────────────

function checksFor(state, pr) {
  const spec = pr.checks ?? state.checks.byPr?.[pr.number] ?? state.checks.default ?? [];
  return spec.map((check) => ({
    name: check.name,
    conclusion: check.conclusion ?? 'SUCCESS',
  }));
}

function checkState(conclusion) {
  if (conclusion === 'SUCCESS' || conclusion === 'NEUTRAL' || conclusion === 'SKIPPED') return 'pass';
  if (conclusion === 'PENDING' || conclusion === 'IN_PROGRESS' || conclusion === 'QUEUED') return 'pending';
  return 'fail';
}

function liveHead(state, pr, { observe }) {
  if (pr.state !== 'OPEN') return pr.headRefOid;
  const actual = refSha(pr.headRefName) ?? pr.headRefOid;
  // Read-after-write lag (HOK-3105 class): after the head moves, the first
  // `headLag[n]` reads still report the previously observed head.
  const lag = state.headLag[pr.number] ?? 0;
  if (actual !== pr.observedHead && pr.observedHead && lag > 0) {
    if (observe) state.headLag[pr.number] = lag - 1;
    return pr.observedHead;
  }
  if (observe) pr.observedHead = actual;
  return actual;
}

function view(state, pr, { observe = true } = {}) {
  const head = liveHead(state, pr, { observe });
  const checks = checksFor(state, pr);
  const buckets = checks.map((c) => checkState(c.conclusion));
  const baseSha = refSha(pr.baseRefName) ?? '';
  const behind = pr.state === 'OPEN' && baseSha && head
    ? git(['merge-base', '--is-ancestor', baseSha, head], { allowFail: true }) === null
    : false;
  // Mergeability is the real merge, as on GitHub: a head that cannot merge
  // cleanly into its base reads CONFLICTING / DIRTY until someone resolves it.
  const conflicted = behind && !mergeTree(baseSha, head);
  const mergeStateStatus = pr.overrides?.mergeStateStatus
    ?? (pr.state !== 'OPEN' ? 'UNKNOWN'
      : conflicted ? 'DIRTY'
        : buckets.includes('fail') ? 'BLOCKED'
          : buckets.includes('pending') ? 'BLOCKED'
            : behind && state.strictBehind ? 'BEHIND'
              : 'CLEAN');
  return {
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    isDraft: pr.isDraft ?? false,
    author: { id: 'U_fake', is_bot: false, login: pr.author ?? 'wavemill-bot', name: pr.author ?? 'wavemill-bot' },
    headRefName: pr.headRefName,
    headRefOid: head,
    baseRefName: pr.baseRefName,
    baseRefOid: baseSha,
    labels: (pr.labels ?? []).map((name) => ({ id: `LA_${name}`, name, description: '', color: 'ededed' })),
    url: `https://github.com/${state.repo}/pull/${pr.number}`,
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
    mergedAt: pr.mergedAt ?? null,
    closedAt: pr.closedAt ?? null,
    mergeCommit: pr.mergeCommitOid ? { oid: pr.mergeCommitOid } : null,
    mergeable: pr.overrides?.mergeable ?? (pr.state !== 'OPEN' ? 'UNKNOWN' : conflicted ? 'CONFLICTING' : 'MERGEABLE'),
    mergeStateStatus,
    statusCheckRollup: checks.map((c) => ({
      __typename: 'CheckRun',
      name: c.name,
      status: checkState(c.conclusion) === 'pending' ? 'IN_PROGRESS' : 'COMPLETED',
      conclusion: checkState(c.conclusion) === 'pending' ? '' : c.conclusion,
      workflowName: 'CI',
      startedAt: pr.createdAt,
      completedAt: checkState(c.conclusion) === 'pending' ? '0001-01-01T00:00:00Z' : pr.updatedAt,
      detailsUrl: `https://github.com/${state.repo}/actions/runs/1`,
    })),
    comments: pr.comments ?? [],
    files: [],
  };
}

// Ordered label/merge history per PR, so journeys can assert ordering (e.g.
// wm:ready was applied before the merge) even for label writes whose names
// arrive on stdin and never reach the call log.
function recordHistory(pr, entry, now) {
  (pr.history ??= []).push({ at: now, ...entry });
}

function addLabel(pr, label, now) {
  if (pr.labels.includes(label)) return;
  pr.labels.push(label);
  recordHistory(pr, { event: 'labeled', label }, now);
}

function removeLabel(pr, label, now) {
  if (!pr.labels.includes(label)) return;
  pr.labels = pr.labels.filter((name) => name !== label);
  recordHistory(pr, { event: 'unlabeled', label }, now);
}

function findPr(state, selector) {
  if (selector === undefined) {
    const branch = cwdBranch();
    const pr = Object.values(state.prs).find((p) => p.headRefName === branch && p.state === 'OPEN')
      ?? Object.values(state.prs).find((p) => p.headRefName === branch);
    if (!pr) fail(`no pull requests found for branch "${branch}"`);
    return pr;
  }
  const num = String(selector).match(/(?:pull\/)?(\d+)$/)?.[1];
  if (num && state.prs[num]) return state.prs[num];
  const byBranch = Object.values(state.prs).filter((p) => p.headRefName === selector);
  const pr = byBranch.find((p) => p.state === 'OPEN') ?? byBranch[byBranch.length - 1];
  if (!pr) fail(`no pull requests found for branch "${selector}"`);
  return pr;
}

function consumeFault(state, command) {
  const idx = state.faults.findIndex((f) => command.startsWith(f.cmd) && (f.remaining ?? 1) > 0);
  if (idx < 0) return null;
  const fault = state.faults[idx];
  fault.remaining = (fault.remaining ?? 1) - 1;
  return fault;
}

function mergeTree(base, head) {
  const res = spawnSync('git', ['--git-dir', process.env.FAKE_GH_ORIGIN, 'merge-tree', '--write-tree', base, head], { encoding: 'utf8' });
  if (res.status !== 0) return null;
  return res.stdout.split('\n')[0].trim();
}

function commitTree(tree, parents, message) {
  const args = ['commit-tree', tree, ...parents.flatMap((p) => ['-p', p]), '-m', message];
  return spawnSync('git', ['--git-dir', process.env.FAKE_GH_ORIGIN, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'fake-gh', GIT_AUTHOR_EMAIL: 'fake-gh@example.invalid',
      GIT_COMMITTER_NAME: 'fake-gh', GIT_COMMITTER_EMAIL: 'fake-gh@example.invalid',
    },
  }).stdout.trim();
}

// ── commands ────────────────────────────────────────────────────────────────

const { flags, positional } = parseArgs(argv);
const [group, sub, ...rest] = positional;
const command = `${group ?? ''} ${sub ?? ''}`.trim();

if (group === 'auth') process.exit(0);
if (group === '--version' || flags['--version']) {
  process.stdout.write('gh version 2.99.0 (fake)\n');
  process.exit(0);
}

withLock(() => {
  const state = loadState();
  const fault = consumeFault(state, command);
  if (fault) {
    saveState(state);
    fail(fault.stderr ?? `HTTP 502: fake gh injected fault for ${command}`, fault.exit ?? 1);
  }
  const now = new Date().toISOString();
  const result = dispatch(state, now);
  saveState(state);
  if (result) result();
});

function dispatch(state, now) {
  switch (command) {
    case 'repo view': {
      const value = {
        nameWithOwner: state.repo,
        name: state.repo.split('/')[1],
        owner: { login: state.repo.split('/')[0] },
        defaultBranchRef: { name: state.defaultBranch ?? 'main' },
        url: `https://github.com/${state.repo}`,
      };
      return () => emit(value, flags);
    }
    case 'pr list': {
      const stateFilter = String(one(flags, '--state', '-s') ?? 'open').toUpperCase();
      const base = one(flags, '--base', '-B');
      const head = one(flags, '--head', '-H');
      const labels = many(flags, '--label', '-l');
      const search = one(flags, '--search', '-S');
      const searchHeads = search ? [...String(search).matchAll(/head:(\S+)/g)].map((m) => m[1]) : null;
      const limit = Number(one(flags, '--limit', '-L') ?? 30);
      const list = Object.values(state.prs)
        .filter((pr) => stateFilter === 'ALL' || pr.state === stateFilter)
        .filter((pr) => !base || pr.baseRefName === base)
        .filter((pr) => !head || pr.headRefName === head)
        .filter((pr) => !searchHeads || searchHeads.includes(pr.headRefName))
        .filter((pr) => labels.every((label) => (pr.labels ?? []).includes(label)))
        .sort((a, b) => b.number - a.number)
        .slice(0, limit)
        .map((pr) => view(state, pr));
      return () => emit(list, flags);
    }
    case 'pr view': {
      const pr = findPr(state, rest[0]);
      const value = view(state, pr);
      return () => emit(value, flags);
    }
    case 'pr checks': {
      const pr = findPr(state, rest[0]);
      const checks = checksFor(state, pr).map((c) => ({
        name: c.name,
        state: c.conclusion,
        bucket: checkState(c.conclusion),
        startedAt: pr.createdAt,
        completedAt: checkState(c.conclusion) === 'pending' ? null : now,
        link: '',
        workflow: 'CI',
      }));
      const buckets = checks.map((c) => c.bucket);
      // Real gh exits 8 while checks are pending and 1 when any failed.
      const code = buckets.includes('fail') ? 1 : buckets.includes('pending') ? 8 : 0;
      return () => {
        if (one(flags, '--json')) {
          process.stdout.write(`${JSON.stringify(project(checks, one(flags, '--json')))}\n`);
        } else {
          for (const c of checks) process.stdout.write(`${c.name}\t${c.bucket}\n`);
        }
        process.exit(code);
      };
    }
    case 'pr create': {
      const head = one(flags, '--head', '-H') ?? cwdBranch();
      const base = one(flags, '--base', '-B') ?? state.defaultBranch ?? 'main';
      if (!refSha(head)) fail(`pull request create failed: head branch "${head}" has not been pushed`);
      const existing = Object.values(state.prs).find((p) => p.headRefName === head && p.state === 'OPEN');
      if (existing) {
        fail(`a pull request for branch "${head}" into branch "${base}" already exists:\nhttps://github.com/${state.repo}/pull/${existing.number}`);
      }
      let body = one(flags, '--body', '-b') ?? '';
      const bodyFile = one(flags, '--body-file', '-F');
      if (bodyFile) body = bodyFile === '-' ? safeReadStdin() : readFileSync(bodyFile, 'utf8');
      const number = state.nextPr++;
      state.prs[number] = {
        number,
        title: one(flags, '--title', '-t') ?? head,
        body,
        headRefName: head,
        baseRefName: base,
        headRefOid: refSha(head),
        observedHead: refSha(head),
        state: 'OPEN',
        isDraft: Boolean(flags['--draft'] || flags['-d']),
        labels: [...new Set(many(flags, '--label', '-l').flatMap((l) => String(l).split(',')))],
        createdAt: now,
        updatedAt: now,
      };
      return () => {
        process.stdout.write(`https://github.com/${state.repo}/pull/${number}\n`);
        process.exit(0);
      };
    }
    case 'pr edit': {
      const pr = findPr(state, rest[0]);
      for (const label of many(flags, '--add-label').flatMap((l) => String(l).split(','))) {
        addLabel(pr, label, now);
      }
      for (const label of many(flags, '--remove-label').flatMap((l) => String(l).split(','))) {
        removeLabel(pr, label, now);
      }
      if (one(flags, '--body', '-b') !== undefined) pr.body = one(flags, '--body', '-b');
      if (one(flags, '--title', '-t') !== undefined) pr.title = one(flags, '--title', '-t');
      if (one(flags, '--base', '-B') !== undefined) pr.baseRefName = one(flags, '--base', '-B');
      pr.updatedAt = now;
      return () => {
        process.stdout.write(`https://github.com/${state.repo}/pull/${pr.number}\n`);
        process.exit(0);
      };
    }
    case 'pr comment': {
      const pr = findPr(state, rest[0]);
      (pr.comments ??= []).push({ body: one(flags, '--body', '-b') ?? '', createdAt: now });
      return () => process.exit(0);
    }
    case 'pr close': {
      const pr = findPr(state, rest[0]);
      if (pr.state !== 'OPEN') fail(`Pull request #${pr.number} is already closed`);
      pr.state = 'CLOSED';
      pr.closedAt = now;
      pr.headRefOid = liveHead(state, pr, { observe: true });
      const comment = one(flags, '--comment', '-c');
      if (comment) (pr.comments ??= []).push({ body: comment, createdAt: now });
      return () => process.exit(0);
    }
    case 'pr merge': {
      const pr = findPr(state, rest[0]);
      if (pr.state !== 'OPEN') fail(`Pull request #${pr.number} is not open`);
      const current = view(state, pr);
      for (const required of state.requiredChecks) {
        const check = current.statusCheckRollup.find((c) => c.name === required);
        if (!check || check.conclusion !== 'SUCCESS') {
          fail(`X Pull request #${pr.number} is not mergeable: Required status check "${required}" is expected.`);
        }
      }
      const baseSha = refSha(pr.baseRefName);
      const headSha = refSha(pr.headRefName);
      const tree = mergeTree(baseSha, headSha);
      if (!tree) fail(`X Pull request #${pr.number} is not mergeable: the merge commit cannot be cleanly created.`);
      const method = flags['--merge'] ? 'merge' : flags['--rebase'] ? 'rebase' : 'squash';
      const parents = method === 'merge' ? [baseSha, headSha] : [baseSha];
      const commit = commitTree(tree, parents, `${pr.title} (#${pr.number})`);
      git(['update-ref', `refs/heads/${pr.baseRefName}`, commit, baseSha]);
      pr.state = 'MERGED';
      pr.mergedAt = now;
      recordHistory(pr, { event: 'merged' }, now);
      pr.closedAt = now;
      pr.headRefOid = headSha;
      pr.mergeCommitOid = commit;
      pr.mergeMethod = method;
      if (flags['--delete-branch'] || flags['-d']) git(['update-ref', '-d', `refs/heads/${pr.headRefName}`], { allowFail: true });
      return () => process.exit(0);
    }
    case 'pr update-branch': {
      const pr = findPr(state, rest[0]);
      const baseSha = refSha(pr.baseRefName);
      const headSha = refSha(pr.headRefName);
      if (git(['merge-base', '--is-ancestor', baseSha, headSha], { allowFail: true }) !== null) {
        return () => process.exit(0);
      }
      const tree = mergeTree(headSha, baseSha);
      if (!tree) fail('Cannot update PR branch due to conflicts');
      const commit = commitTree(tree, [headSha, baseSha], `Merge branch '${pr.baseRefName}' into ${pr.headRefName}`);
      git(['update-ref', `refs/heads/${pr.headRefName}`, commit, headSha]);
      return () => process.exit(0);
    }
    case 'pr diff': {
      const pr = findPr(state, rest[0]);
      const diff = git(['diff', `${refSha(pr.baseRefName)}...${liveHead(state, pr, { observe: false })}`], { allowFail: true }) ?? '';
      return () => {
        process.stdout.write(`${diff}\n`);
        process.exit(0);
      };
    }
    case 'run list':
      return () => emit([], flags);
    default:
      if (group === 'api') return api(state, now);
      return unhandled('command');
  }
}

function api(state, now) {
  const endpoint = (sub ?? '').replace(/^\//, '');
  const method = String(one(flags, '--method', '-X') ?? (flags['--input'] || flags['-f'] || flags['-F'] ? 'POST' : 'GET')).toUpperCase();
  const issueLabels = endpoint.match(/^repos\/[^/]+\/[^/]+\/issues\/(\d+)\/labels(?:\/(.+))?$/);
  if (issueLabels) {
    const pr = state.prs[issueLabels[1]];
    if (!pr) fail('gh: Not Found (HTTP 404)');
    if (method === 'POST') {
      let parsed = [];
      try { parsed = JSON.parse(stdinText || '[]'); } catch { /* -f form */ }
      const add = Array.isArray(parsed) ? parsed : parsed.labels ?? [];
      add.push(...many(flags, '-f', '--field', '--raw-field').map((f) => String(f).replace(/^labels\[\]=/, '')));
      for (const label of add) addLabel(pr, label, now);
      pr.updatedAt = now;
      return () => emit(pr.labels.map((name) => ({ name })), flags, { projectFields: false });
    }
    if (method === 'DELETE') {
      const name = decodeURIComponent(issueLabels[2] ?? '');
      if (!pr.labels.includes(name)) fail('gh: Label does not exist (HTTP 404)');
      removeLabel(pr, name, now);
      pr.updatedAt = now;
      return () => emit(pr.labels.map((label) => ({ name: label })), flags, { projectFields: false });
    }
    return () => emit(pr.labels.map((name) => ({ name })), flags, { projectFields: false });
  }
  if (/^repos\/[^/]+\/[^/]+\/commits\/[^/]+\/check-runs$/.test(endpoint)) {
    const runs = (state.checks.integration ?? state.checks.default ?? []).map((c) => ({
      name: c.name,
      status: checkState(c.conclusion ?? 'SUCCESS') === 'pending' ? 'in_progress' : 'completed',
      conclusion: checkState(c.conclusion ?? 'SUCCESS') === 'pending' ? null : String(c.conclusion ?? 'SUCCESS').toLowerCase(),
    }));
    return () => emit({ total_count: runs.length, check_runs: runs }, flags, { projectFields: false });
  }
  const protection = endpoint.match(/^repos\/[^/]+\/[^/]+\/branches\/(.+)\/protection\/required_status_checks$/);
  if (protection) {
    return () => emit({ contexts: state.requiredChecks, strict: Boolean(state.strictBehind) }, flags, { projectFields: false });
  }
  const branch = endpoint.match(/^repos\/[^/]+\/[^/]+\/branches\/([^/]+)$/);
  if (branch) {
    const sha = refSha(decodeURIComponent(branch[1]));
    if (!sha) fail('gh: Branch not found (HTTP 404)');
    return () => emit({ name: branch[1], commit: { sha }, protected: state.requiredChecks.length > 0 }, flags, { projectFields: false });
  }
  if (/^repos\/[^/]+\/[^/]+\/issues\/\d+\/(events|timeline|comments)$/.test(endpoint)) {
    return () => emit([], flags, { projectFields: false });
  }
  const pull = endpoint.match(/^repos\/[^/]+\/[^/]+\/pulls\/(\d+)(\/(reviews|comments|commits|files))?$/);
  if (pull) {
    const pr = state.prs[pull[1]];
    if (!pr) fail('gh: Not Found (HTTP 404)');
    if (pull[3]) return () => emit([], flags, { projectFields: false });
    const v = view(state, pr, { observe: false });
    return () => emit({
      number: v.number,
      title: v.title,
      body: v.body,
      state: v.state === 'OPEN' ? 'open' : 'closed',
      merged: v.state === 'MERGED',
      merged_at: v.mergedAt,
      draft: v.isDraft,
      head: { ref: v.headRefName, sha: v.headRefOid },
      base: { ref: v.baseRefName, sha: v.baseRefOid },
      labels: v.labels,
      html_url: v.url,
    }, flags, { projectFields: false });
  }
  return unhandled(`api ${method} ${endpoint}`);
}
