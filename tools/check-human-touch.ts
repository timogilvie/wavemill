#!/usr/bin/env -S npx tsx
/**
 * HOK-3455 — preflight guard: one classifier for operator touches.
 */

import { runGuardCli } from './lib/source-guard.ts';
import { HUMAN_TOUCH_GUARD } from '../shared/lib/human-touch-guard.ts';

runGuardCli(HUMAN_TOUCH_GUARD, process.cwd());