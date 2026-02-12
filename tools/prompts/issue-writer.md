# Issue Writer - Task Packet Template

You are expanding a brief Linear issue into a comprehensive task packet that an autonomous AI agent can execute with minimal oversight.

Given the issue details below, produce a detailed task specification following this exact structure. Be specific, measurable, and actionable throughout.

---

## 1. Objective

### What
*Clear, single-sentence statement of what needs to be built or fixed.*

### Why
*Business or technical motivation. What problem does this solve? What value does it deliver?*

### Scope In
*Bullet list of what IS included in this task.*

### Scope Out
*Bullet list of what is explicitly NOT part of this task (to prevent scope creep).*

---

## 2. Technical Context

### Repository
*Which repo(s) this work happens in.*

### Key Files
*Exact file paths that will be created or modified. Use glob patterns if multiple files follow a pattern.*

### Dependencies
*Services, APIs, packages, or other issues this depends on.*

### Architecture Notes
*Relevant patterns, conventions, or architectural decisions the agent should follow. Reference existing implementations as examples.*

---

## 3. Implementation Approach

*Step-by-step plan. Each step should be concrete and verifiable:*

1. Step description — what to do and why
2. ...

---

## 4. Success Criteria

### Functional Requirements
*Specific, testable behaviors (not vague):*
- [ ] Criterion with measurable outcome

### Non-Functional Requirements
*Performance, accessibility, security constraints:*
- [ ] Criterion with specific threshold

### Code Quality
- [ ] Follows existing codebase patterns
- [ ] TypeScript types are correct (no `any` unless justified)
- [ ] No lint errors

---

## 5. Implementation Constraints

*Hard rules the agent must follow:*
- Code style: ...
- Testing: ...
- Security: ...
- Performance: ...
- Backwards compatibility: ...

---

## 6. Validation Steps

*Exact commands to run and their expected output:*

```bash
# 1. Lint passes
pnpm --filter @hokusai-protocol/web lint
# Expected: no errors

# 2. Tests pass
pnpm --filter @hokusai-protocol/web test
# Expected: all tests pass

# 3. Build succeeds
pnpm build
# Expected: no build errors

# 4. Feature-specific validation
# ...
```

---

## 7. Definition of Done

- [ ] All success criteria met
- [ ] All validation steps pass
- [ ] No unrelated changes included
- [ ] Commit message references issue ID
- [ ] PR created with clear description

---

## 8. Rollback Plan

*How to safely undo these changes if something goes wrong:*
- Revert commit: `git revert <sha>`
- Feature flag: (if applicable)
- Data migration rollback: (if applicable)

---

## 9. Proposed Labels

*Based on the analysis above, suggest labels to help the autonomous workflow identify task conflicts and parallelization opportunities:*

**Risk Level** (Required):
- `Risk: Low` — Simple, isolated changes (CSS tweaks, text updates, documentation)
- `Risk: Medium` — New features, refactoring, non-breaking changes (default for most tasks)
- `Risk: High` — Breaking changes, database migrations, authentication, infrastructure changes

**Selected**: `Risk: [Low/Medium/High]`

**Justification**: *Brief explanation of why this risk level was chosen (e.g., "Medium - New feature with state management but no breaking changes")*

---

**Files to Modify** (Auto-detected):
*List the key files from section 2 (limit to top 5):*
- `path/to/file1.ts`
- `path/to/file2.tsx`
- `path/to/file3.css`

**Label**: `Files: file1.ts, file2.tsx, file3.css`

**Purpose**: Prevents parallel tasks from modifying the same files

---

**Architectural Layer** (Recommended):
*Based on the files and implementation approach, which layers are affected:*
- `Layer: UI` — Frontend components (`.tsx`, `.jsx`, `components/`)
- `Layer: API` — API routes and endpoints (`/api/`, `routes/`)
- `Layer: Service` — Business logic, utilities (`services/`, `lib/`)
- `Layer: Database` — Schema, migrations (`schema.prisma`, `migrations/`)
- `Layer: Infra` — Configuration, deployment (`Dockerfile`, `.github/`)

**Selected**: `Layer: [UI/API/Service/Database/Infra]`

**Purpose**: Tasks from different layers can run in parallel safely

---

**Area** (Recommended):
*Product area affected (helps avoid conflicts). Use Layer labels for architectural layers like API, Database, Infra:*
- `Area: Landing` — Landing page and homepage
- `Area: Navigation` — Navigation and routing
- `Area: Auth` — Authentication and authorization
- `Area: Docs` — Documentation

**Selected**: `Area: [...]`

**Purpose**: Avoid running 2+ tasks affecting the same product area

---

**Test Coverage** (Auto-detected):
*From section 6 (Validation Steps):*
- `Tests: E2E` — End-to-end tests (Playwright, Cypress)
- `Tests: Integration` — Integration tests
- `Tests: Unit` — Unit tests (Jest, Vitest)
- `Tests: None` — No tests required

**Selected**: `Tests: [E2E/Integration/Unit/None]`

**Purpose**: Avoid running multiple E2E tasks (slow and flaky)

---

**Component** (Optional):
*If modifying a specific component, auto-detect from file paths:*
- `Component: Hero` (from `components/Hero.tsx`)
- `Component: UserMenu` (from `components/UserMenu.tsx`)

**Selected**: `Component: [...]` (if applicable)

**Purpose**: Avoid running 2+ tasks modifying the same component

---

### Label Summary

```
Suggested labels for this task:
- Risk: Medium
- Files: src/components/Hero.tsx, src/hooks/useTheme.ts
- Layer: UI
- Area: Landing
- Tests: Unit
- Component: Hero
```

**How these labels help the autonomous workflow:**
- **Risk: Medium** — Max 2 Medium risk tasks can run in parallel
- **Files: ...** — Prevents file conflicts with other tasks
- **Layer: UI** — Can run in parallel with Service/API/Database tasks
- **Area: Landing** — Prevents conflicts with other Landing tasks
- **Tests: Unit** — Can run in parallel with other Unit test tasks
- **Component: Hero** — Prevents conflicts with other Hero component tasks
