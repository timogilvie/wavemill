# Issue Writer - Task Packet Template

You are expanding a brief Linear issue into a comprehensive task packet that an autonomous AI agent can execute with minimal oversight.

## UI Issue Detection

**IMPORTANT**: Before generating the task packet, determine if this is a UI-related issue.

**A UI-related issue** is one that:
- Mentions UI keywords: "UI", "frontend", "component", "page", "design", "styling", "responsive", "layout", "interface", "CSS", "Tailwind", "React", "Vue", "Svelte", "HTML"
- References UI file extensions: `.tsx`, `.jsx`, `.css`, `.scss`, `.sass`, `.less`, `.html`, `.vue`, `.svelte`
- Involves visual changes, user interface updates, or frontend work
- Touches component libraries, design systems, or styling frameworks

**If this is a UI-related issue**, you MUST include the additional UI-specific sections (Section 7) in your task packet. If not, omit Section 7 entirely and proceed directly from Section 6 to Section 8.

{{DEGRADED_MODE_CONTEXT}}

## Output Format

**IMPORTANT**: You must generate TWO documents in your response, separated by a clear marker:

1. **HEADER** (first) - A concise overview (~50 lines) for initial context
2. **DETAILS** (second) - The complete 9-section task packet for on-demand reading

Use this exact separator between them:
```
<!-- SPLIT: HEADER ABOVE, DETAILS BELOW -->
```

The HEADER should be self-contained with:
- Brief 2-3 sentence objective
- Top 5 key files
- Top 3 critical constraints
- High-level success criteria (3-5 items)
- Links to detailed sections

The DETAILS section should contain the full comprehensive specification following the structure below.

---

## Quality Requirements (CRITICAL)

Your task packet will be reviewed by an automated quality checker. To pass review, you MUST:

1. **Be specific in all acceptance criteria** — Never use vague language like "works correctly", "handles errors gracefully", "loads properly". Every criterion must specify exact inputs, exact expected outputs, and measurable outcomes.
2. **Include error handling for every external interaction** — For every API call, database query, file operation, or user input, specify what happens on failure (timeout, invalid input, missing data, unauthorized access).
3. **Avoid ungrounded assumptions** — Don't reference files, services, or patterns without verifying them in the codebase context. If you reference "the existing auth middleware", specify the exact file path.
4. **Include edge cases** — Every functional requirement needs at least 2 edge cases with specific expected behavior.
5. **No contradictions between sections** — Scope Out must not conflict with Implementation Approach; Success Criteria must align with Validation Steps.

---

## Codebase Context

You have been provided with lightweight codebase context to ground your task packet in reality. Use this information to:

1. **Reference real file paths** instead of guessing
2. **Follow existing patterns** visible in recent commits
3. **Understand the project structure** to place new files correctly
4. **Identify similar implementations** to maintain consistency

**Important**:
- If a file path exists in the context, USE IT
- If you see a pattern in recent commits, FOLLOW IT
- If the context shows conventions (from CLAUDE.md), HONOR THEM
- Only propose new files if clearly necessary; prefer editing existing files

---

## Subsystem Context

You may also be provided with relevant subsystem specifications from `.wavemill/context/`.
These specs document established patterns, constraints, and failure modes for specific
subsystems in the codebase.

**CRITICAL**: If subsystem specs are provided in the codebase context below, you MUST:

1. **Reference them in Technical Context** (Section 2)
   - List applicable subsystem specs with paths
   - Extract key architectural constraints
   - Note known failure modes to avoid

2. **Incorporate constraints into Implementation Constraints** (Section 5)
   - Copy hard rules from "Architectural Constraints" sections
   - Add constraints to appropriate categories (code style, testing, security, etc.)

3. **Include failure modes in Validation Steps** (Section 6)
   - Add test scenarios for known failure modes
   - Reference specific error conditions documented in specs

4. **Follow established patterns**
   - Use approaches documented in subsystem specs
   - Maintain consistency with existing implementations

**If NO subsystem specs are provided**, this indicates a knowledge gap:
- This may be a new subsystem or area without documentation
- After implementation, recommend running `wavemill context init --force`
- Document new patterns you establish for future reference
- This creates "persistent downstream acceleration" (per Codified Context paper, Case Study 3)

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
*Which repo(s) this work happens in. CHECK the codebase context above.*

### Key Files
*Exact file paths that will be created or modified. Use paths from the codebase context wherever possible. Use glob patterns if multiple files follow a pattern.*

