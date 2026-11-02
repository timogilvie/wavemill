// Shared fake of the Linear GraphQL API (HOK-3226).
//
// Loaded into every node process through NODE_OPTIONS="--import <this file>".
// It replaces globalThis.fetch for https://api.linear.app/graphql and answers
// the queries shared/lib/linear.ts actually sends from a JSON state file
// ($FAKE_LINEAR_STATE), so the real Linear tools (get-issue.ts,
// set-issue-state.ts, list-backlog-json.ts, ...) run unmodified. Every request
// is logged to $FAKE_LINEAR_LOG; queries the fake does not recognise are
// logged to $FAKE_LINEAR_UNHANDLED and answered with a GraphQL error.
//
// It also serves the Hokusai Model 30 predict edge (HOK-3363) at
// https://hokusai.fake/… from a script ($FAKE_HOKUSAI_SCRIPT):
//   { "default": <predict response>, "byObjective": { "<objective>": <response> } }
// The response is chosen by the request's `inputs.routing.objective`, so every
// routing pass (launch route, expanded reroute) gets the same first answer and
// the same re-ask answer regardless of how often the mill routes. Each request
// is logged to $FAKE_HOKUSAI_LOG.
//
// Any other non-loopback fetch is refused, so a journey can never reach the
// real network by accident.

import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';

const STATE = process.env.FAKE_LINEAR_STATE;
const LOG = process.env.FAKE_LINEAR_LOG;
const UNHANDLED = process.env.FAKE_LINEAR_UNHANDLED;
const realFetch = globalThis.fetch;

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


function withState(fn) {
  const lock = `${STATE}.lock`;
  acquireLock(lock);
  try {
    const state = JSON.parse(readFileSync(STATE, 'utf8'));
    state.issues ??= {};
    state.transitions ??= [];
    const result = fn(state);
    const tmp = `${STATE}.tmp.${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
    renameSync(tmp, STATE);
    return result;
  } finally {
    releaseLock(lock);
  }
}

const STATES = ['Backlog', 'Todo', 'In Progress', 'In Review', 'Done', 'Canceled'];
const stateId = (name) => `state-${name.toLowerCase().replace(/\s+/g, '-')}`;
const stateName = (id) => STATES.find((name) => stateId(name) === id);

function issueNode(issue) {
  const [teamKey] = issue.identifier.split('-');
  return {
    id: issue.id ?? `issue-${issue.identifier}`,
    identifier: issue.identifier,
    title: issue.title ?? issue.identifier,
    description: issue.description ?? '',
    state: { name: issue.state ?? 'Backlog', id: stateId(issue.state ?? 'Backlog'), type: issue.state === 'Done' ? 'completed' : 'unstarted' },
    team: { id: `team-${teamKey}`, name: teamKey, key: teamKey },
    labels: { nodes: (issue.labels ?? []).map((name) => ({ id: `label-${name}`, name })) },
    project: issue.project ? { id: `project-${issue.project}`, name: issue.project } : null,
    projectMilestone: null,
    priority: issue.priority ?? 3,
    priorityLabel: 'Medium',
    estimate: issue.estimate ?? null,
    dueDate: null,
    assignee: null,
    creator: { name: 'fake', email: 'fake@example.invalid' },
    parent: null,
    children: { nodes: [] },
    comments: { nodes: [] },
    relations: { nodes: [] },
    inverseRelations: { nodes: [] },
    url: `https://linear.app/fake/issue/${issue.identifier}`,
    completedAt: issue.completedAt ?? null,
    canceledAt: issue.canceledAt ?? null,
  };
}

