# Quick Start: Label System

## One-Time Setup (Already Done ✅)

```bash
# 1. Initialize labels in Linear
npx tsx ~/.claude/tools/init-labels.ts

# 2. Copy shared library
mkdir -p ~/.claude/shared/lib
cp shared/lib/linear.js ~/.claude/shared/lib/

# 3. Done! Ready to use.
```

## Daily Usage

### Auto-Label a Single Issue

```bash
# Preview labels (dry-run)
npx tsx auto-label-issue.ts HOK-123 --dry-run

# Apply with confirmation
npx tsx auto-label-issue.ts HOK-123 --interactive

# Apply automatically
npx tsx auto-label-issue.ts HOK-123
```

### Expand Issue + Auto-Label

```bash
# This does both: expand and label
npx tsx expand-issue.ts HOK-123 --update
```

### Batch Label Backlog

```bash
# Interactive review of each issue
for issue in HOK-{100..150}; do
  npx tsx auto-label-issue.ts $issue --interactive 2>/dev/null || true
done
```

## Label Categories

| Category | Purpose | Conflict Rule |
|----------|---------|---------------|
| **Risk: Low/Medium/High** | Task complexity | Max 1 High, 2 Medium |
| **Area: Landing/Auth/API/...** | Feature area | Avoid same Area |
| **Layer: UI/API/Service/...** | Architectural layer | Prefer different layers |
| **Tests: Unit/Integration/E2E** | Test requirements | Avoid 2+ E2E |
| **Component: Hero/UserMenu/...** | Specific component | Auto-created from files |
| **Files: path1.ts, path2.tsx** | Files modified | Avoid overlapping files |

## What Gets Auto-Detected

✅ **Risk Level** - Keywords like "migration", "breaking", "docs"
✅ **Layer** - File paths (`.tsx` → UI, `/api/` → API)
✅ **Area** - File paths (`auth/` → Auth, `landing/` → Landing)
✅ **Tests** - Validation steps (e2e, unit, integration)
✅ **Component** - From file paths (`components/Hero.tsx` → Component: Hero)
✅ **Files** - Extracted from "Technical Context" section

## Integration with Workflow

### Automatic Flow (hokusai-loop.sh)

```
1. hokusai-loop detects simple issue
2. Calls: expand-issue.ts --update
3. expand-issue.ts:
   - Expands with Claude CLI
   - Updates Linear
   - Calls auto-label-issue.ts ← Automatic!
4. auto-label-issue.ts:
   - Detects labels from content
   - Creates component labels if needed
   - Applies to Linear
5. hokusai-orchestrator uses labels for conflict detection
```

### Manual Flow (/issue-writer skill)

```
1. User runs /issue-writer HOK-123
2. Skill expands issue with full context
3. Task packet includes Section 9: Proposed Labels
4. Labels auto-applied when updating Linear
5. Ready for autonomous execution
```

## Common Patterns

### Label a Newly Created Issue

```bash
# After creating issue in Linear
npx tsx auto-label-issue.ts HOK-XXX --interactive
```

### Re-Label After Description Change

```bash
# If you edit issue description in Linear
npx tsx auto-label-issue.ts HOK-XXX --dry-run  # Preview changes
npx tsx auto-label-issue.ts HOK-XXX            # Apply
```

### Check Current Labels

```bash
npx tsx get-issue.ts HOK-XXX | grep "Labels:"
```

## Troubleshooting

### "Label not found" Error

**Solution**: Initialize labels first
```bash
npx tsx init-labels.ts
```

### Component Label Not Created

**Check**: Does file path match `components/ComponentName.tsx`?

**Example**:
- ✅ `src/components/Hero.tsx` → `Component: Hero`
- ❌ `src/views/hero.tsx` → Not detected (wrong directory/casing)

### Area Not Detected

**Solution**: Use file-based detection by listing files in "Technical Context" section

**Good**:
```markdown
## Technical Context
### Files to Modify
- src/auth/LoginForm.tsx
```
Result: `Area: Auth` (detected from file path)

**Not as good**:
```markdown
## Technical Context
We need to update the auth system.
```
Result: May or may not detect Area: Auth (text-based only)

## Tips

1. **Use interactive mode** when first learning: `--interactive`
2. **Dry-run first** for batch operations: `--dry-run`
3. **Let auto-creation work** - Don't manually create Component labels
4. **File paths matter** - Specify exact files in task packets for accurate detection
5. **Review Section 9** of task packets to understand label choices

## Help

```bash
# Get help
npx tsx auto-label-issue.ts --help

# View label system docs
cat docs/LABEL-SYSTEM.md

# View enhancement details
cat docs/LABEL-ENHANCEMENTS.md
```
