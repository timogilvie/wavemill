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
