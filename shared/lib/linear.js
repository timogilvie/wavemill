// Shared Linear API client used by both Claude and Codex tooling.
// Centralizing these helpers prevents drift between scripts.

const LINEAR_ENDPOINT = 'https://api.linear.app/graphql';

const headers = () => ({
  Authorization: process.env.LINEAR_API_KEY || '',
  'Content-Type': 'application/json',
});

async function request(query, variables) {
  const res = await fetch(LINEAR_ENDPOINT, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ query, variables }),
  });

  const data = await res.json();
  if (data.errors) {
    throw new Error(`Linear API error: ${JSON.stringify(data.errors)}`);
  }
  return data.data;
}

export async function getProjects() {
  const data = await request(`
    query {
      projects {
        nodes {
          id
          name
          description
          state
        }
      }
    }
  `);

  return data.projects?.nodes || [];
}

export async function getTeams() {
  const data = await request(`
    query {
      teams {
        nodes {
          id
          name
          key
        }
      }
    }
  `);

  return data.teams?.nodes || [];
}

export async function getBacklog(projectName) {
  const filters = ['state: { name: { in: ["Backlog", "Todo"] } }'];

  if (projectName) {
    filters.push(`project: { name: { eq: "${projectName}" } }`);
  }

  const filterClause = filters.length ? `filter: { ${filters.join(', ')} }` : '';

  const data = await request(`
    query {
      issues(${filterClause}) {
        nodes {
          id
          identifier
          title
          description
          state { name id }
          labels { nodes { name } }
          project { id name }
          estimate
          priority
          parent {
            id
            identifier
            title
          }
          children {
            nodes {
              id
              identifier
              title
              description
              state { name }
              labels { nodes { name } }
            }
          }
        }
      }
    }
  `);

  return data.issues?.nodes || [];
}

export async function getWorkflowStates(teamId) {
  const data = await request(`
    query {
      workflowStates(filter: { team: { id: { eq: "${teamId}" } } }) {
        nodes {
          id
          name
          type
        }
      }
    }
  `);

  return data.workflowStates?.nodes || [];
}

export async function setIssueState(identifier, stateName) {
  // First get the issue to find its team and current workflow states
  const issue = await getIssue(identifier);

  // Get workflow states for this team
  const states = await getWorkflowStates(issue.team.id);

  // Find the target state
  const targetState = states.find(s => s.name.toLowerCase() === stateName.toLowerCase());

  if (!targetState) {
    throw new Error(`State "${stateName}" not found. Available: ${states.map(s => s.name).join(', ')}`);
  }

  // Update the issue with the new state
  return await updateIssue(issue.id, { stateId: targetState.id });
}

export async function createIssue(params) {
  const input = {
    title: params.title,
    description: params.description,
    teamId: params.teamId,
  };

  if (params.projectId) input.projectId = params.projectId;
  if (params.parentId) input.parentId = params.parentId;
  if (params.priority !== undefined) input.priority = params.priority;
  if (params.estimate !== undefined) input.estimate = params.estimate;
  if (params.projectMilestoneId) input.projectMilestoneId = params.projectMilestoneId;

  const data = await request(
    `
      mutation($input: IssueCreateInput!) {
        issueCreate(input: $input) {
          issue {
            id
            identifier
            title
            url
          }
        }
      }
    `,
    { input },
  );

  return data.issueCreate.issue;
}

export async function createProject(name, description, teamId) {
  const data = await request(
    `
      mutation($name: String!, $description: String!, $teamIds: [String!]!) {
        projectCreate(input: {
          name: $name
          description: $description
          teamIds: $teamIds
        }) {
          success
          project {
            id
            name
          }
        }
      }
    `,
    { name, description, teamIds: [teamId] },
  );

  return data.projectCreate?.project;
}

export async function getOrCreateProjectMilestone(projectId, milestoneName) {
  // First, get the project and check its milestones
  const findData = await request(
    `
      query($projectId: String!) {
        project(id: $projectId) {
          id
          projectMilestones {
            nodes {
              id
              name
            }
          }
        }
      }
    `,
    { projectId },
  );

  const existing = findData.project?.projectMilestones?.nodes?.find(
    (m) => m.name === milestoneName
  );

  if (existing) {
    return existing.id;
  }

  // Create new milestone
  const createData = await request(
    `
      mutation($name: String!, $projectId: String!) {
        projectMilestoneCreate(input: {
          name: $name
          projectId: $projectId
        }) {
          success
          projectMilestone {
            id
            name
          }
        }
      }
    `,
    { name: milestoneName, projectId },
  );

  return createData.projectMilestoneCreate?.projectMilestone?.id;
}

