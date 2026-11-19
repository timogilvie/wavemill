#!/usr/bin/env -S npx tsx
/**
 * Keep one Linear issue in step with persistent OpenRouter registry drift.
 * Reads two consecutive audit reports (tools/audit-openrouter-aliases.ts
 * --output); a finding present in both is filed. Run by the scheduled
 * OpenRouter Drift workflow; `--dry-run` prints the decision without Linear.
 */
import { existsSync, readFileSync } from 'node:fs';
import { runTool } from '../shared/lib/tool-runner.ts';
import type { AliasAuditReport } from '../shared/lib/openrouter-alias-audit.ts';
import {
  createIssue,
  getIssue,
  getOrCreateProjectMilestone,
  getProjects,
  getTeams,
  searchIssues,
  updateIssue,
} from '../shared/lib/linear.ts';
import {
  persistentDriftFindings,
  renderDriftIssueDescription,
  syncDriftIssue,
  type DriftIssueClient,
} from '../shared/lib/openrouter-drift-issue.ts';

function readReport(path: string | undefined): AliasAuditReport | null {
  if (!path || !existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf-8')) as AliasAuditReport;
}

function linearClient(target: { teamKey: string; project: string; milestone: string }): DriftIssueClient {
  return {
    async findOpenIssue(title) {
      const matches = await searchIssues(title, { teamKey: target.teamKey, projectName: target.project });
      const match = matches.find((issue) => issue.title === title);
      if (!match) return null;
      const { description } = await getIssue(match.identifier);
      return { id: match.id, identifier: match.identifier, description };
    },
    async fileIssue({ title, description, priority }) {
      const team = (await getTeams()).find((candidate) => candidate.key === target.teamKey);
      const project = (await getProjects()).find((candidate) => candidate.name === target.project);
      if (!team || !project) throw new Error(`Linear team "${target.teamKey}" or project "${target.project}" not found`);
      const projectMilestoneId = await getOrCreateProjectMilestone(project.id, target.milestone);
      // allow-defect-escalation: catalog maintenance task, not a Wavemill defect (see openrouter-drift-issue.ts)
      const issue = await createIssue({ title, description, priority, teamId: team.id, projectId: project.id, projectMilestoneId });
      return { id: issue.id, identifier: issue.identifier, description };
    },
    async updateDescription(issueId, description) {
      await updateIssue(issueId, { description });
    },
  };
}

runTool({
  name: 'file-openrouter-drift',
  description: 'Create or update the one Linear issue for OpenRouter registry drift seen in two consecutive audits',
  options: {
    report: { type: 'string', description: 'Current audit report JSON (required)' },
    previous: { type: 'string', description: 'Previous audit report JSON; when absent nothing is filed yet' },
    'team-key': { type: 'string', description: 'Linear team key, e.g. HOK (required unless --dry-run)' },
    project: { type: 'string', description: 'Linear project name (required unless --dry-run)' },
    milestone: { type: 'string', description: 'Project milestone for a new issue (default: Now)' },
    'dry-run': { type: 'boolean', description: 'Print the persistent findings and issue body; do not call Linear' },
  },
  examples: [
    'npx tsx tools/file-openrouter-drift.ts --report now.json --previous before.json --dry-run',
    'npx tsx tools/file-openrouter-drift.ts --report now.json --previous before.json --team-key HOK --project wavemill',
  ],
  async run({ args }) {
    const current = readReport(args.report as string | undefined);
    if (!current) throw new Error('--report must name an existing audit report');
    const previous = readReport(args.previous as string | undefined);
    const findings = persistentDriftFindings(current, previous);
    console.log(`openrouter-drift: ${findings.length} persistent finding(s)${previous ? '' : ' (no previous report; the next run decides)'}`);

    if (args['dry-run']) {
      if (findings.length > 0) console.log(renderDriftIssueDescription(findings, current.generatedAt));
      return;
    }
    const teamKey = args['team-key'] as string | undefined;
    const project = args.project as string | undefined;
    if (!teamKey || !project) throw new Error('--team-key and --project are required');
    const outcome = await syncDriftIssue({
      findings,
      auditedAt: current.generatedAt,
      client: linearClient({ teamKey, project, milestone: (args.milestone as string | undefined) ?? 'Now' }),
    });
    console.log(`openrouter-drift: ${JSON.stringify(outcome)}`);
  },
});
