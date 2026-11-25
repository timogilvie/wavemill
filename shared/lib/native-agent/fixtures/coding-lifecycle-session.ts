import type { ScriptedPiProviderTurn } from '../provider.ts';
import { serializeCodingComplete, type CodingArtifacts } from '../coding-artifacts.ts';

const USAGE_TURN_1 = {
  input: 1800,
  output: 80,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 1880,
  cost: { input: 0.0018, output: 0.0008, cacheRead: 0, cacheWrite: 0, total: 0.0026 },
};

const USAGE_TURN_2 = {
  input: 1900,
  output: 70,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 1970,
  cost: { input: 0.0019, output: 0.0007, cacheRead: 0, cacheWrite: 0, total: 0.0026 },
};

const USAGE_TURN_3 = {
  input: 2000,
  output: 90,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2090,
  cost: { input: 0.002, output: 0.0009, cacheRead: 0, cacheWrite: 0, total: 0.0029 },
};

const USAGE_TURN_4 = {
  input: 1700,
  output: 50,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 1750,
  cost: { input: 0.0017, output: 0.0005, cacheRead: 0, cacheWrite: 0, total: 0.0022 },
};

const USAGE_TURN_5 = {
  input: 1750,
  output: 60,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 1810,
  cost: { input: 0.00175, output: 0.0006, cacheRead: 0, cacheWrite: 0, total: 0.00235 },
};

const USAGE_TURN_6 = {
  input: 1650,
  output: 40,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 1690,
  cost: { input: 0.00165, output: 0.0004, cacheRead: 0, cacheWrite: 0, total: 0.00205 },
};

export const CODING_FIXTURE_FEATURE_SLUG = 'native-patch-coding-smoke';
export const CODING_FIXTURE_SOURCE_PATH = 'src/app.ts';
export const CODING_FIXTURE_MARKER_PATH = `features/${CODING_FIXTURE_FEATURE_SLUG}/.coding-complete`;
export const CODING_FIXTURE_RESULT_PATH = `features/${CODING_FIXTURE_FEATURE_SLUG}/.coding-result.json`;
export const CODING_FIXTURE_INITIAL_SOURCE = "export const message = 'before';\n";
export const CODING_FIXTURE_FINAL_SOURCE = "export const message = 'after';\n";

export const CODING_FIXTURE_ARTIFACTS: CodingArtifacts = {
  type: 'coding',
  filesChanged: 1,
  linesAdded: 1,
  linesRemoved: 1,
  commitCount: 0,
};

export const CODING_FIXTURE_MARKER_CONTENT = serializeCodingComplete({
  stage: 'coding',
  confidence: 'high',
  producer: 'native-agent',
});

export const codingLifecycleSessionTurns: ScriptedPiProviderTurn[] = [
  {
    content: [{
      type: 'tool_call',
      id: 'coding-read-1',
      name: 'read_file',
      arguments: { path: CODING_FIXTURE_SOURCE_PATH },
    }],
    usage: USAGE_TURN_1,
    stopReason: 'toolUse',
  },
  {
    content: [{
      type: 'tool_call',
      id: 'coding-patch-stale-1',
      name: 'apply_patch',
      arguments: {
        patch: {
          version: 1,
          atomic: true,
          operations: [{
            op: 'edit',
            path: CODING_FIXTURE_SOURCE_PATH,
            oldText: "export const message = 'stale';\n",
            newText: CODING_FIXTURE_FINAL_SOURCE,
          }],
        },
      },
    }],
    usage: USAGE_TURN_2,
    stopReason: 'toolUse',
  },
  {
    content: [{
      type: 'tool_call',
      id: 'coding-patch-fix-1',
      name: 'apply_patch',
      arguments: {
        patch: {
          version: 1,
          atomic: true,
          operations: [{
            op: 'edit',
            path: CODING_FIXTURE_SOURCE_PATH,
            oldText: CODING_FIXTURE_INITIAL_SOURCE,
            newText: CODING_FIXTURE_FINAL_SOURCE,
          }],
        },
      },
    }],
    usage: USAGE_TURN_3,
    stopReason: 'toolUse',
  },
  // HOK-3514: commit before the marker; .coding-complete is refused on a dirty tree.
  {
    content: [{ type: 'tool_call', id: 'coding-add-1', name: 'git_add', arguments: { paths: [CODING_FIXTURE_SOURCE_PATH] } }],
    usage: USAGE_TURN_3,
    stopReason: 'toolUse',
  },
  {
    content: [{ type: 'tool_call', id: 'coding-commit-1', name: 'git_commit', arguments: { message: 'feat: update message' } }],
    usage: USAGE_TURN_3,
    stopReason: 'toolUse',
  },
  {
    content: [{
      type: 'tool_call',
      id: 'coding-marker-1',
      name: 'create_marker',
      arguments: {
        path: CODING_FIXTURE_MARKER_PATH,
        content: CODING_FIXTURE_MARKER_CONTENT,
      },
    }],
    usage: USAGE_TURN_4,
    stopReason: 'toolUse',
  },
  {
    content: [{
      type: 'tool_call',
      id: 'coding-artifact-1',
      name: 'write_artifact',
      arguments: {
        path: CODING_FIXTURE_RESULT_PATH,
        content: `${JSON.stringify(CODING_FIXTURE_ARTIFACTS, null, 2)}\n`,
      },
    }],
    usage: USAGE_TURN_5,
    stopReason: 'toolUse',
  },
  {
    content: [{ type: 'text', text: 'Coding complete. Patch applied and completion artifacts written.' }],
    usage: USAGE_TURN_6,
    stopReason: 'stop',
  },
];
