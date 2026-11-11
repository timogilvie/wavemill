#!/usr/bin/env -S npx tsx
import path from 'node:path';
import { runTool, resolvePromptPath } from '../shared/lib/tool-runner.ts';
import { getIssue, updateIssue } from '../shared/lib/linear.ts';
import {
  validateTaskPacket,
  DEFAULT_VALIDATION_CONFIG,
  type ValidationConfig,
  type ValidationResult,
} from '../shared/lib/task-packet-validator.ts';
import { getValidationConfig } from '../shared/lib/config.ts';
import { confirm } from '../shared/lib/cli-prompt.ts';
import {
  parseIssueInput,
  formatIssueContext,
  expandIssue,
  checkSubsystemDrift,
  extractAuthoredLinksFooter,
  appendAuthoredLinksFooter,
  annotateTaskSize,
} from '../shared/lib/issue-expander.ts';
import { autoLabelIssue } from '../shared/lib/issue-labeler.ts';
import { gatherCodebaseContext } from '../shared/lib/codebase-context-gatherer.ts';
import { splitTaskPacket, isValidTaskPacket, writeTaskPacketArtifacts } from '../shared/lib/task-packet-utils.ts';
import { formatValidationIssues } from '../shared/lib/validation-formatter.ts';
import { loadPromptTemplate } from '../shared/lib/prompt-utils.ts';
import { errorMessage } from '../shared/lib/error-utils.ts';
import { isInteractive } from '../shared/lib/cli-utils.ts';
import { logLinearUpdateError, logValidationWarning } from '../shared/lib/linear-update-error-log.ts';
import { formatLintResults, lintSubsystemSpecs } from '../shared/lib/context-linter.ts';
import { getCurrentOperatingMode } from '../shared/lib/operating-mode.ts';
import { shouldSplitPacket, splitPacketIntoSubPackets } from '../shared/lib/scope-shrinker.ts';

