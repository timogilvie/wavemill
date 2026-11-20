// allow-completion-gate: this is the invariant definition.
/**
 * Invariant (HOK-3514): native coding has one completion decision. Every
 * `.coding-complete` the native harness writes goes through
 * `executeWholeFileWrite` in `native-agent/tools/mutation-tools.ts`, which
 * calls `evaluateCodingCompletionGate` before the marker lands. A second
 * `create_marker` / `write_artifact` tool, or a whole-file write path that
 * drops the gate call, would let a coder finish on a dirty tree again.
 * See docs/invariants/completion-gate.md.
 */
import type { GuardSpec, StructuralMatch } from '../../tools/lib/source-guard.ts';

const MUTATION_TOOLS = 'shared/lib/native-agent/tools/mutation-tools.ts';
const MARKER_TOOL_DESCRIPTOR = /metadata:\s*\{\s*name:\s*['"](create_marker|write_artifact)['"]/g;

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

/** The body of a top-level function: from its declaration to the next top-level declaration. */
function functionBody(source: string, name: string): { start: number; body: string } | null {
  const declaration = new RegExp(`^(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\b`, 'm').exec(source);
  if (!declaration) return null;
  const rest = source.slice(declaration.index + declaration[0].length);
  const next = /^(?:export\s+)?(?:async\s+)?(?:function|const|interface|type)\s/m.exec(rest);
  return { start: declaration.index, body: next ? rest.slice(0, next.index) : rest };
}

function findGateBypass(source: string): StructuralMatch[] {
  const writer = functionBody(source, 'executeWholeFileWrite');
  if (!writer) {
    return [{ line: 1, detail: 'executeWholeFileWrite is missing; the marker write path must stay in mutation-tools.ts' }];
  }
  const reachesGate = /\bevaluateCodingCompletionGate\s*\(/.test(writer.body)
    || (/\bcodingCompleteGateRefusal\s*\(/.test(writer.body)
      && /\bevaluateCodingCompletionGate\s*\(/.test(functionBody(source, 'codingCompleteGateRefusal')?.body ?? ''));
  return reachesGate
    ? []
    : [{ line: lineOf(source, writer.start), detail: 'executeWholeFileWrite does not call evaluateCodingCompletionGate' }];
}

function findSecondMarkerTool(source: string, file: string): StructuralMatch[] {
  if (file === MUTATION_TOOLS) return [];
  return [...source.matchAll(MARKER_TOOL_DESCRIPTOR)].map((match) => ({
    line: lineOf(source, match.index ?? 0),
    detail: `second ${match[1]} tool`,
  }));
}

export const COMPLETION_GATE_GUARD: GuardSpec = {
  name: 'completion-gate',
  findingNoun: 'native completion-marker path(s) that bypass the completion gate',
  invariantDocs: ['docs/invariants/completion-gate.md'],
  suppressionMarker: 'allow-completion-gate',
  allowlistFile: 'tools/completion-gate-allowlist.txt',
  invariantPaths: [
    'shared/lib/completion-gate-guard.ts',
    'tools/check-completion-gate.ts', // install-paths: allow invariantPaths list, not an argv target
  ],
  patterns: [],
  structuralChecks: [
    {
      name: 'marker-write-bypasses-gate',
      description: 'the native whole-file write path must call evaluateCodingCompletionGate before writing .coding-complete',
      paths: [MUTATION_TOOLS],
      find: (source) => findGateBypass(source),
    },
    {
      name: 'second-marker-tool',
      description: 'create_marker / write_artifact are defined once, in native-agent/tools/mutation-tools.ts, behind the completion gate',
      scopedPaths: ['shared/lib/', 'tools/'],
      find: (source, file) => findSecondMarkerTool(source, file),
    },
  ],
  remediation: [
    'HOK-3514: native coding has one completion decision. Write markers through createCodingMutationTools',
    '(mutation-tools.ts executeWholeFileWrite), which refuses .coding-complete while task paths are dirty;',
    'never add a second marker tool or drop the evaluateCodingCompletionGate call.',
  ],
};
