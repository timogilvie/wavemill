# Permission Configuration Guide

This guide explains how to configure auto-approval patterns for read-only commands in Claude Code and Codex when working with wavemill workflows.

## Overview

When AI agents work in isolated worktrees, many read-only commands (like `git status`, `gh pr view`, `find`, `ls`) require user confirmation. This can slow down autonomous workflows and create unnecessary friction.

The wavemill permissions system provides:

1. **Client-agnostic configuration** - Define patterns once, use with any agent (Claude Code, Codex, etc.)
2. **Safety-first approach** - Only safe, read-only commands are auto-approved
3. **Easy to extend** - Add new patterns via simple config file edits
4. **Worktree-aware** - Special relaxed mode when working in isolated environments

## Configuration

### Location

Permissions are configured in `.wavemill-config.json` in your repository root:

```json
{
  "permissions": {
    "autoApprovePatterns": [
      "git status*",
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

### Schema

The `permissions` section supports:

- **`autoApprovePatterns`** (array of strings): Command patterns that are auto-approved
  - Uses glob-style matching: `*` matches any characters
  - Case-sensitive
  - Must match from start of command

- **`worktreeMode`** (object): Special settings for worktree environments
  - **`enabled`** (boolean, default: `true`): Enable relaxed permissions in worktrees
  - **`autoApproveReadOnly`** (boolean, default: `true`): Auto-approve read-only commands

## Pattern Syntax

Patterns use **glob-style matching** for simplicity:

- `git status*` matches `git status`, `git status --short`, `git status --porcelain`
- `ls *` matches `ls`, `ls -la`, `ls -lh /path`
- `pwd` matches exactly `pwd` (no wildcard needed for exact matches)
- `gh pr view*` matches `gh pr view 123`, `gh pr view --web`

**Important**: Patterns are case-sensitive. `git status*` will NOT match `GIT STATUS`.

## Default Read-Only Patterns

Wavemill provides curated default patterns organized by category:

### File System Read Operations
```
find *, ls *, cat *, head *, tail *, wc *, file *, stat *, du *, tree *,
pwd, realpath *, readlink *, basename *, dirname *
```

### Git Read Operations
```
git status*, git log*, git show*, git diff*, git branch --list*,
git branch -l*, git remote*, git config --list*, git config --get*,
git worktree list*, git rev-parse*, git describe*, git tag --list*,
git ls-files*, git blame*, git reflog*
```

### GitHub CLI Read Operations
```
gh pr view*, gh pr list*, gh pr status*, gh pr checks*, gh pr diff*,
gh issue view*, gh issue list*, gh repo view*, gh release view*,
gh run view*, gh workflow view*
```

### Process & System Read Operations
```
ps *, which *, whereis *, env, printenv*, echo *, date*, uptime*,
hostname*, uname*, whoami
```

### Package Manager Read Operations
```
npm list*, npm ls*, npm outdated*, npm view*,
pnpm list*, pnpm outdated*, yarn list*, yarn info*
```

### Text Search Operations
```
grep *, rg *, ag *, ack *
```

## Safety Features

The permissions system includes built-in safety checks:

### Dangerous Pattern Detection

Patterns are validated to ensure they don't auto-approve destructive commands:

**❌ These patterns are BLOCKED:**
```
rm *, git push*, git commit*, git reset*, npm install*, sudo *, chmod *
```

**✅ These patterns are SAFE:**
```
git status*, gh pr view*, ls *, cat *, npm list*
```

### Pattern Validation

Use the pattern matching utilities to validate patterns:

```typescript
import { isSafePattern, matchesPattern } from './shared/lib/permission-patterns.ts';

// Check if a pattern is safe
isSafePattern('git status*')  // true
isSafePattern('rm *')          // false

// Check if a command matches a pattern
matchesPattern('git status --short', 'git status*')  // true
matchesPattern('git commit', 'git status*')          // false
```

## Usage Examples

### Example 1: Minimal Configuration

Auto-approve only git read operations:

```json
{
  "permissions": {
    "autoApprovePatterns": [
      "git status*",
      "git log*",
      "git diff*",
      "git show*"
    ]
  }
}
```

### Example 2: Comprehensive Configuration

Auto-approve common development commands:

```json
{
  "permissions": {
    "autoApprovePatterns": [
      "find *",
      "ls *",
      "cat *",
      "git status*",
      "git log*",
      "git diff*",
      "gh pr view*",
      "gh pr list*",
      "gh issue view*",
      "npm list*",
      "grep *",
      "rg *"
    ],
    "worktreeMode": {
      "enabled": true,
      "autoApproveReadOnly": true
    }
  }
}
```

### Example 3: Team-Shared Configuration

Version control your permissions config for consistency across team:

```bash
# In your repo
git add .wavemill-config.json
git commit -m "Add shared permission patterns"
git push

