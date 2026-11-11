---
title: Install-health verdict
---

# Install-health verdict

`deps-drift.ts` - The one install-health verdict (HOK-3315): `checkDepsDrift()` compares installed packages against platform-aware lockfile expectations (npm's `os`/`cpu`/`optional`/`link` semantics), never a lockfile byte/hash compare. `deps-drift.sh` / `deps-drift-cli.ts` wrap it for shell/CLI callers; `DepsDriftDetector` derives incident identity from the mismatch set, not a poll timestamp. **Never compare lockfile bytes or hand-roll a `.packages` diff outside this file.** Enforced by `tools/check-install-verdict.ts`.
