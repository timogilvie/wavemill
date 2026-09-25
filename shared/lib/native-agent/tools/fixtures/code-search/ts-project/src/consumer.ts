import { calculateTotal, scaleValues } from './utils.ts';

export function scaledTotal(items: number[], factor: number): number {
  const scaled = scaleValues(items, factor);
  return calculateTotal(scaled);
}
