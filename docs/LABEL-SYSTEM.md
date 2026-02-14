# Label System

Labels on Linear issues identify which tasks can safely run in parallel in autonomous workflows.

## Label Categories

### Risk Level (Required)
- `Risk: Low` — Simple, isolated changes (CSS tweaks, text updates, docs)
- `Risk: Medium` — New features, refactoring (most tasks)
- `Risk: High` — Breaking changes, migrations, infrastructure

**Conflict rule**: Max 1 High, max 2 Medium tasks at a time.

### Area (Recommended)
Product area affected:
`Area: Landing`, `Area: Navigation`, `Area: Auth`, `Area: API`, `Area: Database`, `Area: Docs`, `Area: Infrastructure`, `Area: Testing`

**Conflict rule**: Avoid 2+ tasks with the same Area.

### Layer (Recommended)
Architectural layer affected:
`Layer: UI`, `Layer: API`, `Layer: Service`, `Layer: Database`, `Layer: Infra`

**Conflict rule**: Prefer tasks from different layers.

### Tests (Auto-generated)
`Tests: Unit`, `Tests: Integration`, `Tests: E2E`, `Tests: None`

**Conflict rule**: Avoid 2+ E2E tasks (slow, flaky).

### Component (Auto-created)
Extracted from file paths — e.g. `src/components/Hero.tsx` produces `Component: Hero`. New component labels are created in Linear automatically.

**Conflict rule**: Avoid 2+ tasks on the same Component.

### Files (Auto-generated)
Lists specific files modified, e.g. `Files: src/components/Hero.tsx, src/hooks/useTheme.ts`. Used to detect overlapping file paths between tasks.

## How Labels Get Applied

### Automatic (default)
When an issue is expanded with `--update`, labels are applied automatically:
```bash
npx tsx tools/expand-issue.ts HOK-123 --update
```
This also happens inside `wavemill-mill.sh` for simple issues it detects.

### Manual
```bash
# Preview labels without applying
npx tsx tools/auto-label-issue.ts HOK-123 --dry-run

# Apply with confirmation prompt
npx tsx tools/auto-label-issue.ts HOK-123 --interactive

# Apply automatically
npx tsx tools/auto-label-issue.ts HOK-123
```

### Re-label after editing a description
```bash
npx tsx tools/auto-label-issue.ts HOK-123
```

## What Gets Auto-Detected

| Signal | Source |
|--------|--------|
| Risk level | Keywords like "migration", "breaking", "docs" |
| Layer | File extensions and paths (`.tsx` → UI, `/api/` → API) |
| Area | File paths first, then keyword fallback |
| Tests | Validation steps mentioning e2e, unit, integration |
| Component | File paths matching `components/ComponentName.tsx` |
| Files | Extracted from "Technical Context" section |

For the most accurate detection, list exact file paths in the issue's Technical Context section.

## One-Time Setup

Initialize the predefined labels in your Linear workspace:
```bash
npx tsx tools/init-labels.ts [TEAM_KEY]
```

## Troubleshooting

**"Label not found"** — Run `npx tsx tools/init-labels.ts` to initialize labels.

**Component not detected** — The file must match `components/ComponentName.tsx` (PascalCase, in a `components/` directory).

**Area not detected** — Add explicit file paths to the issue's Technical Context section rather than relying on keyword mentions.
