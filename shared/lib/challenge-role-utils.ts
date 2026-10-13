import { challengerTaskKey } from './task-identity.ts';

export type EffectiveChallengeRole = 'primary' | 'challenger';

export function asEffectiveChallengeRole(value: unknown): EffectiveChallengeRole | null {
  return value === 'primary' || value === 'challenger' ? value : null;
}

export function challengeTaskKeyVariants(pairId: string, role: EffectiveChallengeRole): string[] {
  const normalized = pairId.replace(/-/g, '_');
  const pairIds = Array.from(new Set([pairId, normalized]));
  if (role === 'primary') {
    return pairIds;
  }
  return pairIds.flatMap((id) => [challengerTaskKey(id), `${id}-challenger`]);
}

export function resolveEffectiveChallengeRole(
  issueId: string,
  pairId: string,
  raw: unknown,
): EffectiveChallengeRole | null {
  const explicit = asEffectiveChallengeRole(raw);
  if (explicit) return explicit;

  if (challengeTaskKeyVariants(pairId, 'primary').includes(issueId)) {
    return 'primary';
  }
  if (challengeTaskKeyVariants(pairId, 'challenger').includes(issueId) || issueId.endsWith('-challenger')) {
    return 'challenger';
  }
  return null;
}
