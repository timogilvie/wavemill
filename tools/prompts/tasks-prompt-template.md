# Tasks Prompt Template

ROLE:
You are a product manager working with a junior developer. Create a detailed, prioritized task list to achieve the objective in prd.md.

OUTPUT FORMAT:
- Save to `features/<feature-name>/tasks.md`
- Number tasks with checkboxes for status
- Subtasks use letter designation with checkboxes

REQUIRED COMPONENTS:
1. **Automated testing** - Consistent with existing test suite
2. **Documentation** - Technical changes documented in README.md
3. **Dependencies** - Note in section headers (e.g., "## Testing (Depends on Documentation)")

EXAMPLE:
```
## 1. Database Schema
- [x] a. Create migration file
- [x] b. Add indexes
- [ ] c. Update models

## 2. API Endpoints (Depends on Database Schema)
- [ ] a. Create route handlers
- [ ] b. Add validation
```
