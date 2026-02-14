#!/usr/bin/env npx tsx
/**
 * Git Worktree Manager for Parallel Workflows
 *
 * Commands:
 *   create <branch-name> [base-branch]  - Create worktree for feature
 *   list                                 - List all worktrees
 *   status                               - Show status of all worktrees
 *   remove <branch-name>                 - Remove worktree and optionally branch
 *   prune                                - Clean up stale worktrees
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { sanitizeBranchName } from '../shared/lib/git.js';

const WORKTREE_BASE = process.env.WORKTREE_BASE || path.join(process.env.HOME!, 'worktrees');

function run(cmd: string, options: { cwd?: string; silent?: boolean } = {}): string {
  try {
    const result = execSync(cmd, {
      cwd: options.cwd,
      encoding: 'utf-8',
      stdio: options.silent ? 'pipe' : 'inherit'
    });
    return typeof result === 'string' ? result.trim() : '';
  } catch (error: any) {
    if (options.silent) {
      return '';
    }
    throw error;
  }
}

function getMainBranch(): string {
  const branches = run('git branch -l main master', { silent: true });
  if (branches.includes('main')) return 'main';
  if (branches.includes('master')) return 'master';
  return 'main';
}

function createWorktree(branchName: string, baseBranch?: string): void {
  const mainBranch = baseBranch || getMainBranch();
  const remoteRef = `origin/${mainBranch}`;
  const fullBranchName = sanitizeBranchName(branchName);
  const sanitized = fullBranchName.split('/')[1];
  const worktreePath = path.join(WORKTREE_BASE, sanitized);

  // Ensure base directory exists
  if (!fs.existsSync(WORKTREE_BASE)) {
    fs.mkdirSync(WORKTREE_BASE, { recursive: true });
  }

  // Check if worktree already exists
  if (fs.existsSync(worktreePath)) {
    console.log(`Worktree already exists at: ${worktreePath}`);
    return;
  }

  // Fetch latest base branch so worktree starts from up-to-date main
  console.log(`Fetching latest ${mainBranch} from origin...`);
  run(`git fetch origin ${mainBranch}`, { silent: true });

  // Create or reset branch to latest origin ref
  const existingBranches = run('git branch --list', { silent: true });
  if (existingBranches.includes(fullBranchName)) {
    console.log(`Branch ${fullBranchName} exists, resetting to ${remoteRef}`);
    run(`git branch -f ${fullBranchName} ${remoteRef}`);
  } else {
    console.log(`Creating branch: ${fullBranchName} from ${remoteRef}`);
    run(`git branch ${fullBranchName} ${remoteRef}`);
  }

  // Create worktree
  console.log(`Creating worktree at: ${worktreePath}`);
  run(`git worktree add "${worktreePath}" ${fullBranchName}`);

  // Initialize feature directory
  const featureDir = path.join(worktreePath, 'features', sanitized);
  fs.mkdirSync(featureDir, { recursive: true });

  console.log(`\n✅ Worktree created successfully`);
  console.log(`   Path: ${worktreePath}`);
  console.log(`   Branch: ${fullBranchName}`);
  console.log(`   Feature dir: features/${sanitized}/`);
}

function listWorktrees(): void {
  console.log('Git Worktrees:\n');
  run('git worktree list');
}

function getWorktreeStatus(): void {
  const output = run('git worktree list --porcelain', { silent: true });
  const worktrees = output.split('\n\n').filter(Boolean);

  console.log('Worktree Status:\n');
  console.log('─'.repeat(60));

  for (const wt of worktrees) {
    const lines = wt.split('\n');
    const worktreePath = lines.find(l => l.startsWith('worktree '))?.replace('worktree ', '');
    const branch = lines.find(l => l.startsWith('branch '))?.replace('branch refs/heads/', '');

    if (!worktreePath || worktreePath === process.cwd()) continue;

    // Get status in worktree
    const status = run('git status --porcelain', { cwd: worktreePath, silent: true });
    const changes = status.split('\n').filter(Boolean).length;

    // Check for parallel workflow state
    const sessionFile = path.join(worktreePath, '.parallel-workflow', 'session.json');
    let phase = 'unknown';
    if (fs.existsSync(sessionFile)) {
      const session = JSON.parse(fs.readFileSync(sessionFile, 'utf-8'));
      phase = session.phase || 'unknown';
    }

    console.log(`📁 ${path.basename(worktreePath)}`);
    console.log(`   Path: ${worktreePath}`);
    console.log(`   Branch: ${branch}`);
    console.log(`   Changes: ${changes > 0 ? `${changes} files modified` : 'clean'}`);
    console.log(`   Phase: ${phase}`);
    console.log('');
  }
}

function removeWorktree(branchName: string, deleteBranch = false): void {
  const fullBranchName = sanitizeBranchName(branchName);
  const sanitized = fullBranchName.split('/')[1];
  const worktreePath = path.join(WORKTREE_BASE, sanitized);

  if (!fs.existsSync(worktreePath)) {
    console.log(`Worktree not found: ${worktreePath}`);
    return;
  }

  // Check for uncommitted changes
  const status = run('git status --porcelain', { cwd: worktreePath, silent: true });
  if (status) {
    console.log('⚠️  Worktree has uncommitted changes:');
    console.log(status);
    console.log('\nUse --force to remove anyway');
    return;
  }

  console.log(`Removing worktree: ${worktreePath}`);
  run(`git worktree remove "${worktreePath}"`);

  if (deleteBranch) {
    console.log(`Deleting branch: ${fullBranchName}`);
    run(`git branch -d ${fullBranchName}`, { silent: true });
  }

  console.log('✅ Worktree removed');
}

function pruneWorktrees(): void {
  console.log('Pruning stale worktrees...');
  run('git worktree prune');
  console.log('✅ Stale worktrees pruned');
}

// CLI
const [,, command, ...args] = process.argv;

switch (command) {
  case 'create':
    if (!args[0]) {
      console.log('Usage: worktree-manager.ts create <branch-name> [base-branch]');
      process.exit(1);
    }
    createWorktree(args[0], args[1]);
    break;

  case 'list':
    listWorktrees();
    break;

  case 'status':
    getWorktreeStatus();
    break;

  case 'remove':
    if (!args[0]) {
      console.log('Usage: worktree-manager.ts remove <branch-name> [--delete-branch]');
      process.exit(1);
    }
    removeWorktree(args[0], args.includes('--delete-branch'));
    break;

  case 'prune':
    pruneWorktrees();
    break;

  default:
    console.log(`
Git Worktree Manager for Parallel Workflows

Commands:
  create <branch-name> [base]  Create worktree for feature
  list                         List all worktrees
  status                       Show detailed status of all worktrees
  remove <branch-name>         Remove worktree
  prune                        Clean up stale worktrees

Environment:
  WORKTREE_BASE                Base directory for worktrees (default: ~/worktrees)

Examples:
  npx tsx worktree-manager.ts create "Add caching layer"
  npx tsx worktree-manager.ts status
  npx tsx worktree-manager.ts remove add-caching-layer --delete-branch
`);
}
