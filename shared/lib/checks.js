import { execSync } from "node:child_process";

/**
 * Runs the build check command from config.
 *
 * @param {Object} config - Configuration object with checks section
 * @param {Object} config.checks - Checks configuration
 * @param {string} config.checks.build - Build command to execute
 * @param {boolean} [config.checks.requireBuildBeforePR=true] - Whether to enforce build check
 * @returns {Object} Result object with success status and optional error
 * @throws {Error} If build fails and requireBuildBeforePR is true
 */
export const runBuildCheck = (config) => {
  // Check if build check is required (defaults to true)
  const requireBuild = config?.checks?.requireBuildBeforePR !== false;

  if (!requireBuild) {
    return { success: true, skipped: true, reason: 'requireBuildBeforePR is disabled' };
  }

  const buildCommand = config?.checks?.build;

  // If no build command configured, warn but don't block (backwards compatibility)
  if (!buildCommand) {
    console.warn('⚠️  No build command configured in checks.build. Skipping build check.');
    return { success: true, skipped: true, reason: 'No build command configured' };
  }

  try {
    console.log(`Running build check: ${buildCommand}`);
    execSync(buildCommand, {
      stdio: 'inherit',
      encoding: 'utf-8'
    });
    console.log('✓ Build check passed');
    return { success: true, skipped: false };
  } catch (error) {
    const errorMessage = `Build check failed. Cannot create PR until build passes.

Command: ${buildCommand}
Exit code: ${error.status || 'unknown'}

To bypass this check, set "requireBuildBeforePR": false in your config.

Error output:
${error.message}`;

    throw new Error(errorMessage);
  }
};
