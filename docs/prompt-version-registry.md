---
title: Prompt Version Registry
---

# Prompt Version Registry

Template usage is automatically logged to `.wavemill/evals/prompt-registry.jsonl` for GEPA training attribution. Each entry captures:

- **Template name** (e.g., "issue-writer", "eval-judge")
- **Template hash** (SHA-256) for version tracking
- **Usage timestamp** (ISO 8601 format)
- **Content snapshot** (only stored for new hash values to save space)

**Usage**: Use `loadPromptTemplate()` from `shared/lib/prompt-utils.ts` to load templates with automatic registry logging:

```typescript
import { loadPromptTemplate } from '../shared/lib/prompt-utils.ts';

// Load with automatic registry logging
const template = await loadPromptTemplate('tools/prompts/issue-writer.md');

// Opt out if needed
const template = await loadPromptTemplate(
  'tools/prompts/issue-writer.md',
  { skipRegistry: true }
);
```

**Deduplication**: The registry only stores template content once per hash. Subsequent uses of the same template version log the timestamp but not the content.

**Graceful degradation**: Registry failures don't break workflows - errors are logged as warnings and template loading continues.
