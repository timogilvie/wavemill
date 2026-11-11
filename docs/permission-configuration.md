---
title: Permission Configuration
---

# Permission Configuration

The `permissions` section in `.wavemill-config.json` allows you to configure auto-approval for read-only commands, reducing confirmation prompts when working in worktrees.

### Configuration

Add to `.wavemill-config.json`:

```json
{
  "permissions": {
    "autoApprovePatterns": [
      "git status*",
      "git log*",
      "gh pr view*",
      "find *",
      "ls *"
    ],
    "worktreeMode": {
      "enabled": true,
      "autoApproveReadOnly": true
    }
  }
}
```

### Using Permission Patterns in Code

```typescript
import {
  matchesPattern,
  matchesAnyPattern,
  isSafePattern,
  getDefaultPatterns
} from './shared/lib/permission-patterns.ts';

// Check if a command matches a pattern
matchesPattern('git status --short', 'git status*')  // true

// Check if a command matches any pattern
const patterns = ['git status*', 'git log*'];
matchesAnyPattern('git status', patterns)  // true

// Validate pattern is safe (no destructive commands)
isSafePattern('git status*')  // true
isSafePattern('rm *')          // false

// Get all default read-only patterns
const defaults = getDefaultPatterns();
```

### Pattern Categories

Default patterns are organized by category:

- **File System Read**: `find *`, `ls *`, `cat *`, `head *`, `tail *`, etc.
- **Git Read**: `git status*`, `git log*`, `git show*`, `git diff*`, etc.
- **GitHub CLI Read**: `gh pr view*`, `gh issue view*`, etc.
- **Text Search**: `grep *`, `rg *`, `ag *`, `ack *`
- **Package Managers**: `npm list*`, `pnpm list*`, `yarn list*`

### Agent Integration

**For Claude Code:**
```bash
npx tsx tools/generate-permissions.ts --agent claude
# Apply generated settings to Claude Code (see docs/worktree-auto-approve.md)
```

**For Codex:**
```bash
npx tsx tools/generate-permissions.ts --agent codex
# Copy to ~/.codex/permissions.json and restart Codex
```

### Documentation

- [Permission Configuration Guide](permissions.md) - Full reference
- [Worktree Auto-Approve Guide](worktree-auto-approve.md) - Agent setup instructions
