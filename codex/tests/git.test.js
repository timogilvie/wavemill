import assert from 'assert';
import { sanitizeBranchName } from '../../shared/lib/git.ts';

const name = 'Add User Authentication System!!! with spaces';
const branch = sanitizeBranchName(name, 'feature');
assert(branch.startsWith('feature/'), 'branch should start with prefix');
assert(branch.length <= 58, 'branch should be truncated to avoid overly long names');
assert(!branch.includes(' '), 'branch should not contain spaces');

console.log('git.test.js passed');
