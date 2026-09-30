#!/usr/bin/env -S npx tsx

import { existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { isScriptedToolDecisionRow, purgeToolDecisionRows } from '../shared/lib/native-agent/tool-decision-corpus.ts';
import { resolveToolDecisionCorpusPath, resolveSessionEventsDir, findScriptedSessionEventStreams } from '../shared/lib/native-agent/session-stream.ts';

interface Options {
  'repo-dir': string;
  'dry-run': boolean;
  json: boolean;
}



async function main(args: string[]): Promise<void> {
  const parsed = parseArgs(args);
  const { 'repo-dir': repoDir, 'dry-run': dryRun, json } = parsed;
  
  // Validate repo directory
  if (!existsSync(repoDir)) {
    throw new Error(`Repository directory does not exist: ${repoDir}`);
  }
  
  const results = {
    corpus: { path: '', total: 0, removed: 0, kept: 0, backupPath: '' },
    sessionEvents: { moved: 0, backupDir: '' }
  };
  
  // Purge scripted rows from the tool-decision corpus
  const corpusPath = resolveToolDecisionCorpusPath({ repoDir });
  if (existsSync(corpusPath)) {
    const suffix = `hok-3121-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    const purgeResult = purgeToolDecisionRows(
      corpusPath, 
      isScriptedToolDecisionRow, 
      { dryRun, backupSuffix: suffix }
    );
    
    results.corpus = {
      path: purgeResult.path,
      total: purgeResult.total,
      removed: purgeResult.removed,
      kept: purgeResult.kept,
      backupPath: purgeResult.backupPath || ''
    };
  }
  
  // Move scripted session event streams to backup directory
  const sessionEventsDir = resolveSessionEventsDir(repoDir);
  if (existsSync(sessionEventsDir)) {
    const scriptedStreams = findScriptedSessionEventStreams(sessionEventsDir);
    
    if (scriptedStreams.length > 0 && !dryRun) {
      // Create backup directory
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupDir = join(sessionEventsDir, `.bak-hok-3121-${timestamp}`);
      mkdirSync(backupDir, { recursive: true });
      
      // Move each scripted stream to backup directory
      for (const streamPath of scriptedStreams) {
        const fileName = streamPath.split('/').pop() || '';
        const backupPath = join(backupDir, fileName);
        renameSync(streamPath, backupPath);
      }
      
      results.sessionEvents = {
        moved: scriptedStreams.length,
        backupDir
      };
    } else {
      results.sessionEvents = {
        moved: scriptedStreams.length,
        backupDir: dryRun ? '[dry-run: would create backup dir]' : ''
      };
    }
  }
  
  // Output results
  if (json) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    console.log(`Tool-decision corpus:`);
    console.log(`  Path: ${results.corpus.path}`);
    console.log(`  Total rows: ${results.corpus.total}`);
    console.log(`  Removed rows: ${results.corpus.removed}`);
    console.log(`  Kept rows: ${results.corpus.kept}`);
    if (results.corpus.backupPath) {
      console.log(`  Backup: ${results.corpus.backupPath}`);
    }
    console.log(`\nSession events:`);
    console.log(`  Scripted streams moved: ${results.sessionEvents.moved}`);
    if (results.sessionEvents.backupDir) {
      console.log(`  Backup directory: ${results.sessionEvents.backupDir}`);
    }
    if (dryRun) {
      console.log(`\n[Dry run mode - no actual changes made]`);
    }
  }
}

function parseArgs(args: string[]): Options {
  const result: Partial<Options> = {
    'repo-dir': process.cwd(),
    'dry-run': false,
    json: false
  };
  
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--repo-dir' && i + 1 < args.length) {
      result['repo-dir'] = args[++i];
    } else if (arg === '--dry-run') {
      result['dry-run'] = true;
    } else if (arg === '--json') {
      result.json = true;
    }
  }
  
  return result as Options;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

  const pr = addPrLabelDeps.getPullRequest(prNumber, { repo });
  addPrLabelDeps.log(`Found: PR #${pr.number} - ${pr.title}`);

  const existingLabels = new Set(pr.labels.map((label) => label.name));
  const normalizedLabels = labelNames
    .map((label) => label.trim())
    .filter((label, index, all) => label.length > 0 && all.indexOf(label) === index);

  if (normalizedLabels.length === 0) {
    throw new Error('At least one non-empty label name is required');
  }

  const newLabels = normalizedLabels.filter((label) => !existingLabels.has(label));

  if (newLabels.length === 0) {
    addPrLabelDeps.log(`All labels already exist on PR #${pr.number}`);
    return;
  }

  await addPrLabelDeps.addLabelsToPullRequest(pr.number, newLabels, { repo });

  addPrLabelDeps.log(`Added ${newLabels.length} label(s) to PR #${pr.number}: ${newLabels.join(', ')}`);
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);

const config = {
  name: 'add-pr-label',
  description: 'Add labels to a GitHub pull request using the REST API',
  options: {
    repo: {
      type: 'string',
      description: 'Repository in owner/repo format (defaults to current repo)',
    },
  },
  positional: {
    name: 'prNumber labels...',
    description: 'PR number and one or more label names',
    required: true,
    multiple: true,
  },
  examples: [
    'npx tsx tools/add-pr-label.ts 229 "HOK-1305"',
    'npx tsx tools/add-pr-label.ts 42 "bug" "high-priority"',
    'npx tsx tools/add-pr-label.ts 15 "feature" --repo owner/repo',
  ],
  additionalHelp: [
    'Notes:',
    '  - Uses `gh api` against the REST labels endpoint to avoid the deprecated',
    '    GraphQL path behind `gh pr edit --add-label`.',
    '  - GitHub may auto-create repository labels that do not already exist.',
  ].join('\n'),
  async run({ args, positional }) {
    const [prNumber, ...labelNames] = positional;
    await addPrLabels(prNumber, labelNames, args.repo);
  },
};

if (isMainModule) {
  runTool(config);
}
