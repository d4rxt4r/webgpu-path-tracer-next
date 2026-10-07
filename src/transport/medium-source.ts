/** Common SPPM paths replay on overflow; the precise module always retains 32. */
// Compact 2/4/8 candidates remain available for measured adapter experiments.
// Keep full capacity unless a candidate improves both control and multi-shell scenes.
export const COMMON_MEDIUM_CAPACITY = 32;
export type CommonMediumCapacity = 2 | 4 | 8 | 32;

export function mediumCapacityShader(source: string, capacity: CommonMediumCapacity): string {
  const declaration = "const MEDIUM_CAPACITY: u32 = 32u;";
  if (!source.includes(declaration)) throw new Error("Missing medium capacity declaration");
  return source.replace(declaration, `const MEDIUM_CAPACITY: u32 = ${capacity}u;`);
}
