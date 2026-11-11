---
title: Config Loading
---

# Config Loading

TypeScript modules use `shared/lib/config.ts` for centralized config loading:

```typescript
import { loadWavemillConfig } from './config.ts';

// Load and validate config (cached per repo directory)
const config = loadWavemillConfig(repoDir);
console.log(config.router?.enabled); // typed access

// Or use typed accessors for specific sections
import { getRouterConfig, getEvalConfig } from './config.ts';
const routerConfig = getRouterConfig(repoDir);
const evalConfig = getEvalConfig(repoDir);
```

**Key features:**
- Configs are cached per-process (singleton per repoDir)
- Validated against `wavemill-config.schema.json` at load time
- All fields are optional (graceful degradation)
- Use `clearConfigCache(repoDir)` to force reload in tests
- Config ownership and precedence reference: `docs/config-files.md`

**Implementation:**
- Replaces ~7 independent `readFileSync` + `JSON.parse` blocks
- Uses Ajv for schema validation
- Provides TypeScript types matching the schema
