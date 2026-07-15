function valuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;

  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length
      && left.every((value, index) => valuesEqual(value, right[index]));
  }

  if (
    left !== null
    && right !== null
    && typeof left === 'object'
    && typeof right === 'object'
  ) {
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const leftKeys = Object.keys(leftRecord);
    const rightKeys = Object.keys(rightRecord);

    return leftKeys.length === rightKeys.length
      && leftKeys.every((key) =>
        Object.prototype.hasOwnProperty.call(rightRecord, key)
        && valuesEqual(leftRecord[key], rightRecord[key])
      );
  }

  return false;
}

export function hasUnsavedChanges<T>(current: T, saved: T | null): boolean {
  return saved !== null && !valuesEqual(current, saved);
}