# Team members pull and get the same auto-approvals
git pull
```

## Integration with Agents

The `.wavemill-config.json` file is **client-agnostic** - it defines patterns in a standard format that can be used by any agent.

To apply these patterns to specific agents:

### Claude Code

See [Worktree Auto-Approve Guide](./worktree-auto-approve.md#claude-code-integration) for detailed instructions.

Quick summary:
1. Use `npx tsx tools/generate-claude-permissions.ts` to generate Claude Code settings
2. Apply the settings to your Claude Code configuration
3. Restart Claude Code

### Codex

See [Worktree Auto-Approve Guide](./worktree-auto-approve.md#codex-integration) for detailed instructions.

Quick summary:
1. Use `npx tsx tools/generate-codex-permissions.ts` to generate Codex settings
2. Apply the settings to your Codex configuration
3. Restart Codex

## Adding Custom Patterns

To add custom patterns for your project:

1. **Edit `.wavemill-config.json`**:
   ```json
   {
     "permissions": {
       "autoApprovePatterns": [
         "git status*",
         "your custom pattern*"
       ]
     }
   }
   ```

2. **Validate the pattern is safe**:
   ```bash
   npx tsx -e "
   import { isSafePattern } from './shared/lib/permission-patterns.ts';
   console.log(isSafePattern('your custom pattern*'));
   "
   ```

3. **Test the pattern matches correctly**:
   ```bash
   npx tsx -e "
   import { matchesPattern } from './shared/lib/permission-patterns.ts';
   console.log(matchesPattern('your command', 'your custom pattern*'));
   "
   ```

4. **Regenerate agent settings**:
   ```bash
   npx tsx tools/generate-claude-permissions.ts
   npx tsx tools/generate-codex-permissions.ts
   ```

## Troubleshooting

### Pattern Not Matching

**Problem**: Command still requires confirmation even though pattern exists.

**Solution**:
1. Check pattern syntax (glob-style, case-sensitive)
2. Ensure pattern matches from start of command
3. Verify pattern was applied to agent settings
4. Restart agent after updating settings

### Unsafe Pattern Warning

**Problem**: Pattern fails safety validation.

**Solution**:
1. Review the pattern - does it match destructive commands?
2. Make pattern more specific (e.g., `git branch -l*` instead of `git branch*`)
3. If pattern is truly safe, file an issue to update the safety rules

### Pattern Not Loading

**Problem**: Config changes not taking effect.

**Solution**:
1. Verify JSON syntax is valid
2. Check schema validation passes: `npx tsx tools/verify-permissions.ts`
3. Clear config cache: restart your workflow
4. Regenerate agent settings and restart agent

## Best Practices

### Start Conservative

Begin with a minimal set of patterns and expand based on actual usage:

```json
{
  "permissions": {
    "autoApprovePatterns": [
      "git status*",
      "git log*",
      "ls *"
    ]
  }
}
```

### Version Control

Always commit your `.wavemill-config.json` so team members share the same configuration:

```bash
git add .wavemill-config.json
git commit -m "Update permission patterns"
```

### Document Custom Patterns

Add comments (in commit messages or docs) explaining why custom patterns were added:

```bash
git commit -m "Add 'make test-dry-run*' to auto-approve patterns

This command runs tests in dry-run mode (read-only) and is safe
to auto-approve. Used frequently in CI/CD workflows."
```

### Regular Review

Periodically review your patterns to ensure they're still needed and safe:

```bash
# List all patterns
jq '.permissions.autoApprovePatterns' .wavemill-config.json
```

## Security Considerations

### Principle of Least Privilege

Only auto-approve commands that are:
- **Read-only** - Cannot modify files, git history, or remote state
- **Safe** - Cannot expose secrets or sensitive information
- **Necessary** - Actually speed up your workflows

### Audit Trail

All auto-approved commands are still logged by the agent. Review logs to ensure patterns are being used appropriately.

### Context Matters

Patterns that are safe in a worktree might not be safe in your main repo:
- Worktrees are isolated - changes won't affect main branch
- Main repo changes are permanent - be more conservative

Use `worktreeMode` to differentiate:

```json
{
  "permissions": {
    "worktreeMode": {
      "enabled": true,
      "autoApproveReadOnly": true
    }
  }
}
```

## Further Reading

- [Worktree Auto-Approve Guide](./worktree-auto-approve.md) - Agent-specific integration
- [Pattern Reference](../shared/lib/permission-patterns.ts) - Full pattern library
- [Schema Reference](../wavemill-config.schema.json) - Complete config schema