runTool({
  name: 'expand-issue',
  description: 'Expand Linear issue into comprehensive task packet',
  options: {
    'no-update': { type: 'boolean', description: 'Skip updating the Linear issue (default: always update)' },
    'skip-validation': { type: 'boolean', description: 'Skip quality gate validation' },
    output: { type: 'string', description: 'Save expanded description to file' },
    'repo-path': { type: 'string', description: 'Path to target repository' },
  },
  positional: {
    name: 'issueId',
    description: 'Linear issue ID (e.g., LIN-123) or URL',
  },
  examples: [
    'npx tsx tools/expand-issue.ts LIN-123',
    'npx tsx tools/expand-issue.ts LIN-123 --no-update',
    'npx tsx tools/expand-issue.ts LIN-123 --output expanded-issue.md',
  ],
  additionalHelp: `Environment Variables:
  LINEAR_API_KEY   Required: Linear API key
  CLAUDE_CMD       Optional: Claude CLI command (default: 'claude')`,
  async run({ args, positional }) {
    const issueInput = positional[0];
    if (!issueInput) {
      throw new Error('Issue ID is required');
    }

    if (!process.env.LINEAR_API_KEY) {
      throw new Error('LINEAR_API_KEY not found in environment');
    }

    const shouldUpdate = !args['no-update'];
    const skipValidation = !!args['skip-validation'];
    const outputFile = args.output as string | null;
    const repoPath = (args['repo-path'] as string) || process.cwd();

    // Parse and fetch issue
    console.log('Fetching issue details...');
    const identifier = parseIssueInput(issueInput);
    const issue = await getIssue(identifier);

    if (!issue) {
      throw new Error(`Issue not found: ${identifier}`);
    }

    console.log(`Found: ${issue.identifier} - ${issue.title}`);
    console.log(`Project: ${issue.project?.name || 'None'}`);
    console.log(`State: ${issue.state?.name}\n`);

    // Load issue-writer prompt
    console.log('Loading issue-writer prompt...');
    const promptPath = resolvePromptPath(import.meta.url, 'issue-writer.md');
    const promptTemplate = await loadPromptTemplate(promptPath);

    const issueDescription = issue.description || '';
    const authoredLinksFooter = extractAuthoredLinksFooter(issueDescription);

    // Format issue context without preserved authored links footer.
    const issueContext = formatIssueContext({
      ...issue,
      description: authoredLinksFooter.body,
    });
    const mode = getCurrentOperatingMode(repoPath);

    if (mode !== 'normal') {
      console.log(`⚠️  ${mode.toUpperCase()} MODE: Applying scope constraints to task packet`);
    }

    // Gather codebase context
    const codebaseContext = await gatherCodebaseContext({
      repoPath,
      issueTitle: issue.title,
      issueDescription: authoredLinksFooter.body,
    });

    // Check for subsystem drift before expansion
    await checkSubsystemDrift(repoPath, authoredLinksFooter.body);

    try {
      const lintResults = await lintSubsystemSpecs(repoPath, {
        rules: ['stale-crossref', 'contradiction'],
      });
      if (lintResults.length > 0) {
        console.log(formatLintResults(lintResults));
        console.log('');
      }
    } catch (error) {
      const message = errorMessage(error);
      console.warn(`⚠️  Spec lint failed: ${message}`);
    }

    // Expand with Claude
    console.log('Expanding issue with Claude...\n');
    console.log('─'.repeat(80));
    const expansionResult = await expandIssue({
      promptTemplate,
      issueContext,
      codebaseContext,
      mode,
      repoDir: repoPath,
      issueId: issue.identifier,
    });

    // Record the size estimate in packet §12 before split, validation and the
    // Linear update, so the picker holds an oversized task before it launches.
    console.log('Estimating task size...');
    const size = await annotateTaskSize(expansionResult.text, {
      repoDir: repoPath,
      issueId: issue.identifier,
    });
    console.log(
      `Size: ${size.estimate.addedLines === null ? 'unknown' : `~${size.estimate.addedLines}`} lines, ` +
      `${size.estimate.files.length} files` +
      (size.oversized
        ? ` — OVERSIZED (${size.verdict.reasons.join(', ')}); ${size.slices.length} slice(s) proposed`
        : ' — within limits'),
    );

    const expandedDescription = appendAuthoredLinksFooter(
      size.text,
      authoredLinksFooter.footer,
    );
    console.log('─'.repeat(80));
    console.log('\n');

    // Split into header and details
    const { header, details, fullContent } = splitTaskPacket(expandedDescription);
    console.log(`Split task packet: header (${header.length} chars), details (${details.length} chars)\n`);
    let splitSubPackets: string[] = [];

    if (shouldSplitPacket(fullContent, mode, { repoDir: repoPath })) {
      splitSubPackets = await splitPacketIntoSubPackets(fullContent, mode, {
        repoDir: repoPath,
      });

      if (splitSubPackets.length > 1) {
        console.log(`Split into ${splitSubPackets.length} sub-packets for ${mode} mode\n`);
      } else {
        console.log(`Packet remained single-file after ${mode} mode split attempt\n`);
      }
    }

    // Handle output (don't let file write failure block Linear update)
    if (outputFile) {
      try {
        const artifactPaths = await writeTaskPacketArtifacts(outputFile, {
          header,
          details,
          fullContent,
        });
        console.log(`✓ Header saved to: ${artifactPaths.header}`);
        console.log(`✓ Details saved to: ${artifactPaths.details}`);
        console.log(`✓ Full content saved to: ${artifactPaths.full}`);

        if (splitSubPackets.length > 1) {
          const parsedOutput = path.parse(outputFile);
          const basePath = path.join(parsedOutput.dir, parsedOutput.name);
          const extension = parsedOutput.ext || '.md';

          for (const [index, packet] of splitSubPackets.entries()) {
            const packetOutput = `${basePath}-${index + 1}${extension}`;
            const packetParts = splitTaskPacket(packet);
            const packetPaths = await writeTaskPacketArtifacts(packetOutput, packetParts);
            console.log(`✓ Sub-packet ${index + 1} saved to: ${packetPaths.full}`);
          }
        }

        if (expansionResult.native) {
          const { writeNativeExpansionSidecar } = await import('../shared/lib/native-expansion.ts');
          const sidecarPath = await writeNativeExpansionSidecar(outputFile, expansionResult.native);
          console.log(`✓ Native expansion metadata saved to: ${sidecarPath}`);
        }
      } catch (writeError) {
        const errorMsg = errorMessage(writeError);
        console.warn(`⚠️  Failed to write output files: ${errorMsg}`);
      }
    } else {
      console.log('Expanded Description (Header):\n');
      console.log(header);
      console.log('\n');
      console.log('(Full details available in details section)\n');
    }

    if (expansionResult.native) {
      console.log(
        `✓ Native expansion: agent=${expansionResult.native.agent} model=${expansionResult.native.model} ` +
        `cost=$${expansionResult.native.cost.toFixed(4)} denied=${expansionResult.native.deniedToolCalls.length}`
      );
    }

    // Validate output before updating Linear (use full content for validation)
    if (!isValidTaskPacket(fullContent)) {
      throw new Error(
        `Claude output is not a valid task packet (missing expected section headers).\n` +
        `  First 200 chars: ${fullContent.substring(0, 200)}\n` +
        `  Skipping Linear update to avoid overwriting with bad content.`
      );
    }

    // Run quality gate validation (unless skipped) - validate full content
    let validationResult: ValidationResult | null = null;
    if (!skipValidation) {
      console.log('\nRunning quality gate validation...');

      const configValidation = getValidationConfig();
      const validationConfig: ValidationConfig = {
        ...DEFAULT_VALIDATION_CONFIG,
        ...configValidation,
        layer1: { ...DEFAULT_VALIDATION_CONFIG.layer1, ...configValidation.layer1 },
        layer2: { ...DEFAULT_VALIDATION_CONFIG.layer2, ...configValidation.layer2 },
      };

      try {
        validationResult = await validateTaskPacket(fullContent, repoPath, validationConfig);
      } catch (validationError) {
        const errorMsg = errorMessage(validationError);
        console.warn(`\n⚠️  Validation failed with error: ${errorMsg}`);
        console.warn('   Proceeding without validation...');
      }

      if (validationResult) {
        console.log(formatValidationIssues(validationResult.issues));

        if (!validationResult.passed) {
          console.error('\n❌ Validation FAILED');

          if (shouldUpdate) {
            const interactive = isInteractive();
            let proceed = true;

            if (interactive) {
              console.log('\nThe task packet has quality issues that may cause problems for autonomous agents.');
              proceed = await confirm('Do you want to update Linear anyway?');
            } else {
              console.warn('\n⚠️  Running in non-interactive mode. Proceeding with Linear update despite validation failures.');
              console.warn('   Validation issues:');
              for (const issue of validationResult.issues) {
                console.warn(`   - [${issue.type}] ${issue.section}: ${issue.description}`);
              }
            }

            const action = proceed ? 'proceeded' : 'cancelled';
            const mode = interactive ? 'interactive' : 'non-interactive';
            const warningLogPath = logValidationWarning(
              repoPath,
              issue.identifier,
              validationResult.issues,
              mode,
              action,
            );

            if (!proceed) {
              if (warningLogPath) {
                console.warn(`⚠️  Validation cancellation logged to ${warningLogPath}`);
              }
              throw new Error('Cancelled. Fix the issues and try again.');
            }

            if (interactive) {
              console.log('⚠️  Proceeding with update despite validation failures...');
            }

            if (warningLogPath) {
              console.warn(`⚠️  Validation warning logged to ${warningLogPath}`);
            }
          } else {
            console.log('\nℹ Dry-run mode (--no-update). Remove --no-update to save to Linear.');
            console.log('  Or use --skip-validation to bypass quality gate.');
          }
        } else {
          console.log('\n✓ Validation PASSED');
        }
      }
    } else {
      console.log('\n⚠️  Skipping validation (--skip-validation flag)');
    }

    // Update Linear if requested (with full content for backward compatibility)
    if (shouldUpdate) {
      try {
        console.log(`Updating Linear issue ${issue.identifier}...`);
        const result = await updateIssue(issue.id, { description: fullContent });

        if (result.success) {
          console.log(`✓ Successfully updated: ${result.issue.url}`);

          // Auto-label the issue based on expanded content
          console.log(`\nAuto-labeling issue ${issue.identifier}...`);
          try {
            await autoLabelIssue(issue.identifier);
          } catch (error) {
            const errorMsg = errorMessage(error);
            console.warn(`⚠️  Auto-labeling failed: ${errorMsg}`);
            console.warn('   Issue was updated but labels were not applied');
          }
        } else {
          throw new Error('Failed to update issue');
        }
      } catch (error) {
        let logPath: string | null = null;

        try {
          logPath = logLinearUpdateError(repoPath, issue.identifier, error, fullContent.length);
        } catch {
          // Logging should never block task packet expansion.
        }

        const errorMsg = errorMessage(error);
        if (logPath) {
          console.warn(`⚠️  Linear update failed for ${issue.identifier}: ${errorMsg} (details logged to ${logPath})`);
        } else {
          console.warn(`⚠️  Linear update failed for ${issue.identifier}: ${errorMsg}`);
        }
        console.warn('   Continuing with local task packet...');
      }
    } else {
      console.log('ℹ Dry-run mode (--no-update). Linear was not updated.');
    }
  },
});
