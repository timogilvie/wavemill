export function calculateTotal(items: number[]): number {
  let total = 0;
  for (const item of items) {
    total += item;
  }
  return total;
}

export function scaleValues(items: number[], factor: number): number[] {
  return items.map((item) => item * factor);
}
