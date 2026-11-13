#!/usr/bin/env -S npx tsx
import { runTool } from '../shared/lib/tool-runner.ts';
import { archiveTaskEvidence } from '../shared/lib/task-evidence-archive.ts';

runTool({
  name: 'archive-task-evidence',
  description: 'Preserve the canonical task evidence inventory and owned session bytes before cleanup.',
  options: {
    issue: { type: 'string', description: 'Task/arm ID' },
    slug: { type: 'string', description: 'Feature slug' },
    'repo-dir': { type: 'string', description: 'Milled repository' },
    worktree: { type: 'string', description: 'Exact task worktree' },
  },
  async run({ args }) {
    for (const key of ['issue', 'slug', 'repo-dir', 'worktree']) if (typeof args[key] !== 'string') throw new Error(`Required: --${key}`);
    const result = archiveTaskEvidence({ issueId: args.issue as string, slug: args.slug as string,
      repoDir: args['repo-dir'] as string, worktreeDir: args.worktree as string });
    console.log(JSON.stringify({ artifacts: result.artifacts.length, sessions: result.sessions.length,
      missingSessions: result.sessions.filter(s => s.status !== 'archived').length }));
  },
});
