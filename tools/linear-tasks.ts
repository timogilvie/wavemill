// tools/linear.ts

export const getProjects = async () => {
  const res = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: {
      Authorization: process.env.LINEAR_API_KEY || '',
      'Content-Type': 'application/json',
    } as Record<string, string>,
    body: JSON.stringify({
      query: `
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
      `,
    }),
  });

  const data = await res.json();
  if (data.errors) {
    throw new Error(`Linear API error: ${JSON.stringify(data.errors)}`);
  }
  return data.data?.projects?.nodes || [];
};

export const getBacklog = async (projectName?: string) => {
  // Build filter to only get items in Backlog state
  const filters = [];

  // Always filter for Backlog state
  filters.push('state: { name: { eq: "Backlog" } }');

  // Add project filter if projectName is provided
  if (projectName) {
    filters.push(`project: { name: { eq: "${projectName}" } }`);
  }

  const filter = filters.length > 0
    ? `filter: { ${filters.join(', ')} }`
    : '';

  const res = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: {
      Authorization: process.env.LINEAR_API_KEY || '',
      'Content-Type': 'application/json',
    } as Record<string, string>,
    body: JSON.stringify({
      query: `
        query {
          issues(${filter}) {
            nodes {
              id
              title
              description
              state { name }
              labels {
                nodes { name }
              }
              project {
                id
                name
              }
            }
          }
        }
      `,
    }),
  });

  const data = await res.json();
  if (data.errors) {
    throw new Error(`Linear API error: ${JSON.stringify(data.errors)}`);
  }
  return data.data?.issues?.nodes || [];
};

export const getTeams = async () => {
  const res = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: {
      Authorization: process.env.LINEAR_API_KEY || '',
      'Content-Type': 'application/json',
    } as Record<string, string>,
    body: JSON.stringify({
      query: `
        query {
          teams {
            nodes {
              id
              name
              key
            }
          }
        }
      `,
    }),
  });

  const data = await res.json();
  if (data.errors) {
    throw new Error(`Linear API error: ${JSON.stringify(data.errors)}`);
  }
  return data.data?.teams?.nodes || [];
};

export const createProject = async (name: string, description: string, teamId: string) => {
  const res = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: {
      Authorization: process.env.LINEAR_API_KEY || '',
      'Content-Type': 'application/json',
    } as Record<string, string>,
    body: JSON.stringify({
      query: `
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
      variables: {
        name,
        description,
        teamIds: [teamId]
      }
    }),
  });

  const data = await res.json();
  if (data.errors) {
    throw new Error(`Linear API error: ${JSON.stringify(data.errors)}`);
  }
  return data.data?.projectCreate?.project;
};

export const createIssue = async (params: {
  title: string;
  description: string;
  teamId: string;
  projectId?: string;
  parentId?: string;
  priority?: number;
  estimate?: number;
}) => {
  const input: any = {
    title: params.title,
    description: params.description,
    teamId: params.teamId,
  };

  if (params.projectId) input.projectId = params.projectId;
  if (params.parentId) input.parentId = params.parentId;
  if (params.priority) input.priority = params.priority;
  if (params.estimate) input.estimate = params.estimate;

  const res = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: {
      Authorization: process.env.LINEAR_API_KEY || '',
      'Content-Type': 'application/json',
    } as Record<string, string>,
    body: JSON.stringify({
      query: `
        mutation($input: IssueCreateInput!) {
          issueCreate(input: $input) {
            success
            issue {
              id
              identifier
              title
              url
            }
          }
        }
      `,
      variables: { input }
    }),
  });

  const data = await res.json();
  if (data.errors) {
    throw new Error(`Linear API error: ${JSON.stringify(data.errors)}`);
  }
  return data.data?.issueCreate?.issue;
};

export const createIssueRelation = async (issueId: string, relatedIssueId: string, type: 'blocks' | 'related') => {
  const res = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: {
      Authorization: process.env.LINEAR_API_KEY || '',
      'Content-Type': 'application/json',
    } as Record<string, string>,
    body: JSON.stringify({
      query: `
        mutation($issueId: String!, $relatedIssueId: String!, $type: String!) {
          issueRelationCreate(input: {
            issueId: $issueId
            relatedIssueId: $relatedIssueId
            type: $type
          }) {
            success
          }
        }
      `,
      variables: { issueId, relatedIssueId, type }
    }),
  });

  const data = await res.json();
  if (data.errors) {
    throw new Error(`Linear API error: ${JSON.stringify(data.errors)}`);
  }
  return data.data?.issueRelationCreate?.success;
};