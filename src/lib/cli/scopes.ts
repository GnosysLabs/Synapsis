export const CLI_SCOPES = ['posts:write', 'media:write'] as const;

export type CliScope = typeof CLI_SCOPES[number];

export function isCliScope(value: unknown): value is CliScope {
  return typeof value === 'string' && (CLI_SCOPES as readonly string[]).includes(value);
}

export function parseCliScopes(value: string): CliScope[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter(isCliScope) : [];
  } catch {
    return [];
  }
}

export function serializeCliScopes(scopes: readonly CliScope[]): string {
  const requested = new Set(scopes);
  return JSON.stringify(CLI_SCOPES.filter(scope => requested.has(scope)));
}
