#!/usr/bin/env -S npx tsx
import { runTool } from '../shared/lib/tool-runner.ts';
import { getTeams, getLabels, createLabel } from '../shared/lib/linear.js';

const LABEL_DEFINITIONS = {
  area: [
    { name: 'Area: Landing', color: '#4A90E2', description: 'Landing page and homepage' },
    { name: 'Area: Navigation', color: '#50E3C2', description: 'Navigation and routing' },
    { name: 'Area: Auth', color: '#F5A623', description: 'Authentication and authorization' },
    { name: 'Area: Docs', color: '#7ED321', description: 'Documentation' },
  ],
  risk: [
    { name: 'Risk: Low', color: '#7ED321', description: 'Simple, isolated changes (CSS tweaks, text updates)' },
    { name: 'Risk: Medium', color: '#F5A623', description: 'New features, refactoring (most tasks)' },
    { name: 'Risk: High', color: '#D0021B', description: 'Breaking changes, migrations, infrastructure' },
  ],
  layer: [
    { name: 'Layer: UI', color: '#4A90E2', description: 'Frontend components' },
    { name: 'Layer: API', color: '#BD10E0', description: 'API routes and endpoints' },
    { name: 'Layer: Service', color: '#50E3C2', description: 'Business logic' },
    { name: 'Layer: Database', color: '#D0021B', description: 'Schema and migrations' },
    { name: 'Layer: Infra', color: '#9013FE', description: 'Configuration and deployment' },
  ],
  tests: [
    { name: 'Tests: Unit', color: '#B8E986', description: 'Requires unit tests' },
    { name: 'Tests: Integration', color: '#7ED321', description: 'Requires integration tests' },
    { name: 'Tests: E2E', color: '#F5A623', description: 'Requires end-to-end tests' },
    { name: 'Tests: None', color: '#9B9B9B', description: 'No tests required' },
  ],
  component: [
    { name: 'Component: Hero', color: '#4A90E2', description: 'Hero section component' },
    { name: 'Component: UserMenu', color: '#50E3C2', description: 'User menu component' },
    { name: 'Component: LoginForm', color: '#F5A623', description: 'Login form component' },
  ],
};

async function initializeLabels(teamKey?: string) {
  console.log('🏷️  Initializing Linear labels...\n');
  const teams = await getTeams();
  console.log(`Found ${teams.length} teams:`);
  teams.forEach((t) => console.log(`  - ${t.name} (${t.key})`));
  console.log();

  let targetTeam = teams[0];
  if (teamKey) {
    const found = teams.find((t) => t.key === teamKey);
    if (!found) {
      console.error(`❌ Team "${teamKey}" not found`);
      process.exit(1);
    }
    targetTeam = found;
  }

  console.log(`Using team: ${targetTeam.name} (${targetTeam.key})\n`);
  const existingLabels = await getLabels(targetTeam.id);
  const existingNames = new Set(existingLabels.map((l) => l.name));
  console.log(`Found ${existingLabels.length} existing labels\n`);

  let created = 0;
  let skipped = 0;

  for (const [category, labels] of Object.entries(LABEL_DEFINITIONS)) {
    console.log(`\n📁 ${category.toUpperCase()}`);
    for (const label of labels) {
      if (existingNames.has(label.name)) {
        console.log(`  ⏭️  ${label.name} (already exists)`);
        skipped++;
      } else {
        await createLabel(label.name, targetTeam.id, {
          color: label.color,
          description: label.description,
        });
        console.log(`  ✅ ${label.name}`);
        created++;
      }
    }
  }

  console.log(`\n\n✨ Done!`);
  console.log(`  Created: ${created}`);
  console.log(`  Skipped: ${skipped}`);
  console.log(`  Total: ${created + skipped}`);
}

runTool({
  name: 'init-labels',
  description: 'Initialize Linear labels for a team',
  options: {
    help: { type: 'boolean', short: 'h', description: 'Show help' },
  },
  positional: {
    name: 'teamKey',
    description: 'Team key (optional)',
  },
  examples: [
    'npx tsx tools/init-labels.ts',
    'npx tsx tools/init-labels.ts MYTEAM',
  ],
  async run({ positional }) {
    await initializeLabels(positional[0]);
  },
});
