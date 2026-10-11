// HOK-3151 Phase 1: factor the durable scripted-faux factory from run-arm.ts.
// Makes resume deterministic: each faux response is chosen by counting committed
// toolResult messages in the transcript, so a resumed session picks the same
// scripted step a real model would see.

import { fauxAssistantMessage, fauxProvider, fauxToolCall, fauxText } from '@earendil-works/pi-ai/providers/faux';
import type { Models } from '@earendil-works/pi-ai/models';

export interface FauxStep {
  readonly kind: 'tool' | 'text' | 'partial';
  readonly name?: string;
  readonly args?: Record<string, unknown>;
  readonly text?: string;
  readonly delayMs?: number;
}

/**
 * Create a durable scripted faux provider that keys responses by the number
 * of committed toolResult messages. This makes the "faux" model deterministic
 * across crashes: on resume, the same history → the same next response.
 */
export function createDurableFauxProvider(script: FauxStep[], modelId = 'spike') {
  const faux = fauxProvider({ provider: 'faux', models: [{ id: modelId }] });

  // Build responses: one factory per potential request
  const responses: any[] = [];
  for (let k = 0; k < script.length * 3 + 2; k += 1) {
    responses.push((context: any) => {
      const results = (context?.messages ?? []).filter(
        (m: any) => m?.role === 'toolResult',
      ).length;
      const idx = Math.min(results, script.length - 1);
      const step = script[idx];
      if (step.kind === 'tool') {
        return fauxAssistantMessage(
          fauxToolCall(step.name!, step.args as any, { id: `t${idx}-${step.name}` }),
          { stopReason: 'toolUse' },
        );
      }
      return fauxAssistantMessage([fauxText(step.text ?? 'done')], { stopReason: 'stop' });
    });
  }
  faux.setResponses(responses);

  return faux;
}

/**
 * Install a durable faux provider into a Models instance.
 */
export function installDurableFaux(models: Models, script: FauxStep[], modelId = 'spike') {
  const faux = createDurableFauxProvider(script, modelId);
  models.setProvider(faux.provider);
  return faux;
}
