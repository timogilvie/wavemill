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

---

## 6. Validation Steps

**CRITICAL**: This section must provide concrete, specific test scenarios that an autonomous agent can execute to verify their work. Generic commands like "pnpm test" are necessary but insufficient.

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

## 10. Proposed Labels

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

# APPENDIX: Validation Steps Examples

This appendix provides complete worked examples showing the difference between generic (bad) and specific (good) validation steps.

## Example 1: User Authentication Feature

### Bad (too generic)

```bash
# Test login functionality
pnpm test
# Expected: tests pass

# Verify users can log in
# Manual test: try logging in
```

**Problem**: No specific scenarios, no expected outcomes, agent can't verify if feature actually works.

---

### Good (specific scenarios)

**[REQ-F1] User can log in with valid credentials**

Validation scenario:
1. Setup: Navigate to `/login` page, ensure test user exists (email: test@example.com, password: ValidPass123)
2. Action:
   - Enter email "test@example.com" in email field
   - Enter password "ValidPass123" in password field
   - Click "Log In" button
3. Expected result:
   - User is redirected to `/dashboard` within 2 seconds
   - Welcome message displays: "Welcome back, Test User"
   - Session cookie `auth_token` is set with HttpOnly flag
   - Previous page URL is cleared from session storage
4. Edge cases:
   - Email in different case (TEST@example.com) → Should succeed (case-insensitive)
   - Trailing/leading spaces in email → Should be trimmed and succeed
   - Login immediately after signup → Should succeed without requiring email verification
   - Login from /pricing?plan=pro → Should redirect to /pricing?plan=pro after login

**[REQ-F2] User sees error with invalid credentials**

Validation scenario:
1. Setup: Navigate to `/login` page
2. Action:
   - Enter email "test@example.com"
   - Enter password "WrongPassword123"
   - Click "Log In" button
