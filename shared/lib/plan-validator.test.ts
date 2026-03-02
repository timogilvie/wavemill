/**
 * Tests for plan-validator.ts
 */

import { describe, test, expect } from 'vitest';
import {
  validatePlanOutput,
  priorityToNumber,
  type PlanOutput,
} from './plan-validator.ts';

describe('validatePlanOutput', () => {
  test('validates a complete valid plan', () => {
    const validPlan: PlanOutput = {
      epic_summary: 'Implement authentication system',
      milestones: [
        {
          name: 'Foundation',
          issues: [
            {
              title: 'Setup auth database',
              user_story: 'As a user, I want secure storage for credentials',
              description: 'Create users table with bcrypt hashing',
              dependencies: [],
              priority: 'P0',
            },
          ],
        },
      ],
    };

    expect(validatePlanOutput(validPlan)).toBe(true);
  });

  test('rejects null or undefined', () => {
    expect(validatePlanOutput(null)).toBe(false);
    expect(validatePlanOutput(undefined)).toBe(false);
  });

  test('rejects non-object', () => {
    expect(validatePlanOutput('string')).toBe(false);
    expect(validatePlanOutput(123)).toBe(false);
    expect(validatePlanOutput([])).toBe(false);
  });

  test('rejects missing epic_summary', () => {
    const plan = {
      milestones: [
        {
          name: 'M1',
          issues: [
            {
              title: 'T1',
              description: 'D1',
              dependencies: [],
            },
          ],
        },
      ],
    };
    expect(validatePlanOutput(plan)).toBe(false);
  });

  test('rejects non-string epic_summary', () => {
    const plan = {
      epic_summary: 123,
      milestones: [],
    };
    expect(validatePlanOutput(plan)).toBe(false);
  });

  test('rejects missing milestones', () => {
    const plan = {
      epic_summary: 'Summary',
    };
    expect(validatePlanOutput(plan)).toBe(false);
  });

  test('rejects empty milestones array', () => {
    const plan = {
      epic_summary: 'Summary',
      milestones: [],
    };
    expect(validatePlanOutput(plan)).toBe(false);
  });

  test('rejects milestone without name', () => {
    const plan = {
      epic_summary: 'Summary',
      milestones: [
        {
          issues: [
            {
              title: 'T1',
              description: 'D1',
              dependencies: [],
            },
          ],
        },
      ],
    };
    expect(validatePlanOutput(plan)).toBe(false);
  });

  test('rejects milestone without issues', () => {
    const plan = {
      epic_summary: 'Summary',
      milestones: [
        {
          name: 'M1',
        },
      ],
    };
    expect(validatePlanOutput(plan)).toBe(false);
  });

  test('rejects milestone with empty issues array', () => {
    const plan = {
      epic_summary: 'Summary',
      milestones: [
        {
          name: 'M1',
          issues: [],
        },
      ],
    };
    expect(validatePlanOutput(plan)).toBe(false);
  });

  test('rejects issue without title', () => {
    const plan = {
      epic_summary: 'Summary',
      milestones: [
        {
          name: 'M1',
          issues: [
            {
              description: 'D1',
              dependencies: [],
            },
          ],
        },
      ],
    };
    expect(validatePlanOutput(plan)).toBe(false);
  });

  test('rejects issue without description', () => {
    const plan = {
      epic_summary: 'Summary',
      milestones: [
        {
          name: 'M1',
          issues: [
            {
              title: 'T1',
              dependencies: [],
            },
          ],
        },
      ],
    };
    expect(validatePlanOutput(plan)).toBe(false);
  });

  test('rejects issue without dependencies array', () => {
    const plan = {
      epic_summary: 'Summary',
      milestones: [
        {
          name: 'M1',
          issues: [
            {
              title: 'T1',
              description: 'D1',
            },
          ],
        },
      ],
    };
    expect(validatePlanOutput(plan)).toBe(false);
  });

  test('accepts empty dependencies array', () => {
    const plan = {
      epic_summary: 'Summary',
      milestones: [
        {
          name: 'M1',
          issues: [
            {
              title: 'T1',
              description: 'D1',
              dependencies: [],
            },
          ],
        },
      ],
    };
    expect(validatePlanOutput(plan)).toBe(true);
  });

  test('accepts multiple milestones and issues', () => {
    const plan = {
      epic_summary: 'Summary',
      milestones: [
        {
          name: 'M1',
          issues: [
            {
              title: 'T1',
              description: 'D1',
              dependencies: [],
            },
            {
              title: 'T2',
              description: 'D2',
              dependencies: [0],
            },
          ],
        },
        {
          name: 'M2',
          issues: [
            {
              title: 'T3',
              description: 'D3',
              dependencies: [0, 1],
            },
          ],
        },
      ],
    };
    expect(validatePlanOutput(plan)).toBe(true);
  });
});

describe('priorityToNumber', () => {
  test('converts P0 to 1 (Urgent)', () => {
    expect(priorityToNumber('P0')).toBe(1);
  });

  test('converts P1 to 2 (High)', () => {
    expect(priorityToNumber('P1')).toBe(2);
  });

  test('converts P2 to 3 (Normal)', () => {
    expect(priorityToNumber('P2')).toBe(3);
  });

  test('converts P3 to 4 (Low)', () => {
    expect(priorityToNumber('P3')).toBe(4);
  });

  test('defaults unknown priority to 3 (Normal)', () => {
    expect(priorityToNumber('P4')).toBe(3);
    expect(priorityToNumber('Unknown')).toBe(3);
    expect(priorityToNumber('')).toBe(3);
  });

  test('is case-sensitive', () => {
    expect(priorityToNumber('p0')).toBe(3); // lowercase not recognized, defaults to Normal
  });
});