function answer(query, variables) {
  return withState((state) => {
    const issues = Object.values(state.issues);
    const teamKey = query.match(/team:\s*\{\s*key:\s*\{\s*eq:\s*"([^"]+)"/)?.[1] ?? variables?.teamKey;

    const single = query.match(/number:\s*\{\s*eq:\s*(\d+)\s*\}/);
    if (single) {
      const found = issues.filter((i) => i.identifier === `${teamKey}-${single[1]}`);
      return { data: { issues: { nodes: found.map(issueNode) } } };
    }
    const batch = query.match(/number:\s*\{\s*in:\s*\[([^\]]*)\]\s*\}/);
    if (batch) {
      const wanted = new Set(batch[1].split(',').map((n) => `${teamKey}-${n.trim()}`));
      return { data: { issues: { nodes: issues.filter((i) => wanted.has(i.identifier)).map(issueNode) } } };
    }
    if (/state:\s*\{\s*name:\s*\{\s*in:/.test(query)) {
      const allowed = [...query.matchAll(/"(Backlog|Todo|[^"]+)"/g)].map((m) => m[1]);
      const project = query.match(/project:\s*\{\s*name:\s*\{\s*eq:\s*"([^"]+)"/)?.[1];
      const backlog = issues
        .filter((i) => allowed.includes(i.state ?? 'Backlog'))
        .filter((i) => !project || i.project === project);
      return { data: { issues: { nodes: backlog.map(issueNode) } } };
    }
    if (/searchIssues\(/.test(query)) {
      const term = String(variables?.term ?? '').toLowerCase();
      const openOnly = /completedAt:\s*\{\s*null:\s*true/.test(query);
      const found = issues
        .filter((i) => !teamKey || i.identifier.startsWith(`${teamKey}-`))
        .filter((i) => i.identifier.toLowerCase().includes(term) || String(i.title ?? '').toLowerCase().includes(term))
        .filter((i) => !openOnly || (!i.completedAt && !i.canceledAt));
      return { data: { searchIssues: { nodes: found.map(issueNode) } } };
    }
    if (/team\(id:\s*\$teamId\)/.test(query)) {
      return { data: { team: { states: { nodes: STATES.map((name) => ({ id: stateId(name), name })) } } } };
    }
    if (/issueUpdate\(/.test(query)) {
      const issue = issues.find((i) => (i.id ?? `issue-${i.identifier}`) === variables?.issueId);
      if (!issue) return { errors: [{ message: `Entity not found: ${variables?.issueId}` }] };
      const input = variables?.input ?? {};
      if (input.stateId) {
        const next = stateName(input.stateId);
        state.transitions.push({ identifier: issue.identifier, from: issue.state ?? 'Backlog', to: next, at: new Date().toISOString() });
        issue.state = next;
        if (next === 'Done') issue.completedAt = new Date().toISOString();
        if (next === 'Canceled') issue.canceledAt = new Date().toISOString();
      }
      return { data: { issueUpdate: { success: true, issue: { id: issue.id ?? `issue-${issue.identifier}`, identifier: issue.identifier, url: issueNode(issue).url } } } };
    }
    if (UNHANDLED) appendFileSync(UNHANDLED, `${JSON.stringify({ query: query.replace(/\s+/g, ' ').trim(), variables })}\n`);
    return { errors: [{ message: 'fake linear: unhandled query' }] };
  });
}

function isLoopback(url) {
  try {
    const { hostname } = new URL(url);
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  } catch {
    return false;
  }
}

function answerHokusai(init) {
  const script = process.env.FAKE_HOKUSAI_SCRIPT;
  if (!script) throw new TypeError('fake hokusai: FAKE_HOKUSAI_SCRIPT is not set');
  const request = JSON.parse(init.body ?? '{}');
  const routing = request?.inputs?.routing ?? {};
  const objective = routing.objective ?? null;
  const { default: fallback, byObjective = {} } = JSON.parse(readFileSync(script, 'utf8'));
  const response = (objective && byObjective[objective]) || fallback;
  const log = process.env.FAKE_HOKUSAI_LOG;
  if (log) {
    appendFileSync(log, `${JSON.stringify({
      at: new Date().toISOString(),
      objective,
      availableCoderModels: routing.available_coder_models ?? null,
      inferenceLogId: response?.inference_log_id ?? null,
    })}\n`);
  }
  return new Response(JSON.stringify(response), { status: 200, headers: { 'content-type': 'application/json' } });
}

globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input?.url ?? String(input);
  if (url.startsWith('https://hokusai.fake/')) {
    return answerHokusai(init);
  }
  if (url.startsWith('https://api.linear.app/graphql')) {
    if (!STATE) throw new TypeError('fake linear: FAKE_LINEAR_STATE is not set');
    const { query = '', variables } = JSON.parse(init.body ?? '{}');
    if (LOG) appendFileSync(LOG, `${JSON.stringify({ at: new Date().toISOString(), query: query.replace(/\s+/g, ' ').trim().slice(0, 200), variables })}\n`);
    const body = answer(query, variables);
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (isLoopback(url)) return realFetch(input, init);
  throw new TypeError(`fake network: refusing non-loopback fetch to ${url}`);
};