3. Expected result:
   - Error message appears above form: "Invalid email or password"
   - Error message has red background (#FEE2E2) and error icon
   - Email field value remains populated ("test@example.com")
   - Password field is cleared
   - No redirect occurs
   - Focus moves to password field
4. Edge cases:
   - Three failed attempts within 5 minutes → Show rate limit message: "Too many attempts. Try again in 15 minutes"
   - Invalid attempt with empty password → Show "Password is required" instead
   - Invalid attempt with non-existent email → Show same "Invalid email or password" (don't reveal if email exists)

**[REQ-F3] User can reset forgotten password**

Validation scenario:
1. Setup: Navigate to `/login` page, ensure test user exists
2. Action:
   - Click "Forgot password?" link
   - Enter email "test@example.com"
   - Click "Send reset link" button
3. Expected result:
   - Success message appears: "Password reset link sent to test@example.com"
   - Email is sent to test@example.com with subject "Reset your password"
   - Email contains link format: https://app.example.com/reset-password?token={uuid}
   - Token expires in 1 hour
   - User can close modal and continue to other pages
4. Edge cases:
   - Non-existent email → Show same success message (don't reveal if email exists)
   - Multiple reset requests within 5 minutes → Only send one email, show success anyway
   - Click reset link after password already changed → Show "This link has expired"

---

### Input/Output Verification

**Valid Inputs:**
- Email: "user@example.com", Password: "ValidPass123" → Login succeeds, redirect to /dashboard
- Email: "USER@EXAMPLE.COM", Password: "ValidPass123" → Login succeeds (case-insensitive email)
- Email: " user@example.com ", Password: "ValidPass123" → Login succeeds (spaces trimmed)

**Invalid Inputs:**
- Email: "notanemail", Password: "anything" → Error: "Please enter a valid email address"
- Email: "", Password: "anything" → Error: "Email is required"
- Email: "user@example.com", Password: "" → Error: "Password is required"
- Email: "user@nonexistent.com", Password: "anything" → Error: "Invalid email or password"
- Email: "user@example.com", Password: "wrong" → Error: "Invalid email or password"

---

## Example 2: Data Filtering Feature

### Bad (too generic)

```bash
# Test filtering
pnpm test

# Manual test
# - Try filtering by category
# - Verify results are correct
```

**Problem**: Doesn't specify what "correct" means, no edge cases, can't reproduce.

---

### Good (specific scenarios)

**[REQ-F1] Users can filter items by category**

Validation scenario:
1. Setup:
   - Database contains 100 items: 15 Electronics, 30 Clothing, 25 Books, 20 Home, 10 Sports
   - Navigate to `/products` page
   - Verify all 100 items are initially displayed
2. Action:
   - Locate filter sidebar on left
   - Click "Electronics" checkbox in Categories section
3. Expected result:
   - Only 15 items with category="Electronics" are visible in main area
   - Item count updates to show "15 items" at top of results
   - URL updates to `/products?category=Electronics`
   - Browser back button works to restore unfiltered view
   - "Electronics" checkbox shows as checked
   - Other category checkboxes remain unchecked
4. Edge cases:
   - Select multiple categories (Electronics + Books) → Show 40 items (union of both)
   - Deselect all categories → Show all 100 items (no filter applied)
   - Select category with 0 items (create test category "Empty") → Show message "No items found. Try different filters"
   - Apply filter, then sort by price → Filter remains applied during sort
   - Refresh page with `?category=Electronics` → Filter is applied on load

**[REQ-F2] Users can filter by price range**

Validation scenario:
1. Setup:
   - Database contains items with prices ranging from $5 to $500
   - Navigate to `/products` page
   - Note total item count (e.g., 100 items)
2. Action:
   - Locate "Price Range" slider in filter sidebar
   - Set min to $20 and max to $100
   - Release slider
3. Expected result:
   - Only items with price >= $20 AND price <= $100 are visible
   - Item count updates (e.g., "42 items")
   - URL updates to `/products?minPrice=20&maxPrice=100`
   - Slider handles show current values: "$20 - $100"
   - Price labels update below slider
4. Edge cases:
   - Set min = max ($50) → Show items exactly at $50
   - Set min > max (slider crossed) → Automatically swap values
   - Set min = $0, max = $500 (full range) → Show all items
   - Combine with category filter → Apply both filters (AND logic)
   - Items on exact boundaries ($20.00, $100.00) → Should be included

**[REQ-F3] Filters persist across page reloads**

Validation scenario:
1. Setup:
   - Navigate to `/products` page
   - Apply filters: category=Electronics, minPrice=50, maxPrice=200
   - Verify filtered results are shown (e.g., 8 items)
2. Action:
   - Press browser refresh button (Cmd+R or F5)
3. Expected result:
   - Page reloads and immediately shows same filtered results
   - URL still contains `/products?category=Electronics&minPrice=50&maxPrice=200`
   - Filter controls show correct state (Electronics checked, slider at 50-200)
   - Item count matches pre-refresh count (8 items)
4. Edge cases:
   - Copy URL and open in new tab → Filters are applied in new tab
   - Navigate away to `/about`, then back button → Filters are restored
   - Bookmark filtered URL → Opening bookmark applies filters
   - Clear browser cache and revisit URL → Filters are applied (server-side)

---

### Input/Output Verification

**Valid Inputs:**
- Category: "Electronics" → Shows 15 items with category="Electronics"
- Categories: ["Electronics", "Books"] → Shows 40 items (union)
- Price range: $20-$100 → Shows items where 20 <= price <= 100
- Combined: Category="Electronics" AND Price=$50-$150 → Shows Electronics items in that price range

**Invalid Inputs:**
- Category: "NonExistentCategory" → Shows 0 items, message "No items found"
- Price: min=$200, max=$50 (inverted) → Automatically swap to $50-$200
- Negative prices: min=$-10 → Clamp to $0
- Price above max available: max=$10000 → Show all items (no items over this price)

---

## Example 3: API Endpoint

### Bad (too generic)

```bash
# Test API
curl http://localhost:3000/api/users
# Expected: returns users
```

**Problem**: No specific request/response format, no error cases, no status codes.

---

### Good (specific scenarios)

**[REQ-F1] GET /api/users returns paginated user list**

Validation scenario:
1. Setup:
   - Database contains 50 users
   - Start dev server on port 3000
   - Obtain valid API key for testing
2. Action:
   ```bash
   curl -H "Authorization: Bearer test_api_key" \
        "http://localhost:3000/api/users?page=1&limit=10"
   ```
3. Expected result:
   - HTTP status: 200 OK
   - Response body (JSON):
     ```json
     {
       "users": [
         {"id": "usr_1", "email": "user1@example.com", "name": "User One", "createdAt": "2026-01-15T10:30:00Z"},
         ...10 users total
       ],
       "pagination": {
         "page": 1,
         "limit": 10,
         "total": 50,
         "totalPages": 5
       }
     }
     ```
   - Response headers include: `Content-Type: application/json`
   - Response time < 200ms
4. Edge cases:
   - Request page=2 → Returns users 11-20
   - Request page=99 (beyond total) → Returns empty array, pagination shows page=99, total=50
   - Request limit=100 → Clamps to max allowed (50), returns 50 users
   - Request limit=0 → Returns 400 Bad Request, error: "limit must be between 1 and 50"
   - Request without page param → Defaults to page=1
   - Database has 0 users → Returns empty array, total=0

**[REQ-F2] POST /api/users creates new user**

Validation scenario:
1. Setup: Start dev server, obtain admin API key
2. Action:
   ```bash
   curl -X POST \
        -H "Authorization: Bearer admin_api_key" \
        -H "Content-Type: application/json" \
        -d '{"email":"newuser@example.com","name":"New User","role":"member"}' \
        http://localhost:3000/api/users
   ```
3. Expected result:
   - HTTP status: 201 Created
   - Response body:
     ```json
     {
       "user": {
         "id": "usr_51",
         "email": "newuser@example.com",
         "name": "New User",
         "role": "member",
         "createdAt": "2026-02-25T14:30:00Z"
       }
     }
     ```
   - Response headers include: `Location: /api/users/usr_51`
   - Database contains new user with provided details
   - Audit log entry created for user creation
4. Edge cases:
   - Duplicate email → 409 Conflict, error: "User with this email already exists"
   - Missing required field (no email) → 400 Bad Request, error: "email is required"
   - Invalid email format → 400 Bad Request, error: "Invalid email format"
   - Name too long (>100 chars) → 400 Bad Request, error: "name must be 100 characters or less"
   - Invalid role value → 400 Bad Request, error: "role must be one of: member, admin"
   - Unauthorized (no API key) → 401 Unauthorized
   - Non-admin API key → 403 Forbidden, error: "Admin access required"

---

### Input/Output Verification

**Valid Inputs:**
- GET /api/users → 200, returns all users (paginated)
- GET /api/users?page=2&limit=20 → 200, returns page 2 with 20 users
- POST /api/users with valid data → 201, creates user, returns user object
- GET /api/users/usr_1 → 200, returns specific user

**Invalid Inputs:**
- GET /api/users without auth → 401, error: "Authorization required"
- GET /api/users?limit=notanumber → 400, error: "limit must be a number"
- POST /api/users with duplicate email → 409, error: "User with this email already exists"
- POST /api/users with invalid JSON → 400, error: "Invalid JSON in request body"
- GET /api/users/nonexistent → 404, error: "User not found"
- DELETE /api/users/usr_1 with non-admin key → 403, error: "Admin access required"

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
- [Section 10: Proposed Labels](#10-proposed-labels)

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
- Sections 8-10 (always included, but renumbered if Section 7 is omitted)

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
