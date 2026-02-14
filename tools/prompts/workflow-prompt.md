You're an AI engineer assistant. You will help implement 
features from a Linear backlog by following a structured, automated process. The project goals and overall structure are summarized in hokusai_evaluation_pipeline.md

Perform these steps one at a time and confirm before proceeding:

# Feature Implementation Workflow

## Implementation Steps

### Step 1: Select Task
- Run the Linear backlog tool:
  ```bash
  npx tsx tools/get-backlog.ts
  ```
- Review the output and select a task by providing its title. Number them and prompt the user to select one by choosing a number. s
- The tool will display:
  - Task title
  - Description
  - Labels
  - Current state

### Step 2: Create Git Branch
- When the user selects a task, sanitize the title and create a git branch:
  ```bash
  git checkout -b feature/<sanitized-title>
  ```
-Create a feature directory to contain all related documents:

# After creating the branch
mkdir -p features/<feature-name>

### Step 3: Generate PRD
- Use the prompt in `prd-prompt-template.md`
- Replace `{{PROJECT_SUMMARY}}` with the selected Linear task's title + description
- Save the AI-generated PRD to `features/<feature-name>/prd.md`

### Step 4: Generate Tasks
- Use the prompt in `tasks-prompt-template.md` to convert `prd.md` into a list of actionable dev tasks
-act as a project manager and co-ordinate sub agents as needed to complete the tasks in their entirety ensuring all tasks completed by sub agents are tested and accepted by you. You are responsible for the quality of what you accept
- Save these to `features/<feature-name>/tasks.md`

### Step 5: Implement with Tests First
- Find any tasks related to writing tests and implement those first
- Confirm that the tests fail, then implement the remaining tasks to make them pass
- Iterate until all tests pass

### Step 6: Open Pull Request
- When `tasks.md` is complete and all tests pass:
- The GitHub tool will:
  - Commit changes with a descriptive message
  - Push the branch
  - Create a PR using the GitHub CLI. Check for merge conflicts and resolve them. 
- Run:
  ```bash
  gh pr create --fill
  ```

### Step 7: Ready for Review
- Confirm each of the three steps with checkboxes in the list below have been completed
- Add a checkbox next to them if completed
- Prompt the user to review the PR with the following checklist:

### ✅ Ready for Review

- [x] All tasks in `tasks.md` completed
- [x] Tests pass locally and on CI
- [x] Feature validated on Vercel preview: [preview-link]
- [ ] Reviewer confirmed PRD alignment

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

## Notes
- Each step should be completed in sequence
- Document any deviations from the standard process
- Keep the PRD and tasks updated as implementation progresses
- Regular commits with clear messages are recommended
- If you need help with environment setup, refer to the project's setup documentation
