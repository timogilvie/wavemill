// Models
// pi-ai 1.0.4 createModels() + openrouter/openai providers

import { createModels, openrouterProvider, openaiProvider } from '@earendil-works/pi-ai/models';

/**
 * Create models collection for the spike
 * Uses pi-ai 1.0.4 with openrouter and openai providers
 */
export function createSpikeModels() {
  return createModels({
    providers: {
      openrouter: openrouterProvider({
        apiKey: process.env.OPENROUTER_API_KEY
      }),
      openai: openaiProvider({
        apiKey: process.env.OPENAI_API_KEY
      })
    }
  });
}

/**
 * Get a certified coding model for testing
 * In practice, this would enumerate models from the certification store
 */
export function getCodingTestModel(): string {
  // Return a cheap, currently-certified OpenRouter coding model
  // For now, return a placeholder
  return 'openrouter:anthropic/claude-3-haiku';
}
