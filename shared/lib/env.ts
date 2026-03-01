/**
 * Centralized environment variable loader.
 *
 * Loads dotenv configuration once when imported, making environment
 * variables available throughout the application.
 *
 * Usage:
 *   import '../shared/lib/env.js';
 *   // Environment variables are now loaded
 *
 * @module env
 */

import dotenv from 'dotenv';

// Load environment variables once
dotenv.config({ quiet: true });

/**
 * Get a required environment variable, throwing if not set.
 */
export function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Required environment variable ${key} not set`);
  }
  return value;
}

/**
 * Get an optional environment variable with a default value.
 */
export function getEnv(key: string, defaultValue: string = ''): string {
  return process.env[key] || defaultValue;
}
