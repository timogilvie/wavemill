/**
 * Issue Labeler
 *
 * Analyzes Linear issues and automatically applies relevant labels based on:
 * - Risk level (Low/Medium/High)
 * - Architectural layers (UI/API/Service/Database/Infra)
 * - Product areas (Landing/Navigation/Auth/Docs)
 * - Components (extracted from file paths)
 * - Test requirements (E2E/Integration/Unit/None)
 *
 * @module issue-labeler
 */

import * as readline from 'readline/promises';
import { getIssue, getLabels, addLabelsToIssue, getOrCreateLabel } from './linear.js';

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

export interface LabelAnalysis {
  files: string[];
  risk: 'Low' | 'Medium' | 'High';
  layers: string[];
  tests: string[];
  components: string[];
  areas: string[];
}

export interface AutoLabelOptions {
  dryRun?: boolean;
  interactive?: boolean;
}

// ────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────

/**
 * Analyze issue content to determine appropriate labels.
 *
 * Extracts files, assesses risk, identifies layers/areas/components,
 * and determines test requirements.
 *
 * @param description - Issue description
 * @param title - Issue title
 * @returns Label analysis result
 *
 * @example
 * ```typescript
 * const analysis = analyzeIssue(issue.description, issue.title);
 * console.log(analysis.risk); // 'Medium'
 * console.log(analysis.layers); // ['Layer: API', 'Layer: Database']
 * ```
 */
