// ---------------------------------------------------------------------------
// Native-agent Models collection (HOK-3162).
//
// Pi 1.0 moved the pre-1.0 global api-provider registry and `streamSimple`
// into the temporary `@earendil-works/pi-ai/compat` entrypoint. This module
// replaces our use of that registry with a `Models` collection built from
// Pi's provider factories (`openaiProvider()` / `openrouterProvider()`) plus
// an in-memory credential store and an injectable `AuthContext`.
//
// Production launchers build a fresh collection per run with the resolved
// api key injected into `AuthContext.env` under the canonical variable name
// each built-in factory reads (`OPENAI_API_KEY` / `OPENROUTER_API_KEY`), so
// a user's custom `apiKeyEnv` is translated at the launcher boundary. Tests
// install scripted `Provider`s on a separate scripted collection and park it
// as the module-local active collection so the loop sees it when no explicit
// `models` is passed.
// ---------------------------------------------------------------------------
import {
  createModels,
  InMemoryCredentialStore,
  type AuthContext,
  type MutableModels,
} from '@earendil-works/pi-ai';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter';

export interface CreateNativeModelsCollectionOptions {
  /**
   * Environment variables the Models' AuthContext may read from, keyed by
   * variable name. Pass the resolved api key under its canonical name
   * (`OPENAI_API_KEY` for openai, `OPENROUTER_API_KEY` for openrouter) and
   * also under the user's configured `apiKeyEnv` so both names resolve to
   * the same credential.
   */
  env?: Record<string, string | undefined>;
  /** Repo directory, reserved for future credential-store wiring. */
  repoDir?: string;
}

/**
 * Build a Models collection wired with the openai and openrouter provider
 * factories. Each provider resolves its api key through
 * `envApiKeyAuth(..., ['OPENAI_API_KEY' | 'OPENROUTER_API_KEY'])`, so the
 * injected `AuthContext.env` is the only auth input in production — no
 * stored credentials, no OAuth refresh.
 */
export function createNativeModelsCollection(
  options: CreateNativeModelsCollectionOptions = {},
): MutableModels {
  const env = options.env ?? {};
  const authContext: AuthContext = {
    async env(name) {
      const value = env[name];
      return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
    },
    async fileExists() {
      return false;
    },
  };
  const models = createModels({
    credentials: new InMemoryCredentialStore(),
    authContext,
  });
  models.setProvider(openaiProvider());
  models.setProvider(openrouterProvider());
  return models;
}

/**
 * Build an empty Models collection for scripted-provider tests. Callers
 * (tests, scripted-provider helpers) `setProvider()` their fake providers on
 * it and park it as the active collection via `setActiveNativeModels`.
 */
export function createScriptedTestModels(): MutableModels {
  const authContext: AuthContext = {
    async env() {
      return undefined;
    },
    async fileExists() {
      return false;
    },
  };
  return createModels({
    credentials: new InMemoryCredentialStore(),
    authContext,
  });
}

// ---------------------------------------------------------------------------
// Module-local active collection pointer.
//
// Pre-HOK-3162 the compat registry was effectively a process-wide global that
// the loop and the scripted-provider tests both wrote to. The Models API has
// no such global, so we keep an opt-in pointer: launchers pass their Models
// explicitly, and scripted tests install one via `setActiveNativeModels` for
// paths that still rely on the pre-HOK-3162 implicit default.
// ---------------------------------------------------------------------------

let activeNativeModels: MutableModels | undefined;

export function setActiveNativeModels(models: MutableModels): void {
  activeNativeModels = models;
}

export function getActiveNativeModels(): MutableModels | undefined {
  return activeNativeModels;
}

export function clearActiveNativeModels(): void {
  activeNativeModels = undefined;
}
