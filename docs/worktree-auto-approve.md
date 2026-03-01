# Worktree Auto-Approve Guide

This guide provides step-by-step instructions for configuring Claude Code and Codex to auto-approve read-only commands when working in git worktrees.

## Why Worktrees Need Different Permissions

Git worktrees provide **isolated environments** for parallel development:

- Changes in a worktree don't affect the main repository
- Each worktree has its own working directory and branch
- Read-only commands in worktrees are inherently safer

Because worktrees are isolated, we can safely auto-approve more commands without risk to the main codebase.

## Quick Start

### Step 1: Configure Patterns

Edit `.wavemill-config.json` in your repo root:

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
      "gh issue view*"
    ],
    "worktreeMode": {
      "enabled": true,
      "autoApproveReadOnly": true
    }
  }
}
```

### Step 2: Generate Agent Settings

Run the generator for your agent(s):

```bash
# For Claude Code
npx tsx tools/generate-claude-permissions.ts

# For Codex
npx tsx tools/generate-codex-permissions.ts
```

### Step 3: Apply Settings

Follow the agent-specific instructions below to apply the generated settings.

## Claude Code Integration

### Prerequisites

- Claude Code CLI installed
- Working in a git worktree (created via `wavemill mill` or manually)
- `.wavemill-config.json` configured with permission patterns

### Generate Settings

The generator will create a Claude Code-compatible settings file:

```bash
npx tsx tools/generate-claude-permissions.ts

# Output:
# Generated Claude Code settings at: .wavemill/claude-permissions.json
#
# To apply:
# 1. Open Claude Code settings (Cmd+,)
# 2. Navigate to "Tool Permissions" or "Auto-approve"
# 3. Import settings from: .wavemill/claude-permissions.json
```

### Apply Settings

#### Option 1: Via Claude Code UI (Recommended)

1. Open Claude Code
2. Go to Settings (Cmd+, or Ctrl+,)
3. Navigate to "Extensions" → "Claude Code" → "Tool Permissions"
4. Click "Import Settings"
5. Select `.wavemill/claude-permissions.json`
6. Click "Apply"
7. Restart Claude Code

#### Option 2: Via Settings File

1. Locate your Claude Code settings:
   ```bash
   # On macOS
   ~/Library/Application Support/Claude Code/User/settings.json

   # On Linux
   ~/.config/Claude Code/User/settings.json

   # On Windows
   %APPDATA%\Claude Code\User\settings.json
   ```

2. Merge generated settings:
   ```bash
   # Backup current settings
   cp ~/Library/Application\ Support/Claude\ Code/User/settings.json settings-backup.json

   # Merge with generated settings (manually edit or use jq)
   jq -s '.[0] * .[1]' settings-backup.json .wavemill/claude-permissions.json > settings-new.json

   # Replace settings
   cp settings-new.json ~/Library/Application\ Support/Claude\ Code/User/settings.json
   ```

3. Restart Claude Code

### Verify Configuration

Test that auto-approval works:

1. Open Claude Code in a worktree:
   ```bash
   cd ~/worktrees/your-feature
   code .
   ```

2. Ask Claude to run a read-only command:
   ```
   User: Run git status
   Claude: [Executes without asking for confirmation]
   ```

3. Verify write commands still require confirmation:
   ```
   User: Run git commit -m "test"
   Claude: [Asks for confirmation before executing]
   ```

### Troubleshooting Claude Code

#### Commands still require confirmation

**Solution 1**: Check settings were applied
```bash
# View current Claude Code settings
cat ~/Library/Application\ Support/Claude\ Code/User/settings.json | jq '.claudeCode.autoApprove'
```

**Solution 2**: Regenerate and reapply
```bash
npx tsx tools/generate-claude-permissions.ts
# Then reapply via UI or settings file
```

**Solution 3**: Restart Claude Code
```bash
# Fully quit and restart (not just reload window)
```

#### Pattern not matching

**Check pattern syntax**:
```bash
npx tsx -e "
import { matchesPattern } from './shared/lib/permission-patterns.ts';
console.log(matchesPattern('git status --short', 'git status*'));
"
```

## Codex Integration

### Prerequisites

- Codex CLI installed and configured
- Working in a git worktree
- `.wavemill-config.json` configured with permission patterns

### Generate Settings

```bash
npx tsx tools/generate-codex-permissions.ts

# Output:
# Generated Codex settings at: .wavemill/codex-permissions.json
#
# To apply:
# 1. Copy settings to ~/.codex/permissions.json
# 2. Restart Codex
```

### Apply Settings

#### Option 1: Via Codex Config File

```bash
# Create Codex permissions directory if it doesn't exist
mkdir -p ~/.codex

# Copy generated settings
cp .wavemill/codex-permissions.json ~/.codex/permissions.json

# Restart Codex
pkill -f codex
codex
```

#### Option 2: Merge with Existing Config

If you already have Codex permissions configured:

```bash
# Backup existing permissions
cp ~/.codex/permissions.json ~/.codex/permissions-backup.json

# Merge with generated settings
jq -s '.[0].autoApprovePatterns + .[1].autoApprovePatterns | unique | {"autoApprovePatterns": .}' \
  ~/.codex/permissions-backup.json \
  .wavemill/codex-permissions.json > ~/.codex/permissions.json

