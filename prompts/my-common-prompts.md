# Common Prompts for Claude Code

This file contains reusable prompts and instructions that can be imported into any project's CLAUDE.md file.

# Workflow prompt

You're an AI engineer assistant. You will help implement 
features from a Linear backlog by following a structured, automated process. The project goals and overall structure are summarized in hokusai_evaluation_pipeline.md

Perform these steps one at a time and confirm before proceeding:

# Feature Implementation Workflow

## Implementation Steps

### Step 1: Select Task
- Run the Linear backlog tool for the CURRENT REPOSITORY (check CLAUDE.md for correct project name):
  ```bash
  # For hokusai-data-pipeline repo:
  npx tsx ~/.claude/tools/get-backlog.ts "Hokusai data pipeline"
  
  # For hokusai-infrastructure repo:
  npx tsx ~/.claude/tools/get-backlog.ts "Hokusai infrastructure"
  ```
- This tool retrieves only items in "Backlog" state from Linear
- Review the output and select a task by providing its title. Number them and prompt the user to select one by choosing a number. 
- The tool will display:
  - Task title
  - Description
  - Labels
  - Current state (will always show "Backlog")

### Step 2: Create Git Branch
- When the user selects a task, sanitize the title and create a git branch:
  ```bash
  git checkout -b feature/<sanitized-title>
  ```

# After creating the branch
mkdir -p features/<feature-name>
mkdir -p project-knowledge/features

### Step 3: Generate PRD with Knowledge Management
#### 3.1: Check and Load Existing Knowledge
- Check if `project-knowledge/codebase-map.md` exists
- If it exists, read it to understand already-documented components, flows, and patterns
- This provides cumulative context from all previous feature implementations

#### 3.2: Targeted Investigation
- Use the project-investigator subagent, focusing on areas NOT already documented in codebase-map.md
- Save investigation results to `features/<feature-name>/investigation.md`
- Use the flow-mapper subagent for any undocumented flows related to this feature
- Save flow mapping to `features/<feature-name>/flow-mapping.md`

#### 3.3: Generate PRD
- Use the prompt in `prd-prompt-template.md`
- Include context from: codebase-map.md + new investigations + flow mappings
- Replace `{{PROJECT_SUMMARY}}` with the selected Linear task's title + description
- Save the AI-generated PRD to `features/<feature-name>/prd.md`

#### 3.4: Update Knowledge Base
- Extract 3-5 key discoveries from the investigation and flow mapping
- Update or create `project-knowledge/codebase-map.md` with these insights
- Keep entries concise (1-2 lines each) with references to detailed docs
- Archive full investigation docs to `project-knowledge/features/<feature-name>-<date>/`

### Step 4: Generate Tasks
- Use the prompt in `tasks-prompt-template.md` to convert `prd.md` into a list of actionable dev tasks
-act as a project manager and co-ordinate sub agents as needed to complete the tasks in their entirety ensuring all tasks completed by sub agents are tested and accepted by you. Assign each task to the subagent best suited for the task. You are responsible for the quality of what you accept
- Save these to `features/<feature-name>/tasks.md`


### Step 5: Implement with Tests First
Goal: turn the PRD tasks into working, well-guarded code while keeping feedback loops fast and human-reviewable
5.1  Generate & Review Tests before Implementation
1. Locate test-related tasks in tasks.md; tackle them first.
2. Draft the test files.
3. Human review: inspect edge-case coverage, naming, and fixture realism.
4. When approved, mark the tests read-only (e.g., git update-index --skip-worktree <test-files>).
This breaks the “same mind writes tests and code” blind spot.

5.2  Define Two Test Tiers
Fast suite (Unit/contract tests that must finish in <2s.) 
Integration suite (Slower tests hitting real DBs, services, or browsers)

5.3  Red → Green → Refactor Loop (per task)
1. Red Run the fast suite and confirm the new test fails for the intended reason.
2. Green Write only the code needed to pass the fast suite, then:
<fast-test-command>  # must be green
<lint-command>       # e.g. 'cargo clippy', 'ruff', 'golangci-lint'
<typecheck-command>  # e.g. 'tsc --noEmit', 'mypy', 'cargo check'
3. Integration guard If behaviour crosses process/IO boundaries, run the integration suite now.
4. Diff pause Show git --no-pager diff and wait for human “continue” before proceeding.
5. Refactor (Tidy First) With all tests green, remove duplication, rename for clarity, etc. Re-run lint, types, and the fast suite after each micro-refactor.

