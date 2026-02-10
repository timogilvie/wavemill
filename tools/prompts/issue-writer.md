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