# Restart Codex
pkill -f codex
codex
```

### Verify Configuration

Test auto-approval in Codex:

1. Start Codex in a worktree:
   ```bash
   cd ~/worktrees/your-feature
   codex
   ```

2. Ask Codex to run a read-only command:
   ```
   User: Run git log --oneline
   Codex: [Executes without asking]
   ```

3. Verify write commands still need confirmation:
   ```
   User: Run git push
   Codex: [Asks for confirmation]
   ```

### Troubleshooting Codex

#### Commands still require confirmation

**Solution 1**: Verify permissions file exists
```bash
ls -la ~/.codex/permissions.json
cat ~/.codex/permissions.json | jq
```

**Solution 2**: Check Codex is reading the file
```bash
# Enable debug mode
export CODEX_DEBUG=1
codex

# Look for "Loaded permissions from..." in output
```

**Solution 3**: Restart Codex completely
```bash
pkill -9 -f codex
codex
```

## Advanced Configuration

### Context-Aware Permissions

Different patterns for worktrees vs main repo:

```json
{
  "permissions": {
    "autoApprovePatterns": [
      "git status*",
      "git log*"
    ],
    "worktreeMode": {
      "enabled": true,
      "autoApproveReadOnly": true
    }
  }
}
```

When `worktreeMode.enabled` is `true`, the agent will detect if you're in a worktree and apply relaxed permissions automatically.

### Environment-Specific Overrides

Use environment variables to override config:

```bash
# Disable auto-approve for sensitive operations
STRICT_PERMISSIONS=true wavemill mill

# Force auto-approve everything (dangerous!)
AUTO_APPROVE_ALL=true wavemill mill
```

### Per-Worktree Configuration

Create worktree-specific settings:

```bash
# In your worktree
cd ~/worktrees/your-feature

# Create local config (takes precedence)
cat > .wavemill-config.local.json <<EOF
{
  "permissions": {
    "autoApprovePatterns": [
      "git status*",
      "custom-tool*"
    ]
  }
}
EOF

# Regenerate settings
npx tsx tools/generate-claude-permissions.ts --local
```

## Team Setup

### Share Configuration

Commit the base config so all team members get the same auto-approvals:

```bash
git add .wavemill-config.json
git commit -m "Configure auto-approve for read-only commands"
git push
```

### Team Workflow

1. **One person sets up config**:
   ```bash
   # Edit .wavemill-config.json with team-appropriate patterns
   git add .wavemill-config.json
   git commit -m "Add permission patterns"
   git push
   ```

2. **Team members pull and apply**:
   ```bash
   git pull
   npx tsx tools/generate-claude-permissions.ts
   # Apply to their agent (Claude Code or Codex)
   ```

3. **Everyone gets consistent auto-approvals** across worktrees

### Documentation for Team

Add a note in your repo README:

```markdown
## Auto-Approve Setup

This repo uses wavemill permission patterns for read-only commands.

To enable auto-approval:

1. Pull latest config: `git pull`
2. Generate settings: `npx tsx tools/generate-claude-permissions.ts`
3. Apply to Claude Code (see docs/worktree-auto-approve.md)
4. Restart Claude Code

Commands like `git status`, `gh pr view`, `find`, `ls` will
auto-approve in worktrees without confirmation.
```

## Security Best Practices

### Principle of Least Privilege

Start with minimal auto-approvals and expand based on usage:

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

### Regular Audits

Review what gets auto-approved:

```bash
# Check agent logs for auto-approved commands
# Claude Code
cat ~/Library/Logs/Claude\ Code/main.log | grep "auto-approved"

# Codex
cat ~/.codex/logs/session.log | grep "auto-approved"
```

### Revoke When Needed

If a pattern turns out to be unsafe:

```bash
# Edit config, remove the pattern
vim .wavemill-config.json

# Regenerate agent settings
npx tsx tools/generate-claude-permissions.ts

# Restart agent
```

## Examples

### Example 1: Web Development Workflow

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
      "npm list*",
      "npm outdated*"
    ],
    "worktreeMode": {
      "enabled": true,
      "autoApproveReadOnly": true
    }
  }
}
```

### Example 2: Data Science Workflow

```json
{
  "permissions": {
    "autoApprovePatterns": [
      "find *",
      "ls *",
      "cat *",
      "head *",
      "tail *",
      "wc *",
      "git status*",
      "git log*",
      "grep *",
      "rg *"
    ]
  }
}
```

### Example 3: DevOps Workflow

```json
{
  "permissions": {
    "autoApprovePatterns": [
      "find *",
      "ls *",
      "cat *",
      "git status*",
      "git log*",
      "git show*",
      "kubectl get *",
      "kubectl describe *",
      "docker ps*",
      "docker images*"
    ]
  }
}
```

## Further Reading

- [Permission Configuration Guide](./permissions.md) - Detailed config reference
- [Pattern Reference](../shared/lib/permission-patterns.ts) - Full pattern library
- [Mill Mode Guide](./mill-mode.md) - Autonomous workflow system
