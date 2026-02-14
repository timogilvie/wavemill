# Issue Writer Enhancement: Auto-Labeling for Parallelization

## Overview

Enhance the `/issue-writer` skill to automatically suggest Linear labels that help the autonomous workflow identify parallelizable tasks.

## When to Auto-Label

After generating the detailed task packet (Step 3 of existing skill), add a new Step 3.5:

### Step 3.5: Analyze and Suggest Labels

Before writing to Linear, analyze the expanded task packet and suggest labels.

## Label Detection Logic

### 1. **Risk Level** (Required)

```typescript
function detectRisk(description: string): string {
  // High Risk Indicators
  const highRiskPatterns = [
    /breaking change/i,
    /database migration/i,
    /schema change/i,
    /infrastructure change/i,
    /authentication/i,
    /security/i,
    /payment/i,
    /deployment/i
  ];

  // Low Risk Indicators
  const lowRiskPatterns = [
    /copy change/i,
    /text update/i,
    /css tweak/i,
    /style fix/i,
    /typo/i,
    /documentation/i
  ];

  // Check high risk first
  if (highRiskPatterns.some(p => p.test(description))) {
    return 'Risk: High';
  }

  // Check low risk
  if (lowRiskPatterns.some(p => p.test(description))) {
    return 'Risk: Low';
  }

  // Default to medium
  return 'Risk: Medium';
}
```

### 2. **Files to Modify** (Recommended)

Extract from "Technical Context" or "Files to Modify" section:

```typescript
function extractFiles(description: string): string[] {
  const files: string[] = [];

  // Pattern 1: Explicit "Files to Modify" section
  const filesSection = description.match(/##+ Files to .*?:\s*([\s\S]*?)(?=\n##|$)/i);
  if (filesSection) {
    const lines = filesSection[1].split('\n');
    lines.forEach(line => {
      // Extract paths from bullets: - path/to/file.ts
      const match = line.match(/[-*]\s*`?([^`\s]+\.[a-z]+)`?/i);
      if (match) files.push(match[1]);
    });
  }

  // Pattern 2: Inline mentions of file paths
  const pathMatches = description.match(/`([^`]+\.(ts|tsx|js|jsx|css|html))`/g);
  if (pathMatches) {
    pathMatches.forEach(m => {
      const path = m.replace(/`/g, '');
      if (!files.includes(path)) files.push(path);
    });
  }

  return files.slice(0, 5); // Limit to 5 most important files
}
```

### 3. **Layer Detection** (Recommended)

```typescript
function detectLayer(files: string[], description: string): string[] {
  const layers: string[] = [];

  // UI Layer
  if (files.some(f => /components\/.*\.(tsx|jsx)/i.test(f)) ||
      /frontend|component|ui|page|route/i.test(description)) {
    layers.push('Layer: UI');
  }

  // API Layer
  if (files.some(f => /api\/|routes\/|endpoints\//i.test(f)) ||
      /endpoint|api route|rest api/i.test(description)) {
    layers.push('Layer: API');
  }

  // Service Layer
  if (files.some(f => /services\/|lib\//i.test(f)) ||
      /business logic|service|utility/i.test(description)) {
    layers.push('Layer: Service');
  }

  // Database Layer
  if (files.some(f => /migrations\/|models\/|schema/i.test(f)) ||
      /database|schema|migration|sql/i.test(description)) {
    layers.push('Layer: Database');
  }

  // Infrastructure Layer
  if (files.some(f => /docker|terraform|\.yml|\.yaml|config/i.test(f)) ||
      /deployment|infrastructure|ci\/cd|config/i.test(description)) {
    layers.push('Layer: Infra');
  }

  return layers;
}
```

### 4. **Test Coverage** (Optional)

```typescript
function detectTests(description: string): string {
  if (/e2e test|playwright|cypress|selenium/i.test(description)) {
    return 'Tests: E2E';
  }
  if (/integration test|api test/i.test(description)) {
    return 'Tests: Integration';
  }
  if (/unit test|jest|vitest/i.test(description)) {
    return 'Tests: Unit';
  }
  return 'Tests: None';
}
```

### 5. **Area/Component** (Manual for now)

These are best assigned manually based on product knowledge:
- `Area: Landing`
- `Component: Hero`
- etc.

But you can detect from file paths:

```typescript
function suggestAreaFromFiles(files: string[]): string[] {
  const suggestions: string[] = [];

  if (files.some(f => /auth|login|signup/i.test(f))) {
    suggestions.push('Area: Auth');
  }
  if (files.some(f => /landing|hero|home/i.test(f))) {
    suggestions.push('Area: Landing');
  }
  if (files.some(f => /nav|menu|header/i.test(f))) {
    suggestions.push('Area: Navigation');
  }
  // ... more patterns

  return suggestions;
}
```

## Integration with Issue Writer Skill

### Updated Workflow

```markdown
## Step 3: Generate the Task Packet

[... existing task packet generation ...]

## Step 3.5: Analyze and Suggest Labels

After generating the detailed task packet, analyze it to suggest labels:

1. **Detect Risk Level**
   - High: Breaking changes, migrations, auth, payments
   - Low: Text/CSS tweaks, docs
   - Medium: Everything else

2. **Extract File Paths**
   - Parse "Technical Context" or "Files to Modify" section
   - Extract up to 5 key files
   - Format: `Files: path1.ts, path2.tsx, path3.css`

3. **Identify Layers**
   - Check file paths and description
   - Add `Layer: UI/API/Service/Database/Infra` as appropriate

4. **Check Test Requirements**
   - Parse validation steps
   - Add `Tests: Unit/Integration/E2E/None`

5. **Suggest Area/Component**
   - Based on file paths and description
   - User can override manually

## Step 4: Present Labels for Confirmation

Before updating Linear, show suggested labels:

```
Suggested Labels:
- Risk: Medium
- Files: src/components/Hero.tsx, src/hooks/useTheme.ts
- Layer: UI
- Tests: Unit
- Area: Landing (suggested - confirm?)

Add these labels? [y/N]
```

If user confirms, add labels when calling `update-issue.ts`.
```

## Example Output

### Input (Brief Issue)
```
Title: Add dark mode toggle

Description: Add a toggle switch to enable dark mode
```

### Output (After /issue-writer)
```markdown
## 1. Objective

[... detailed expansion ...]

## 2. Technical Context

### Files to Modify
- `src/components/SettingsPage.tsx` - Add toggle component
- `src/hooks/useTheme.ts` - Create theme hook
- `src/styles/themes.css` - Add dark theme styles

[... rest of task packet ...]

---

## Suggested Labels

Based on the analysis above, these labels are recommended:

- **Risk: Medium** - New feature with state management
- **Files: src/components/SettingsPage.tsx, src/hooks/useTheme.ts, src/styles/themes.css**
- **Layer: UI** - Frontend component work
- **Tests: Unit** - Hook testing required
- **Area: Settings** - Suggested based on file paths

These labels help the autonomous workflow:
- Avoid running multiple Settings tasks in parallel
- Prevent file conflicts with other tasks
- Assess overall risk when selecting parallel tasks
```

## CLI Tool for Label Management

Create `tools/suggest-labels.ts`:

```typescript
#!/usr/bin/env node
import { getIssue } from '../shared/lib/linear.js';
import dotenv from 'dotenv';

dotenv.config({ silent: true });

async function main() {
  const issueId = process.argv[2];
  if (!issueId) {
    console.error('Usage: npx tsx suggest-labels.ts HOK-123');
    process.exit(1);
  }

  const issue = await getIssue(issueId);
  const description = issue.description || '';

  // Detect labels
  const risk = detectRisk(description);
  const files = extractFiles(description);
  const layers = detectLayer(files, description);
  const tests = detectTests(description);

  console.log('\nSuggested Labels:\n');
  console.log(`- ${risk}`);
  if (files.length > 0) {
    console.log(`- Files: ${files.join(', ')}`);
  }
  layers.forEach(l => console.log(`- ${l}`));
  console.log(`- ${tests}`);

  console.log('\nTo apply these labels, run:');
  console.log(`npx tsx add-labels.ts ${issueId} "${risk}" "${layers.join('" "')}" "${tests}"`);
}

main();
```

## Batch Labeling Script

For existing backlog:

```bash
#!/bin/bash
# Label all backlog items

BACKLOG=$(npx tsx list-backlog-json.ts "Hokusai public website")

echo "$BACKLOG" | jq -r '.[].identifier' | while read issue; do
  echo "Analyzing $issue..."
  npx tsx suggest-labels.ts "$issue"
  read -p "Apply labels? [y/N] " confirm
  if [[ "$confirm" == "y" ]]; then
    # Apply labels
    echo "Labels applied to $issue"
  fi
done
```

## Quick Start

### Minimal Version (Start Here)

Just add Risk labels manually or with simple detection:

1. **Review each backlog item**
2. **Ask: "How risky is this?"**
   - Breaking change / migration / auth → `Risk: High`
   - New feature / refactor → `Risk: Medium`
   - Text/CSS/docs → `Risk: Low`
3. **Add label in Linear UI**

That's it! The workflow will:
- Max 1 High risk task at a time
- Max 2 Medium risk tasks at a time
- Unlimited Low risk tasks

### Full Version (Future)

Implement all detection logic in `/issue-writer` skill for full automation.

## Benefits

1. **Better Parallelization** - Workflow can select truly independent tasks
2. **Risk Management** - Don't run 3 risky changes at once
3. **Self-Documenting** - Labels make scope immediately clear
4. **Less Manual Curation** - Auto-detection reduces manual work
5. **Smarter Over Time** - Detection improves as patterns emerge

## Next Steps

1. ✅ Read [LABEL_SCHEMA.md](../../../shared/lib/LABEL_SCHEMA.md)
2. 📝 Add `Risk:` labels to current backlog items manually
3. 🔧 Update `/issue-writer` skill to suggest labels
4. 🤖 Test with autonomous workflow
5. 📊 Measure conflict reduction vs. baseline