5.4  Commit Discipline
Commit when:
- Fast suite, integration suite, lint, and type-check are all green.
- The change represents one logical unit (STRUCTURE or BEHAVIOUR).
- Use clear messages, e.g.
STRUCTURE: extract EmailValidator into its own module
BEHAVIOUR: add password-reset endpoint (happy path)

5.5  Before Opening the PR
1. Un-freeze the test files (git update-index --no-skip-worktree <test-files>).
2. Ensure both test tiers pass locally and on CI.
3. Verify checklist items in “✅ Ready for Review”.
4. Proceed to Step 6 (open pull request).

### Step 6: Open Pull Request
- When `tasks.md` is complete and all tests pass:
- The GitHub tool will:
  - Commit changes with a descriptive message
  - Push the branch
  - Create a PR using the GitHub CLI
- Run:
  ```bash
  node packages/tools/github.ts
  ```

### Step 7: Ready for Review
- Confirm each of the three steps with checkboxes in the list below have been completed
- Add a checkbox next to them if completed
- Prompt the user to review the PR with the following checklist:

### ✅ Ready for Review

- [x] All tasks in `tasks.md` completed
- [x] Tests pass locally and on CI
- [x] Feature validated on Vercel preview: [preview-link]
- [x] Codebase knowledge map updated with new discoveries
- [ ] Reviewer confirmed PRD alignment

### Step 8: Post-Feature Knowledge Extraction
After PR is merged:
- Review the implemented feature for any additional patterns or insights discovered during implementation
- Update `project-knowledge/codebase-map.md` with implementation learnings
- Document any gotchas, workarounds, or important context for future features
- Keep the map concise - aim for under 200 lines total even after many features

## Error Handling

### Linear API Issues
If you encounter Linear API errors:
1. Check your Linear API key:
   - Open Linear and go to Settings > API
   - Generate a new API key if needed
   - Add it to your `.env` file as `LINEAR_API_KEY=your_key_here`
2. Verify the API key is working:
   ```bash
   # Test the Linear API connection
   node packages/tools/get-backlog.ts
   ```
3. If the tool fails, check:
   - Network connectivity
   - Linear API status page
   - Your Linear account permissions

### GitHub Operations
If GitHub operations fail:
1. Verify GitHub CLI setup:
   ```bash
   # Check if GitHub CLI is installed
   gh --version
   
   # Check if you're authenticated
   gh auth status
   ```
2. If not authenticated:
   ```bash
   # Login to GitHub CLI
   gh auth login
   ```
3. Check repository access:
   ```bash
   # Verify you can access the repository
   gh repo view
   ```
4. For uncommitted changes:
   ```bash
   # Check status of your changes
   git status
   ```

### Testing Issues
If tests fail:
1. Review the test output for specific failures
2. Verify your development environment:
   ```bash
   # Check Node version
   node --version
   
   # Verify dependencies
   npm list
   ```
3. Try cleaning and reinstalling:
   ```bash
   # Clean install dependencies
   rm -rf node_modules
   npm install
   ```

## Codebase Knowledge Map Structure

The `project-knowledge/codebase-map.md` should follow this structure:

```markdown
# Codebase Knowledge Map
_Last updated: [date]_

## Components & Services
- component-name: Brief description, key responsibilities [details: features/investigation-date.md]

## Documented Flows
- flow-name: Start → middle → end pattern [details: features/flow-date.md]

## Architecture Patterns
- Pattern description and where it's used

## Tech Stack & Conventions
- Framework/library: How it's used in this project

## External Integrations
- Service: Purpose and integration points

## Database Schema Insights
- Key tables and relationships discovered

## API Patterns
- Endpoint conventions and authentication methods

## Testing Patterns
- Test framework and organization discovered
```

## Notes
- Each step should be completed in sequence
- The codebase map is a living document that grows with each feature
- Keep map entries concise - detailed docs go in archive folders
- Document any deviations from the standard process
- Keep the PRD and tasks updated as implementation progresses
- Regular commits with clear messages are recommended
- If you need help with environment setup, refer to the project's setup documentation

__________________________________________

## KNOWLEDGE MAP UPDATE PROMPT

After completing investigation and flow mapping for a feature:

ROLE: You are a technical documentation specialist extracting key insights for future reference.