export async function getIssue(identifier) {
  // identifier is e.g. "HOK-356" — we need to split into team key + number
  const match = identifier.match(/^([A-Z]+)-(\d+)$/);
  if (!match) {
    throw new Error(`Invalid issue identifier: ${identifier}. Expected format: HOK-123`);
  }

  const data = await request(`
    query {
      issues(filter: { number: { eq: ${match[2]} }, team: { key: { eq: "${match[1]}" } } }, first: 1) {
        nodes {
          id
          identifier
          title
          description
          state { name }
          labels { nodes { id name } }
          project { id name }
          priority
          estimate
          assignee { name email }
          creator { name email }
          team { id name key }
          parent {
            id
            identifier
            title
          }
          children {
            nodes {
              id
              identifier
              title
              description
              state { name }
              labels { nodes { id name } }
            }
          }
          comments {
            nodes {
              body
              user { name }
              createdAt
            }
          }
          url
        }
      }
    }
  `);

  const issue = data.issues?.nodes?.[0];
  if (!issue) {
    throw new Error(`Issue not found: ${identifier}`);
  }
  return issue;
}

export async function updateIssue(issueId, input) {
  const data = await request(
    `
      mutation($issueId: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $issueId, input: $input) {
          success
          issue {
            id
            identifier
            url
          }
        }
      }
    `,
    { issueId, input },
  );

  return data.issueUpdate;
}

export async function createIssueRelation(issueId, relatedIssueId, type) {
  const data = await request(
    `
      mutation($issueId: String!, $relatedIssueId: String!, $type: IssueRelationType!) {
        issueRelationCreate(input: {
          issueId: $issueId
          relatedIssueId: $relatedIssueId
          type: $type
        }) {
          success
        }
      }
    `,
    { issueId, relatedIssueId, type },
  );

  return Boolean(data.issueRelationCreate?.success);
}

// ========== Label Management ==========

export async function getLabels(teamId) {
  const filter = teamId ? `filter: { team: { id: { eq: "${teamId}" } } }` : '';

  const data = await request(`
    query {
      issueLabels(${filter}) {
        nodes {
          id
          name
          color
          description
          team { id name }
        }
      }
    }
  `);

  return data.issueLabels?.nodes || [];
}

export async function createLabel(name, teamId, options = {}) {
  const input = {
    name,
    teamId,
  };

  if (options.color) input.color = options.color;
  if (options.description) input.description = options.description;

  const data = await request(
    `
      mutation($input: IssueLabelCreateInput!) {
        issueLabelCreate(input: $input) {
          success
          issueLabel {
            id
            name
            color
          }
        }
      }
    `,
    { input },
  );

  return data.issueLabelCreate?.issueLabel;
}

export async function addLabelsToIssue(issueId, labelIds) {
  const data = await request(
    `
      mutation($issueId: String!, $labelIds: [String!]!) {
        issueUpdate(id: $issueId, input: { labelIds: $labelIds }) {
          success
          issue {
            id
            identifier
            labels { nodes { name } }
          }
        }
      }
    `,
    { issueId, labelIds },
  );

  return data.issueUpdate;
}

export async function getOrCreateLabel(name, teamId, options = {}) {
  const labels = await getLabels(teamId);
  const existing = labels.find(l => l.name === name);

  if (existing) {
    return existing;
  }

  return await createLabel(name, teamId, options);
}

// ========== Initiative Management ==========

export async function getInitiatives(statusFilter) {
  const filters = [];
  if (statusFilter && statusFilter.length > 0) {
    filters.push(`status: { in: [${statusFilter.map(s => `"${s}"`).join(', ')}] }`);
  } else {
    filters.push('status: { nin: ["Completed"] }');
  }

  const filterClause = `filter: { ${filters.join(', ')} }`;

  const data = await request(`
    query {
      initiatives(${filterClause}, first: 50) {
        nodes {
          id
          name
          description
          content
          status
          slugId
          targetDate
          owner { name }
          projects {
            nodes {
              id
              name
              issues(first: 1) {
                nodes { id }
              }
            }
          }
        }
      }
    }
  `);

  return data.initiatives?.nodes || [];
}

export async function getInitiative(initiativeId) {
  const data = await request(
    `
      query($id: String!) {
        initiative(id: $id) {
          id
          name
          description
          content
          status
          slugId
          targetDate
          owner { name }
          projects {
            nodes {
              id
              name
            }
          }
        }
      }
    `,
    { id: initiativeId },
  );

  return data.initiative;
}
