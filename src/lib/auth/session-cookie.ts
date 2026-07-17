export function resolveSessionTokens(
  activeToken: string | null,
  listedTokens: string[],
): string[] {
  if (!activeToken || listedTokens.includes(activeToken)) return listedTokens;
  return [activeToken, ...listedTokens];
}
