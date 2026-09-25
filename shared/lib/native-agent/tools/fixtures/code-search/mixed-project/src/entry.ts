export function greeting(name: string): string {
  return `hello, ${name}`;
}

export function greetAll(names: string[]): string[] {
  return names.map((name) => greeting(name));
}