**Key Files path contract**:
- Existing files must be listed as real, current paths in the repository.
- Intended new files are allowed, but must be explicitly marked immediately after the path with `(new)` or `(planned)`.
- Example: ``- `shared/lib/new-module.ts` (new) - new validator helper``

### Relevant Subsystem Specs

*If subsystem specs were provided in the codebase context above, list them here with key constraints:*

**Format** (use if subsystem specs exist):
- **{Subsystem Name}** (`.wavemill/context/{id}.md`)
  - **Key Constraints**: {1-2 critical architectural rules from spec's "Architectural Constraints"}
  - **Known Failure Modes**: {1-2 gotchas from spec's "Known Failure Modes"}
  - **Testing Patterns**: {Relevant test approach from spec, if applicable}

**If no subsystem specs were provided**, state:
> ⚠️ **Knowledge Gap**: No subsystem specs found for this area. After implementation, consider running `wavemill context init --force` to create subsystem documentation and enable persistent downstream acceleration for future tasks.

### Dependencies
*Services, APIs, packages, or other issues this depends on. Check recent git activity for clues.*

### Architecture Notes
*Relevant patterns, conventions, or architectural decisions the agent should follow. Reference existing implementations from the codebase context as examples. If subsystem specs are available, reference their architectural patterns.*

---

## 3. Implementation Approach

*Step-by-step plan. Each step should be concrete and verifiable:*

1. Step description — what to do and why
2. ...

*End this section with a single summary line estimating the size of the change:*

`Estimated added lines: <n>`

*Count the approximate net number of added lines across every file in Key Files, including tests. Use one plain integer (digits only, no range, no plus sign). This line is machine-read to hold oversized tasks before they launch; do not omit it.*

---

## 4. Success Criteria

### Functional Requirements
*Specific, testable behaviors. Each requirement should be:*
- *Clear and measurable (not vague)*
- *Independently verifiable*
- *Tagged with an identifier for traceability*

**Use format: `[REQ-F1]`, `[REQ-F2]`, etc. for easy reference in validation steps.**

- [ ] **[REQ-F1]** Criterion with measurable outcome
- [ ] **[REQ-F2]** Another specific criterion

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

**Model promotion issues**: when the issue promotes a provisional model, the constraint set must be
satisfiable with the standard tooling alone. Prescribe the full script-driven sequence:
`tools/promote-provisional-model.ts --apply` (lands the conservative pre-certification state), then
certification and Hokusai reconciliation, then `tools/promote-provisional-model.ts --activate`
(verifies the certification artifact and flips `readOnlyNative`, `certifiedAt`, `launchEligible`,
`routingEligible`, and `evidencePolicy`). Keep "manual editing of the model registry is forbidden"
as a hard rule — but never require a post-certification enablement step without also prescribing
`--activate` as the mechanism for it, since that pairing is otherwise unsatisfiable.

---

## 6. Validation Steps

**CRITICAL**: This section must provide concrete, specific test scenarios that an autonomous agent can execute to verify their work. Generic commands like "pnpm test" are necessary but insufficient.
**CRITICAL**: Use the heading label `Validation Steps` exactly (e.g. `## 6. Validation Steps`) so automated quality gates can detect this section.

**For each functional requirement**, specify:
1. **Exact user actions or API calls** to perform
2. **Specific expected outcomes** (not "should work")
3. **Edge cases and boundary conditions** to test
4. **Clear pass/fail criteria** for each scenario

**Bad example**: "Verify the form works correctly"

**Good example**:
- "Submit form with valid email 'user@example.com' → Success message appears: 'Account created'"
- "Submit form with invalid email 'notanemail' → Error appears below email field: 'Please enter a valid email address'"

Use the format `[REQ-FX]` to link each test scenario back to its corresponding functional requirement from Section 4.

---

### Functional Requirement Validation

*For each checkbox from Section 4, provide concrete test scenarios:*

**[REQ-F1] {First functional requirement text}**

Validation scenario:
1. Setup: {Describe initial state}
2. Action: {Exact steps to perform - be specific}
3. Expected result: {Specific observable outcome - what you should see/get}
4. Edge cases:
   - {Edge case 1: condition} → {Expected behavior}
   - {Edge case 2: condition} → {Expected behavior}

**[REQ-F2] {Second functional requirement text}**

Validation scenario:
1. Setup: {Describe initial state}
2. Action: {Exact steps to perform}
3. Expected result: {Specific observable outcome}
4. Edge cases:
   - {Edge case 1} → {Expected behavior}

---

### Input/Output Verification

**Valid Inputs:**
- Input: {Specific test input} → Expected: {Specific expected output}
- Input: {Another valid input} → Expected: {Expected output}

**Invalid Inputs:**
- Input: {Specific invalid input} → Expected: {Specific error message or behavior}
- Input: {Another invalid input} → Expected: {Specific error message}

---

### Standard Validation Commands

```bash
# 1. Lint passes
pnpm --filter {workspace} lint
# Expected: no errors

# 2. Type check passes
pnpm --filter {workspace} typecheck
# Expected: no type errors (if applicable)

# 3. Tests pass
pnpm --filter {workspace} test
# Expected: all tests pass

# 4. Build succeeds
pnpm build
# Expected: no build errors
```

---

### Manual Verification Checklist

- [ ] {Specific manual test 1 - what to verify and what to look for}
- [ ] {Specific manual test 2 - what to verify and what to look for}
- [ ] {Specific manual test 3 - what to verify and what to look for}

---

## 7. UI-Specific Validation (Conditional)

**IMPORTANT**: Include this section ONLY if this is a UI-related issue (see UI Issue Detection criteria above). If this is not a UI-related issue, skip this section entirely and proceed directly to Section 8 (Definition of Done).

---

### Pages/Routes Affected

*List which URLs or routes will change. Be specific about the path and what aspect changes:*

- `/route-path` - Description of what changes (e.g., "New header navigation component")
- `/another-route` - Description of change
- `/api/endpoint` (if frontend calls new API) - Purpose

If no routes are affected (e.g., component library changes), state: "N/A - Component library changes only"

---

### Visual Acceptance Criteria

*Describe what the UI should look like when done. Reference design artifacts if available:*

- [ ] **Layout**: Specific layout requirements (e.g., "Header spans full width, 64px height")
- [ ] **Colors**: Specific color usage (e.g., "Primary button uses theme.colors.primary.500")
- [ ] **Spacing**: Specific spacing requirements (e.g., "8px gap between nav items, 16px padding")
- [ ] **Typography**: Font requirements (e.g., "Headings use font-sans, 24px/32px line height")
- [ ] **Interactive States**: Hover, focus, active states (e.g., "Hover darkens background by 10%")
- [ ] **Accessibility**: ARIA labels, keyboard navigation, screen reader support

**Design Artifacts** (if available):
- Figma link: [URL if exists]
- Design guide reference: `docs/DESIGN.md` section X
- Component library: Radix UI / shadcn/ui / Material UI / etc.

---

### Console Expectations

*Expected browser console state after implementation:*

**Expected State**:
- ✅ **Clean console** - No errors, no warnings
- **OR**
- ⚠️ **Known acceptable warnings** (list them with justification):
  - `Warning: XYZ` - Reason this is acceptable (e.g., "Third-party library warning, no impact on functionality")

**Console checks to perform**:
```bash
# Use frontend-testing skill to check console:
# 1. Navigate to affected pages
# 2. List console messages
# 3. Verify no unexpected errors/warnings
```

---

### Responsive Considerations

*Specify behavior at different breakpoints. Reference your Tailwind config or design system:*

**Breakpoints** (adjust based on your design system):
- **Mobile** (`< 640px` or `sm`):
  - Behavior: (e.g., "Navigation collapses to hamburger menu")
  - Layout changes: (e.g., "Single column layout")
  - Touch targets: (e.g., "Buttons min 44px height for touch")

- **Tablet** (`640px - 1024px` or `md`):
  - Behavior: (e.g., "Navigation shows partial items with more dropdown")
  - Layout changes: (e.g., "Two-column grid")

- **Desktop** (`> 1024px` or `lg`):
  - Behavior: (e.g., "Full navigation visible")
  - Layout changes: (e.g., "Three-column grid, max-width container")

**Testing**:
- [ ] Test on mobile viewport (375px width)
- [ ] Test on tablet viewport (768px width)
- [ ] Test on desktop viewport (1440px width)
- [ ] Verify smooth transitions between breakpoints

---

## 8. Definition of Done

- [ ] All success criteria met
- [ ] All validation steps pass with specific, measurable outcomes
- [ ] Each functional requirement has at least one concrete validation scenario
- [ ] Edge cases are documented and tested
- [ ] No unrelated changes included
- [ ] Commit message references issue ID
- [ ] PR created with clear description

---

## 9. Rollback Plan

*How to safely undo these changes if something goes wrong:*
- Revert commit: `git revert <sha>`
- Feature flag: (if applicable)
- Data migration rollback: (if applicable)

---

## 10. Release Readiness

*Assess the release-readiness impact of this task. These structured fields are consumed by the automated ready-stage engine to verify implementation matches planning expectations.*

*For each field, analyze the task scope and implementation approach to determine the correct value. Do NOT default to "none" without considering the actual changes.*

- **database_change_risk**: `none` | `possible` | `required`
  - `none` — No database schema changes expected (most common)
  - `possible` — Schema changes may be needed depending on implementation approach
  - `required` — Schema migration is a known requirement
- **env_changes**: Comma-separated list of environment variable names that must be added or modified, or `none`
- **config_changes**: Comma-separated list of configuration file paths that must be modified, or `none`
- **manual_steps**: Comma-separated list of manual steps required before or after merge (e.g., run migration scripts, update DNS, invalidate caches), or `none`

**Format** (use exactly this structure):
```markdown
## Release Readiness
- **database_change_risk**: none
- **env_changes**: none
- **config_changes**: none
- **manual_steps**: none
```

---

## 11. Proposed Labels

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

---

# APPENDIX: Validation Steps — Good vs Bad

**Bad** (vague, unverifiable):
```
- [ ] User can log in
- [ ] Dashboard loads correctly
```

**Good** (specific, testable):
```
**[REQ-F1] User can log in with valid credentials**
1. Setup: Test user exists (email: test@example.com, password: ValidPass123)
2. Action: POST /api/login with {email, password}
3. Expected: 200 response with {token, userId}, redirect to /dashboard
4. Edge cases:
   - Case-insensitive email (TEST@example.com) → Should succeed
   - Wrong password → 401 "Invalid email or password"
   - 3 failed attempts → Rate limit: "Too many attempts. Try again in 15 minutes"
```

**Key pattern**: Every validation step must specify exact inputs, exact expected outputs (status codes, messages, behavior), and at least 2 edge cases.

---

# CRITICAL: Output Format

Your response MUST contain two parts in this exact order:

## Part 1: HEADER (First)

```markdown
# {Issue Title} - Quick Reference

**Issue ID**: {ISSUE_ID}

## Objective

{2-3 sentence summary covering What, Why, and high-level approach}

## Key Files

{Top 5 files that will be modified or created - actual paths from codebase context}

- `path/to/file1.ts`
- `path/to/file2.tsx`
- `path/to/file3.ts`

## Critical Constraints

{Top 3 non-negotiable rules}

1. {Constraint 1}
2. {Constraint 2}
3. {Constraint 3}

## Success Criteria (High-Level)

- [ ] {Main requirement 1}
- [ ] {Main requirement 2}
- [ ] {Main requirement 3}
- [ ] Tests and lint pass
- [ ] PR created and linked

## Detailed Sections

Full details available on-demand in task-packet-details.md:

- [Section 1: Complete Objective & Scope](#1-objective)
- [Section 2: Technical Context](#2-technical-context)
- [Section 3: Implementation Approach](#3-implementation-approach)
- [Section 4: Success Criteria](#4-success-criteria)
- [Section 5: Implementation Constraints](#5-implementation-constraints)
- [Section 6: Validation Steps](#6-validation-steps)
- [Section 7: UI-Specific Validation](#7-ui-specific-validation-conditional) *(Conditional - UI issues only)*
- [Section 8: Definition of Done](#8-definition-of-done)
- [Section 9: Rollback Plan](#9-rollback-plan)
- [Section 10: Release Readiness](#10-release-readiness)
- [Section 11: Proposed Labels](#11-proposed-labels)

**Implementation Note**: Start with this overview. Read detailed sections on-demand as you implement.
```

## Part 2: SPLIT MARKER

```
<!-- SPLIT: HEADER ABOVE, DETAILS BELOW -->
```

## Part 3: DETAILS (Full Task Packet Document)

Now output the complete detailed task packet with all sections as specified above:
- Sections 1-6 (always included)
- Section 7: UI-Specific Validation (ONLY if this is a UI-related issue)
- Sections 8-11 (always included, but renumbered if Section 7 is omitted)

Start with "## 1. Objective"

---

# Context Parameters

This prompt expects the following parameters to be substituted:

- **`{{ISSUE_CONTEXT}}`** (required) - Linear issue details formatted with title, description, labels, etc.
- **`{{CODEBASE_CONTEXT}}`** (required) - Directory structure, key files, git activity, and relevant file matches

---

{{ISSUE_CONTEXT}}

---

{{CODEBASE_CONTEXT}}
