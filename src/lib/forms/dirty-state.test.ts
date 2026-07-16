import { describe, expect, it } from 'vitest';
import { hasUnsavedChanges } from './dirty-state';

describe('hasUnsavedChanges', () => {
  it('stays clean until saved values have loaded', () => {
    expect(hasUnsavedChanges({ name: '' }, null)).toBe(false);
  });

  it('detects changes and becomes clean again when reverted', () => {
    const saved = { name: 'Synapsis', isNsfw: false };

    expect(hasUnsavedChanges(saved, saved)).toBe(false);
    expect(hasUnsavedChanges({ ...saved, name: 'New name' }, saved)).toBe(true);
    expect(hasUnsavedChanges({ ...saved }, saved)).toBe(false);
  });

  it('detects nested array changes such as source configurations', () => {
    const saved = [{ id: 'source-1', config: { active: true } }];

    expect(hasUnsavedChanges(saved, saved)).toBe(false);
    expect(hasUnsavedChanges([...saved, { id: 'source-2', config: { active: true } }], saved)).toBe(true);
  });
});
