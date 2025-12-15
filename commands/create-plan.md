Interactive plan creation workflow that gathers context and creates a detailed implementation plan through parallel research.

## Phase 1: Context Gathering
1. Read all user-provided context files completely
2. Ask clarifying questions about requirements
3. Identify unknowns that need investigation

## Phase 2: Parallel Research
Use the **research-orchestrator** agent to coordinate investigation:
- This agent will spawn specialized research agents in parallel
- It will synthesize findings and present a unified research report
- Wait for the research report before proceeding to planning

## Phase 3: Research Synthesis
1. Review findings from all research agents
2. Identify gaps between requirements and current state
3. Document assumptions and risks
4. Confirm understanding with user before planning

## Phase 4: Plan Structure
Create a structured implementation plan with:
- **Overview**: What are we building and why
- **Current State**: What exists today (from research)
- **Proposed Changes**: What will change
- **Implementation Phases**: Break work into 3-5 phases
  - Each phase should be independently testable
  - Define clear completion criteria
  - Identify dependencies between phases
- **Success Criteria**:
  - Automated checks (tests, linting, builds)
  - Manual verification steps
- **Out of Scope**: What we're explicitly NOT doing

## Phase 5: Plan Review
1. Present plan structure to user
2. Get feedback and refine
3. Save final plan to `features/<feature-name>/plan.md`
4. Ask user to approve before proceeding to implementation

## Key Principles
- Be skeptical of requirements - ask "why" to understand true needs
- Investigate thoroughly before proposing solutions
- Work interactively - don't disappear for long periods
- Make plans specific and actionable, not vague
- Each phase should deliver value incrementally

## Output Location
Save the plan to: `features/<feature-name>/plan.md`

Next step: Use `/implement-plan` command to execute the plan with validation gates.
