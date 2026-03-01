import { execSync } from "node:child_process";
import { toKebabCase } from './string-utils.js';

export const sanitizeBranchName = (name, prefix = 'feature') => {
  const sanitized = toKebabCase(name, 50);
  return `${prefix}/${sanitized}`;
};

export const ensureCleanTree = () => {
  const status = execSync('git status --porcelain', { encoding: 'utf-8' }).trim();
  if (status) {
    throw new Error('Working tree is dirty. Commit or stash changes before proceeding.');
  }
};
