# Linear Label System

Comprehensive label system for identifying which tasks can safely run in parallel in autonomous workflows.

## Label Categories

### 1. Risk Level (Required)
- `Risk: Low` — Simple, isolated changes (CSS tweaks, text updates)
- `Risk: Medium` — New features, refactoring (most tasks)
- `Risk: High` — Breaking changes, migrations, infrastructure

**Conflict Rule**: Max 1 High, max 2 Medium tasks at a time

### 2. Area (Recommended)
Product area affected (use Layer labels for architectural layers like API, Database, Infra):
- `Area: Landing` — Landing page and homepage
- `Area: Navigation` — Navigation and routing
- `Area: Auth` — Authentication and authorization
- `Area: Docs` — Documentation

**Conflict Rule**: Avoid 2+ tasks with same Area

### 3. Layer (Recommended)
Architectural layer affected:
- `Layer: UI` — Frontend components
- `Layer: API` — API routes and endpoints
- `Layer: Service` — Business logic
- `Layer: Database` — Schema and migrations
- `Layer: Infra` — Configuration and deployment

**Conflict Rule**: Prefer tasks from different layers

### 4. Tests (Auto-Generated)
Test requirements:
- `Tests: Unit` — Unit tests required
- `Tests: Integration` — Integration tests required
- `Tests: E2E` — End-to-end tests required
- `Tests: None` — No tests required

**Conflict Rule**: Avoid 2+ E2E tasks (slow, flaky)

### 5. Component (Optional)
Specific component affected:
- `Component: Hero`
- `Component: UserMenu`
- `Component: LoginForm`
- etc.

**Conflict Rule**: Avoid 2+ tasks with same Component

### 6. Files (Auto-Generated)
Specific files modified (in description):
- Format: `Files: src/components/Hero.tsx, src/hooks/useTheme.ts`

**Conflict Rule**: Check for overlapping file paths

## Tools

### Initialize Labels in Workspace
Creates all predefined labels in your Linear workspace:

```bash
npx tsx tools/init-labels.ts [TEAM_KEY]
```

Example:
```bash
npx tsx tools/init-labels.ts HOK
```

### Auto-Label an Issue
Analyzes issue content and applies appropriate labels:

```bash
npx tsx tools/auto-label-issue.ts HOK-XXX [--dry-run]
```

Examples:
```bash
# Dry run (preview without applying)
npx tsx tools/auto-label-issue.ts HOK-123 --dry-run

# Apply labels
npx tsx tools/auto-label-issue.ts HOK-123
```

The tool automatically detects:
- **Risk level** — Based on keywords (breaking, migration, etc.)
- **Layers** — From file paths and implementation description
- **Areas** — From feature/component mentions
- **Tests** — From validation steps
- **Files** — From technical context section

## Issue Writer Integration

The `/issue-writer` skill and `expand-issue.ts` tool now automatically:
1. Generates comprehensive task packets
2. Updates Linear with expanded description (when `--update` flag is used)
3. Analyzes content to determine appropriate labels
4. Applies labels to Linear issue automatically

### Automatic Labeling Flow

When an issue is expanded with `expand-issue.ts --update`:
```bash
npx tsx ~/.claude/tools/expand-issue.ts HOK-123 --update
```

The tool will:
1. Fetch the issue from Linear
2. Use Claude CLI to expand it with the issue-writer prompt
3. Update the Linear issue with the expanded description
4. **Automatically call `auto-label-issue.ts` to apply labels**
5. Report which labels were applied

### Integration with wavemill-mill.sh

The autonomous workflow (`wavemill-mill.sh`) now automatically:
- Detects simple issue descriptions
- Expands them using `expand-issue.ts --update`
- Auto-labels based on the expanded content
- Uses the labeled issues for conflict detection

See [skills/issue-writer/SKILL.md](../skills/issue-writer/SKILL.md) for details.

## Workflow Integration

### Conflict Detection

When selecting tasks for parallel execution, check:

```bash
# Example conflict detection logic
if same_area() then CONFLICT_SCORE += 10
if overlapping_files() then CONFLICT_SCORE += 20
if count(Risk: High) > 1 then REJECT
if count(Risk: Medium) > 2 then REJECT
if blocked_by_another_task() then REJECT
```

### Safe Parallel Examples

✅ **Safe to run in parallel:**
```
Task A: Risk: Low, Area: Landing, Layer: UI
Task B: Risk: Low, Area: Auth, Layer: Service
Task C: Risk: Low, Area: Docs, Layer: None
```

❌ **Avoid parallel execution:**
```
Task A: Risk: High, Area: Database, Files: schema.prisma
Task B: Risk: Medium, Area: Database, Files: migrations/
```

## Label Management API

The shared Linear library (`shared/lib/linear.js`) provides:

```javascript
import {
  getLabels,
  createLabel,
  addLabelsToIssue,
  getOrCreateLabel
} from './shared/lib/linear.js';

// Get all labels for a team
const labels = await getLabels(teamId);

// Create a new label
const label = await createLabel('Risk: Medium', teamId, {
  color: '#F5A623',
  description: 'New features, refactoring'
});

// Add labels to an issue
await addLabelsToIssue(issueId, [labelId1, labelId2]);

// Get or create label (idempotent)
const label = await getOrCreateLabel('Area: API', teamId);
```

## Best Practices

1. **Always initialize labels first** before auto-labeling issues
2. **Run auto-label in dry-run mode** to preview before applying
3. **Update issue-writer skill** to include label proposals in task packets
4. **Review labels** before starting parallel workflows
5. **Add Component labels** manually for domain-specific components
6. **Use Files: section** in issue descriptions for precise conflict detection

## Examples

### Labeling a UI Feature
```bash
# Issue: "Add dark mode toggle to settings"
npx tsx tools/auto-label-issue.ts HOK-456

# Applied labels:
# - Risk: Medium
# - Layer: UI
# - Area: Settings
# - Tests: Unit
# - Files: src/components/SettingsPage.tsx, src/hooks/useTheme.ts
```

### Labeling a Database Migration
```bash
# Issue: "Add user preferences table"
npx tsx tools/auto-label-issue.ts HOK-789

# Applied labels:
# - Risk: High
# - Layer: Database
# - Area: Database
# - Tests: Integration
# - Files: prisma/schema.prisma, prisma/migrations/
```

### Labeling Documentation
```bash
# Issue: "Document API authentication flow"
npx tsx tools/auto-label-issue.ts HOK-321

# Applied labels:
# - Risk: Low
# - Area: Docs
# - Tests: None
# - Files: docs/api-auth.md
```
