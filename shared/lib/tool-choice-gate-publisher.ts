/**
 * Publish the tool-choice-gate progress markdown to a Linear document (HOK-3123).
 *
 * The weekly cloud routine that posts the I-27 status update cannot see the
 * mill's local corpus. It reads the Linear document instead. This helper is
 * the write side of that contract: it locates initiative I-27, then updates
 * (or creates) a single document titled exactly `I-27 tool-choice gate
 * progress`. All content is authored by the report-only analyzer path;
 * this module owns only publishing, not analysis.
 *
 * Ambiguity — multiple initiatives matching, multiple documents with the
 * exact title — is refused rather than silently disambiguated. A stale
 * document is better than one written to the wrong initiative.
 */

import {
  createInitiativeDocument,
  getInitiativeDocuments,
  getInitiative,
  getInitiatives,
  updateDocument,
  type LinearInitiative,
  type LinearInitiativeDocument,
} from './linear.ts';

export const TOOL_CHOICE_GATE_DOCUMENT_TITLE = 'I-27 tool-choice gate progress';

/**
 * Predicate for the initiative lookup. Defaults to `name.startsWith('I-27')`.
 * The name-based lookup is deliberate: I-27 is the human-visible short
 * identifier for the initiative (see project_arbiter_program_linear.md).
 * A UUID override via env or option skips the name scan entirely.
 */
export type InitiativeMatcher = (initiative: LinearInitiative) => boolean;

export interface PublishToolChoiceGateOptions {
  /** Full markdown body to publish. `Last updated:` is prepended automatically. */
  markdown: string;
  /** Timestamp for the `Last updated:` line. Defaults to `new Date().toISOString()`. */
  now?: string;
  /**
   * Explicit initiative UUID. When set, the name-based scan is skipped. If
   * unset, `TOOL_CHOICE_GATE_INITIATIVE_ID` in the environment is honored.
   */
  initiativeId?: string;
  /**
   * Custom initiative matcher for the name-based scan. Defaults to
   * `name.startsWith('I-27')`. Only used when no explicit id is provided.
   */
  initiativeMatcher?: InitiativeMatcher;
  /** Document title on the initiative. Defaults to the constant above. */
  title?: string;
  /** Injected Linear client seams for tests. */
  deps?: Partial<PublishToolChoiceGateDeps>;
}

export interface PublishToolChoiceGateDeps {
  getInitiatives: typeof getInitiatives;
  getInitiative: typeof getInitiative;
  getInitiativeDocuments: typeof getInitiativeDocuments;
  createInitiativeDocument: typeof createInitiativeDocument;
  updateDocument: typeof updateDocument;
}

export interface PublishToolChoiceGateResult {
  documentId: string;
  documentUrl?: string;
  initiativeId: string;
  initiativeName: string;
  action: 'created' | 'updated';
  content: string;
}

function defaultDeps(): PublishToolChoiceGateDeps {
  return {
    getInitiatives,
    getInitiative,
    getInitiativeDocuments,
    createInitiativeDocument,
    updateDocument,
  };
}

function defaultMatcher(initiative: LinearInitiative): boolean {
  return typeof initiative.name === 'string' && initiative.name.startsWith('I-27');
}

function prependLastUpdated(markdown: string, now: string): string {
  const stamp = `Last updated: ${now}`;
  const trimmed = markdown.replace(/^\s+/, '');
  // If the markdown already contains a `Last updated:` line (as
  // generateReportOnlyMarkdown emits), rewrite it to guarantee a single
  // canonical timestamp instead of two competing ones.
  if (/^Last updated:.*$/m.test(trimmed)) {
    return trimmed.replace(/^Last updated:.*$/m, stamp);
  }
  return `${stamp}\n\n${trimmed}`;
}

/**
 * Find initiative I-27 and overwrite (or create) its progress document.
 *
 * Idempotent: successive calls find the same document by exact title and
 * update it in place, so the URL is stable for the weekly cloud routine.
 */
export async function publishToolChoiceGate(
  options: PublishToolChoiceGateOptions,
): Promise<PublishToolChoiceGateResult> {
  const deps = { ...defaultDeps(), ...(options.deps ?? {}) };
  const title = options.title ?? TOOL_CHOICE_GATE_DOCUMENT_TITLE;
  const now = options.now ?? new Date().toISOString();
  const content = prependLastUpdated(options.markdown, now);

  const explicitId = options.initiativeId ?? process.env.TOOL_CHOICE_GATE_INITIATIVE_ID;
  let initiative: LinearInitiative;
  if (explicitId && explicitId.trim() !== '') {
    initiative = await deps.getInitiative(explicitId.trim());
    if (!initiative || typeof initiative.id !== 'string' || initiative.id === '') {
      throw new Error(
        `publishToolChoiceGate: initiative not found for id "${explicitId}"`,
      );
    }
  } else {
    const matcher = options.initiativeMatcher ?? defaultMatcher;
    const initiatives = await deps.getInitiatives();
    const matches = initiatives.filter(matcher);
    if (matches.length === 0) {
      const preview = initiatives
        .slice(0, 5)
        .map((entry) => entry.name)
        .join(', ');
      throw new Error(
        `publishToolChoiceGate: no initiative matched the I-27 predicate (looked at ${initiatives.length}; sample names: ${preview || 'none'})`,
      );
    }
    if (matches.length > 1) {
      const detail = matches.map((entry) => `${entry.id}=${entry.name}`).join('; ');
      throw new Error(
        `publishToolChoiceGate: ambiguous initiative match — multiple candidates for I-27 (${detail}); pass initiativeId or TOOL_CHOICE_GATE_INITIATIVE_ID to disambiguate`,
      );
    }
    initiative = matches[0];
  }

  const documents = await deps.getInitiativeDocuments(initiative.id);
  const titleMatches = documents.filter((doc) => doc.title === title);
  if (titleMatches.length > 1) {
    const detail = titleMatches.map((doc) => doc.id).join(', ');
    throw new Error(
      `publishToolChoiceGate: multiple documents on initiative ${initiative.id} share the exact title "${title}" (ids: ${detail}); refusing to update — remove the duplicates and re-run`,
    );
  }

  if (titleMatches.length === 1) {
    const existing = titleMatches[0] as LinearInitiativeDocument;
    const updated = await deps.updateDocument(existing.id, { content });
    return {
      documentId: existing.id,
      documentUrl: updated.url ?? existing.url,
      initiativeId: initiative.id,
      initiativeName: initiative.name,
      action: 'updated',
      content,
    };
  }
  const created = await deps.createInitiativeDocument(initiative.id, { title, content });
  return {
    documentId: created.id,
    documentUrl: created.url,
    initiativeId: initiative.id,
    initiativeName: initiative.name,
    action: 'created',
    content,
  };
}
