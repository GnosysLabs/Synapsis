export interface BoundedIntegerOptions {
  defaultValue: number;
  min: number;
  max: number;
}

/**
 * Parse an integer query parameter without ever allowing invalid or negative
 * values to become an unbounded database LIMIT.
 */
export function parseBoundedInteger(
  value: string | null | undefined,
  options: BoundedIntegerOptions,
): number {
  const { defaultValue, min, max } = options;
  if (!Number.isSafeInteger(defaultValue)
    || !Number.isSafeInteger(min)
    || !Number.isSafeInteger(max)
    || min > max
    || defaultValue < min
    || defaultValue > max) {
    throw new Error('Invalid bounded integer configuration');
  }

  if (value === null || value === undefined || value.trim() === '') {
    return defaultValue;
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return defaultValue;
  return Math.min(max, Math.max(min, parsed));
}