export function analyzeIssue(description: string, title: string): LabelAnalysis {
  const text = `${title}\n${description}`.toLowerCase();

  // Extract file paths
  const fileMatches =
    description.match(/(?:files?|modify|create|update).*?:\s*([^\n]+)/gi) || [];
  const files: string[] = [];
  fileMatches.forEach((match) => {
    const paths = match.match(/[a-z0-9_\-\/]+\.[a-z]{2,4}/gi) || [];
    files.push(...paths);
  });

  // Assess risk level
  let risk: 'Low' | 'Medium' | 'High' = 'Medium';
  if (/breaking change|migration|database schema|major refactor/i.test(text)) {
    risk = 'High';
  } else if (/css|style|text update|copy change|typo|comment/i.test(text)) {
    risk = 'Low';
  }

  // Identify layers
  const layers: string[] = [];
  if (/component|ui|frontend|tsx|jsx/i.test(text)) layers.push('Layer: UI');
  if (/api route|endpoint|\/api\//i.test(text)) layers.push('Layer: API');
  if (/service|business logic|lib\//i.test(text)) layers.push('Layer: Service');
  if (/database|schema|migration|sql|prisma/i.test(text))
    layers.push('Layer: Database');
  if (/infra|deploy|docker|config|ci\/cd/i.test(text))
    layers.push('Layer: Infra');

  // Identify test requirements
  const tests: string[] = [];
  if (/e2e|playwright|cypress|end-to-end/i.test(text)) {
    tests.push('Tests: E2E');
  } else if (/integration test/i.test(text)) {
    tests.push('Tests: Integration');
  } else if (/unit test|test/i.test(text)) {
    tests.push('Tests: Unit');
  } else if (/no test|skip test/i.test(text)) {
    tests.push('Tests: None');
  }

  // Identify areas — product areas only (architectural layers use Layer: labels)
  const areas: string[] = [];

  // File-based area detection (more specific and reliable)
  const fileBasedAreas = {
    'Area: Landing': /landing|hero|homepage|index\.(tsx|jsx)|home\.(tsx|jsx)/i,
    'Area: Navigation': /nav|menu|header|sidebar|footer|routing|router/i,
    'Area: Auth': /auth|login|signup|session|token|credential|password/i,
    'Area: Docs': /docs\/|readme|documentation|\.md$/i,
  };

  // Check files first (higher confidence)
  for (const [area, pattern] of Object.entries(fileBasedAreas)) {
    if (files.some((f) => pattern.test(f))) {
      if (!areas.includes(area)) {
        areas.push(area);
      }
    }
  }

  // Fallback to text-based detection if no file-based matches
  if (areas.length === 0) {
    if (/landing|homepage|hero/i.test(text)) areas.push('Area: Landing');
    if (/navigation|nav|menu|routing|route/i.test(text))
      areas.push('Area: Navigation');
    if (/auth|login|signup|authentication|authorization/i.test(text))
      areas.push('Area: Auth');
    if (/doc|documentation|readme/i.test(text)) areas.push('Area: Docs');
  }

  // Identify components - extract from file paths and text
  const components: string[] = [];

  // Extract from file paths (e.g., components/Hero.tsx -> Component: Hero)
  files.forEach((file) => {
    const componentMatch = file.match(/components\/([A-Z][a-zA-Z0-9]+)\.(tsx|jsx)/);
    if (componentMatch) {
      const componentName = `Component: ${componentMatch[1]}`;
      if (!components.includes(componentName)) {
        components.push(componentName);
      }
    }
  });

  // Also check for explicit "Component: X" mentions in text
  const componentMatches = text.match(/component:\s*([a-z0-9_-]+)/gi) || [];
  componentMatches.forEach((match) => {
    const name = match.replace(/component:\s*/i, '').trim();
    if (name) {
      const componentName = `Component: ${name.charAt(0).toUpperCase() + name.slice(1)}`;
      if (!components.includes(componentName)) {
        components.push(componentName);
      }
    }
  });

  return { files, risk, layers, tests, components, areas };
}

/**
 * Automatically label a Linear issue based on content analysis.
 *
 * Analyzes issue, proposes labels, and applies them (unless dry-run or
 * user declines in interactive mode).
 *
 * Auto-creates component labels if they don't exist.
 *
 * @param identifier - Linear issue identifier (e.g., "HOK-123")
 * @param options - Auto-label options
 *
 * @example
 * ```typescript
 * await autoLabelIssue('HOK-123', { dryRun: false, interactive: true });
 * // Analyzes issue, proposes labels, asks for confirmation, applies
 * ```
 */
export async function autoLabelIssue(
  identifier: string,
  options: AutoLabelOptions = {}
): Promise<void> {
  const { dryRun = false, interactive = false } = options;
  console.log(`🔍 Analyzing issue ${identifier}...\n`);

  // Fetch issue
  const issue = await getIssue(identifier);
  console.log(`📋 ${issue.title}`);
  console.log(`   State: ${issue.state.name}`);
  console.log(`   Project: ${issue.project?.name || 'None'}\n`);

  // Analyze content
  const analysis = analyzeIssue(issue.description || '', issue.title);

  console.log('🧠 Analysis:');
  console.log(
    `   Files: ${analysis.files.length > 0 ? analysis.files.join(', ') : 'None detected'}`
  );
  console.log(`   Risk: ${analysis.risk}`);
  console.log(`   Layers: ${analysis.layers.join(', ') || 'None'}`);
  console.log(`   Areas: ${analysis.areas.join(', ') || 'None'}`);
  console.log(`   Components: ${analysis.components.join(', ') || 'None'}`);
  console.log(`   Tests: ${analysis.tests.join(', ') || 'None'}\n`);

  // Get available labels for this team
  const availableLabels = await getLabels(issue.team.id);
  const labelMap = new Map(availableLabels.map((l) => [l.name, l.id]));

  // Build label set
  const proposedLabels: string[] = [
    `Risk: ${analysis.risk}`,
    ...analysis.layers,
    ...analysis.areas,
    ...analysis.components,
    ...analysis.tests,
  ];

  // Add Files: label if files detected
  if (analysis.files.length > 0) {
    const filesLabel = `Files: ${analysis.files.slice(0, 3).join(', ')}${analysis.files.length > 3 ? '...' : ''}`;
    proposedLabels.push(filesLabel);
  }

  // Auto-create component labels if they don't exist
  const createdLabels: string[] = [];
  for (const componentLabel of analysis.components) {
    if (!labelMap.has(componentLabel)) {
      try {
        console.log(`   🔨 Creating new component label: ${componentLabel}`);
        const newLabel = await getOrCreateLabel(
          componentLabel,
          issue.team.id,
          {
            color: '#4A90E2',
            description: 'Auto-detected component from file paths',
          },
          availableLabels // Pass labels cache (will be mutated to include new labels)
        );
        labelMap.set(componentLabel, newLabel.id);
        createdLabels.push(componentLabel);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`   ⚠️  Failed to create label ${componentLabel}: ${message}`);
      }
    }
  }

  if (createdLabels.length > 0) {
    console.log(`\n✨ Created ${createdLabels.length} new component label(s)\n`);
  }

  // Resolve label IDs
  const labelIds: string[] = [];
  const missing: string[] = [];

  for (const labelName of proposedLabels) {
    const id = labelMap.get(labelName);
    if (id) {
      labelIds.push(id);
    } else {
      missing.push(labelName);
    }
  }

  // Get current labels (with IDs for merging)
  const currentLabelNodes = issue.labels?.nodes || [];
  const currentLabels = currentLabelNodes.map((l) => l.name);
  const currentLabelIds = new Set(currentLabelNodes.map((l) => l.id));

  console.log('🏷️  Current labels:');
  if (currentLabels.length > 0) {
    currentLabels.forEach((l) => console.log(`   - ${l}`));
  } else {
    console.log('   (none)');
  }

  // Filter out labels already on the issue
  const newLabelNames: string[] = [];
  const newLabelIds: string[] = [];
  for (const labelName of proposedLabels) {
    const id = labelMap.get(labelName);
    if (id && !currentLabelIds.has(id)) {
      newLabelNames.push(labelName);
      newLabelIds.push(id);
    }
  }

  console.log('\n🎯 Proposed labels:');
  proposedLabels.forEach((l) => {
    const id = labelMap.get(l);
    const alreadyApplied = id && currentLabelIds.has(id);
    const exists = labelMap.has(l);
    if (alreadyApplied) {
      console.log(`   ⏭️  ${l} (already applied)`);
    } else {
      console.log(`   ${exists ? '✅' : '❌'} ${l}`);
    }
  });

  if (missing.length > 0) {
    console.log('\n⚠️  Missing labels (create these first with init-labels.ts):');
    missing.forEach((l) => console.log(`   - ${l}`));
  }

  if (dryRun) {
    console.log('\n🔍 Dry run mode - no changes made');
    return;
  }

  // Interactive confirmation
  if (interactive && newLabelIds.length > 0) {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    console.log('\n❓ Apply these labels?');
    const answer = await rl.question('   [Y/n] ');
    rl.close();

    if (answer.toLowerCase() === 'n') {
      console.log('❌ Labels not applied');
      return;
    }
  }

  // Merge new labels with existing ones
  if (newLabelIds.length > 0) {
    const mergedLabelIds = [...currentLabelIds, ...newLabelIds];
    console.log(
      `\n📝 Applying ${newLabelIds.length} new label(s) (keeping ${currentLabelIds.size} existing)...`
    );
    await addLabelsToIssue(issue.id, mergedLabelIds);
    console.log(`✅ Successfully labeled ${identifier}`);
  } else {
    console.log('\n✅ All proposed labels already applied — no changes needed');
  }
}
