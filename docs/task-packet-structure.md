---
title: Task Packet Structure
---

# Task Packet Structure

When Linear issues are expanded into task packets, they use a **progressive disclosure** approach to reduce context overload:

### Two-File Format

1. **Header** (`task-packet-header.md` or loaded directly)
   - Brief overview (~50 lines)
   - Objective (2-3 sentences)
   - Top 5 key files to modify
   - Top 3 critical constraints
   - High-level success criteria
   - Links to detailed sections

2. **Details** (`task-packet-details.md`)
   - Complete 9-section specification
   - Section 1: Complete Objective & Scope
   - Section 2: Technical Context (all files, dependencies, architecture)
   - Section 3: Implementation Approach (step-by-step plan)
   - Section 4: Success Criteria (with [REQ-FX] requirement tags)
   - Section 5: Implementation Constraints (all rules)
   - Section 6: Validation Steps (concrete test scenarios)
   - Section 7: Definition of Done
   - Section 8: Rollback Plan
   - Section 9: Proposed Labels (for conflict detection)

### How Agents Use This

- **Initial context**: Agents receive the brief header (~50 lines vs ~500 lines)
- **On-demand details**: Agents read specific sections from `task-packet-details.md` as needed
- **Benefits**: Reduces initial token usage by ~90%, keeps context focused on implementation

### Backward Compatibility

- Existing full-format task packets (9 sections in one file) continue to work
- `is_task_packet()` function recognizes both old and new formats
- Linear issues always receive full content (no user-visible changes)

### For AI Agents

When you see a task packet header:
1. Start with the header to understand the objective
2. Read `task-packet-details.md` sections on-demand as you implement
3. Section 6 (Validation Steps) contains concrete test scenarios
4. Section 4 (Success Criteria) has all requirements with [REQ-FX] tags
