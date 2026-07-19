/**
 * Client-side dynamic route params can retain percent encoding. Normalize a
 * segment once at the page boundary so callers can safely encode it when
 * constructing their next URL without turning `%40` into `%2540`.
 */
export function decodeDynamicRouteSegment(value: string | null | undefined): string {
  if (!value) return '';

  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