TASK: Review the investigation and flow mapping documents and extract 3-5 crucial insights that would help future developers understand this codebase better.

FORMAT:
- Each insight should be 1-2 lines maximum
- Include a reference to the detailed documentation file
- Focus on patterns, conventions, and architectural decisions
- Avoid feature-specific details unless they reveal broader patterns

EXAMPLE ENTRIES:
- auth-service: JWT with Redis sessions, 15min expiry, refresh via /api/auth/refresh [details: features/auth-flow-2024-01.md]
- All API errors use AppError class with structured logging to CloudWatch [details: features/error-handling-2024-01.md]
- Database migrations use TypeORM with naming convention: timestamp-description.ts [details: features/db-investigation-2024-02.md]

__________________________________________

## PRD-PROMPT-TEMPLATE
ROLE: 
You are a senior product manager for Hokusai and your task is to generate a PRD for a new Hokusai project. Start with the draft in the Project Summary and edit it so a relatively junior team member could identify all of the tasks and complete them. 
 
PROJECT SUMMARY: 
{{PROJECT_SUMMARY}}

OUTPUT FORMAT: 
Place the output in prd.md. Include objectives, personas, success criteria, and clearly delineated tasks. Use straightforward language. Don't include superfluous details designed for human readers like the date, the version, icons or emojis, 

PROJECT INFORMATION: 
Review the project documentation in README.md. If you have questions ask for clarification or use https://docs.hokus.ai/ for additional documentation. % 

## TASKS PROMPT TEMPLATE

ROLE: 
You are a product manager working with a junior developer. Your role is to create a detailed, prioritized list of tasks that need to be accomplished to fully acheive the objective set out in prd.md. 

OUTPUT FORMAT: 
Place the output in tasks.md. Tasks should be numbered and each task should have a checkbox next to it to reflect the status. Subtasks should use a letter designation and should have checkboxes as well. 

## Testing
7. [ ] Write and implement tests
   a. [x] Database schema tests
   b. [x] API endpoint tests
   c. [ ] Frontend component tests
   d. [ ] Integration tests
   e. [ ] End-to-end tests

REQUIRED COMPONENTS: 
1. Automated testing. Define a set of automated tests that are consistent with the existing test suite in packages/web
2. Documentation. Any technical changes and a summary of major features should be documented in README.md. 
3. Dependencies. Identify dependent tasks and ensure that these dependencies are recognized in the priorities. Note the dependency in the section header. e.g. ## Testing (Dependent on Documentation)

## Code Review Prompt

When reviewing code, please:
- Check for security vulnerabilities (SQL injection, XSS, authentication bypasses)
- Identify performance bottlenecks and suggest optimizations
- Ensure proper error handling and logging
- Verify adherence to SOLID principles
- Look for code duplication that could be refactored
- Check for proper input validation and sanitization
- Suggest improvements for readability and maintainability

## Refactoring Prompt

When refactoring code:
- Preserve all existing functionality (no breaking changes)
- Extract magic numbers and strings into named constants
- Break down functions longer than 20 lines into smaller, focused functions
- Remove dead code and commented-out blocks
- Improve variable and function names for clarity
- Add type hints/annotations where missing
- Consolidate duplicate logic into reusable functions
- Ensure consistent code style throughout

## API Documentation Prompt

When documenting APIs:
- Include clear endpoint descriptions with purpose and use cases
- Document all request parameters with types, constraints, and examples
- Show example request bodies with all possible fields
- Document all possible response codes with explanations
- Provide curl examples for each endpoint
- Include authentication requirements and headers
- Note any rate limiting or usage restrictions
- Add examples of error responses

## Test Writing Prompt

When writing tests:
- Aim for 80%+ code coverage
- Test both happy paths and edge cases
- Include tests for error conditions and exceptions
- Use descriptive test names that explain what is being tested
- Mock external dependencies appropriately
- Test boundary conditions (empty arrays, null values, max integers)
- Ensure tests are isolated and don't depend on execution order
- Add integration tests for critical user flows

## Performance Optimization Prompt

When optimizing for performance:
- Profile first to identify actual bottlenecks
- Focus on algorithmic improvements before micro-optimizations
- Consider caching strategies for expensive operations
- Optimize database queries (indexes, query structure, N+1 problems)
- Implement lazy loading where appropriate
- Use pagination for large data sets
- Consider async/parallel processing for independent operations
- Measure improvements with benchmarks
