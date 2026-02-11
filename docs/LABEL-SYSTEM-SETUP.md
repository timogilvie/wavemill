# Label System Setup Complete ✅

## What Was Built

A comprehensive automatic labeling system for Linear issues that integrates seamlessly with the autonomous workflow.

## Changes Made

### 1. Linear API Extensions
**File**: `shared/lib/linear.js`
- Added `getLabels(teamId)` - Fetch all labels for a team
- Added `createLabel(name, teamId, options)` - Create new labels
- Added `addLabelsToIssue(issueId, labelIds)` - Apply labels to issues
- Added `getOrCreateLabel(name, teamId, options)` - Idempotent label creation

### 2. New Tools Created

#### `tools/init-labels.ts`
Initializes 23 predefined labels in your Linear workspace:
- **Risk**: Low, Medium, High (3 labels)
- **Area**: Landing, Navigation, Auth, API, Database, Docs, Infrastructure, Testing (8 labels)
- **Layer**: UI, API, Service, Database, Infra (5 labels)
- **Tests**: Unit, Integration, E2E, None (4 labels)
- **Component**: Hero, UserMenu, LoginForm (3 example labels)

**Usage**:
```bash
npx tsx ~/.claude/tools/init-labels.ts [TEAM_KEY]
```

#### `tools/auto-label-issue.ts`
Analyzes issue content and automatically applies appropriate labels:

**Usage**:
```bash
# Preview (dry-run)
npx tsx ~/.claude/tools/auto-label-issue.ts HOK-123 --dry-run

# Apply labels
npx tsx ~/.claude/tools/auto-label-issue.ts HOK-123
```

**Detection Logic**:
- **Risk**: Keywords like "breaking", "migration", "css", "docs"
- **Layer**: File paths (`.tsx` → UI, `/api/` → API, etc.)
- **Area**: Feature mentions (auth, database, docs, etc.)
- **Tests**: Validation steps (e2e, integration, unit)

### 3. Integration with expand-issue.ts
**File**: `~/.claude/tools/expand-issue.ts`

**Added**: Automatic labeling after updating Linear
- When `--update` flag is used, the tool now calls `auto-label-issue.ts`
- Applies labels based on the expanded content
- Reports which labels were applied

### 4. Integration with wavemill-mill.sh
**File**: `shared/lib/wavemill-mill.sh`

**Changed**: Line 210-215 now uses `--update` flag
```bash
# Before
npx tsx "$TOOLS_DIR/expand-issue.ts" "$issue_id" > "$out_file"

# After
npx tsx "$TOOLS_DIR/expand-issue.ts" "$issue_id" --update --output "$out_file"
```

**Impact**: Issues are now automatically:
1. Expanded with comprehensive task packets
2. Updated in Linear
3. Auto-labeled based on content
4. Saved locally for the orchestrator

### 5. Updated issue-writer Skill
**File**: `skills/issue-writer/SKILL.md`

**Added**: Step 3.5 - Auto-Generate Labels
- Instructions for analyzing content
- Label detection criteria
- Proposed Labels section in task packets

### 6. Documentation
**Files**:
- `docs/LABEL-SYSTEM.md` - Complete reference guide
- `docs/LABEL-SYSTEM-SETUP.md` - This file

## Testing Results

✅ **Labels Created**: 23 labels in Linear workspace (team: Hokusai)
✅ **Auto-Labeling Tested**: Issue HOK-647 successfully labeled with:
  - Risk: Medium
  - Layer: Infra
  - Area: Docs
  - Area: Infrastructure

## How It Works Now

### Automatic Flow (wavemill-mill.sh)

```
1. User runs wavemill-mill.sh
   ↓
2. Script detects simple issue descriptions
   ↓
3. Calls: expand-issue.ts --update --output
   ↓
4. expand-issue.ts:
   - Fetches issue from Linear
   - Uses Claude CLI to expand
   - Updates Linear with expanded description
   - Calls auto-label-issue.ts
   ↓
5. auto-label-issue.ts:
   - Analyzes expanded content
   - Detects Risk, Layer, Area, Tests
   - Applies matching labels to Linear
   ↓
6. wavemill-orchestrator.sh launches tasks
   ↓
7. Conflict detection uses labels to avoid conflicts
```

### Manual Usage

```bash
# Initialize labels (one-time setup)
npx tsx ~/.claude/tools/init-labels.ts

# Expand and auto-label an issue
npx tsx ~/.claude/tools/expand-issue.ts HOK-123 --update

# Just label an existing issue
npx tsx ~/.claude/tools/auto-label-issue.ts HOK-123
```

## Next Steps

1. **Add more Component labels** as you identify common components in your codebase
2. **Batch label existing backlog**:
   ```bash
   for issue in HOK-{100..200}; do
     npx tsx ~/.claude/tools/auto-label-issue.ts $issue 2>/dev/null || true
   done
   ```
3. **Update conflict detection** in wavemill-mill.sh to use the new labels (Risk, Layer, Files)
4. **Monitor and refine** label detection logic based on real-world usage

## Label Categories Reference

### Risk Level (Required)
- `Risk: Low` - CSS tweaks, text updates, docs
- `Risk: Medium` - New features, refactoring (default)
- `Risk: High` - Breaking changes, migrations, infrastructure

**Conflict Rule**: Max 1 High, max 2 Medium at a time

### Area (Recommended)
`Area: Landing`, `Area: Auth`, `Area: API`, `Area: Database`, `Area: Docs`, `Area: Infrastructure`, `Area: Testing`, `Area: Navigation`

**Conflict Rule**: Avoid 2+ tasks with same Area

### Layer (Recommended)
`Layer: UI`, `Layer: API`, `Layer: Service`, `Layer: Database`, `Layer: Infra`

**Conflict Rule**: Prefer tasks from different layers

### Tests (Auto-Generated)
`Tests: Unit`, `Tests: Integration`, `Tests: E2E`, `Tests: None`

**Conflict Rule**: Avoid 2+ E2E tasks (slow)

## Files Modified

```
shared/lib/linear.js              ← Label management functions
tools/init-labels.ts              ← New (initialize labels)
tools/auto-label-issue.ts         ← New (auto-label issues)
~/.claude/tools/expand-issue.ts   ← Modified (auto-label after update)
shared/lib/wavemill-mill.sh        ← Modified (use --update flag)
skills/issue-writer/SKILL.md      ← Updated (auto-label instructions)
docs/LABEL-SYSTEM.md              ← New (complete reference)
docs/LABEL-SYSTEM-SETUP.md        ← New (this file)
```

## Backup & Sync

Tools are symlinked from this repo to `~/.claude/tools/`:
```bash
# To sync changes
cp -v tools/*.ts ~/.claude/tools/
cp -v shared/lib/*.sh ~/.claude/lib/
```

---

**Status**: ✅ Complete and tested
**Integration**: ✅ Automatic in wavemill-mill.sh
**Documentation**: ✅ Complete
**Next**: Use in production workflow
