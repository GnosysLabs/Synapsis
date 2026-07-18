import { describe, expect, it } from 'vitest';
import { parseBoundedInteger } from './query';

const options = { defaultValue: 20, min: 1, max: 50 };

describe('parseBoundedInteger', () => {
  it('accepts and clamps safe integers', () => {
    expect(parseBoundedInteger('25', options)).toBe(25);
    expect(parseBoundedInteger('-1', options)).toBe(1);
    expect(parseBoundedInteger('500', options)).toBe(50);
  });

  it('uses the bounded default for malformed values', () => {
    expect(parseBoundedInteger(null, options)).toBe(20);
    expect(parseBoundedInteger('10junk', options)).toBe(20);
    expect(parseBoundedInteger('NaN', options)).toBe(20);
    expect(parseBoundedInteger('1.5', options)).toBe(20);
  });
});
