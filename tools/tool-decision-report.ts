#!/usr/bin/env -S npx tsx

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  resolveToolDecisionCorpusPath,
} from '../shared/lib/native-agent/tool-decision-corpus.ts';
import {
  formatCorpusReport,
  reportToolDecisionCorpusFile,
} from '../shared/lib/native-agent/tool-decision-report.ts';
import { runTool } from '../shared/lib/tool-runner.ts';

runTool({
  name: 'tool-decision-report',
  description: 'Report corpus-quality counters for a tool-decision corpus JSONL',
  options: {
    corpus: {
      type: 'string',
      description: 'Path to a corpus.jsonl file (default: .wavemill/tool-decisions/corpus.jsonl)',
    },
    'corpus-dir': {
      type: 'string',
      description: 'Directory holding the corpus (used when --corpus is not set)',
    },
    namespace: {
      type: 'string',
      description: 'Corpus namespace filename stem (default: corpus)',
      default: 'corpus',
    },
    'known-models': {
      type: 'string',
      description: 'Comma-separated allowlist of known model identifiers',
    },
    'known-tools': {
      type: 'string',
      description: 'Comma-separated allowlist of known tool names',
    },
    json: {
      type: 'boolean',
      description: 'Emit JSON instead of the human-readable summary',
    },
  },
  examples: [
    'npx tsx tools/tool-decision-report.ts',
    'npx tsx tools/tool-decision-report.ts --corpus .wavemill/tool-decisions/corpus.jsonl',
    'npx tsx tools/tool-decision-report.ts --known-models anthropic/claude-3-5-sonnet --known-tools read,edit,bash',
  ],
  run({ args }) {
    const repoDir = resolve('.');
    const path = args.corpus
      ? resolve(String(args.corpus))
      : resolveToolDecisionCorpusPath({
          repoDir,
          ...(args['corpus-dir'] ? { explicitDir: String(args['corpus-dir']) } : {}),
          namespace: String(args.namespace ?? 'corpus'),
        });
    const knownModels = args['known-models']
      ? String(args['known-models']).split(',').map((s) => s.trim()).filter(Boolean)
      : undefined;
    const knownTools = args['known-tools']
      ? String(args['known-tools']).split(',').map((s) => s.trim()).filter(Boolean)
      : undefined;

    if (!existsSync(path)) {
      const empty = reportToolDecisionCorpusFile(path);
      if (args.json === true) console.log(JSON.stringify(empty, null, 2));
      else console.log(formatCorpusReport(empty));
      return;
    }
    const report = reportToolDecisionCorpusFile(path, {
      ...(knownModels ? { knownModels } : {}),
      ...(knownTools ? { knownTools } : {}),
    });
    if (args.json === true) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(formatCorpusReport(report));
    }
  },
});
