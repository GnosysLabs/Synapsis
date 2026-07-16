import { describe, expect, it } from 'vitest';
import {
  extractOriginalSwarmPostId,
  extractSwarmPostDomain,
  normalizeSameNodePostId,
} from './post-id';

describe('swarm post IDs', () => {
  it('extracts domains and original IDs', () => {
    const id = 'swarm:rprh.link:15f11861-693a-4f70-8480-5d82bb8d14a7';
    expect(extractSwarmPostDomain(id)).toBe('rprh.link');
    expect(extractOriginalSwarmPostId(id)).toBe('15f11861-693a-4f70-8480-5d82bb8d14a7');
  });

  it('normalizes a same-node swarm ID to its local UUID', () => {
    expect(normalizeSameNodePostId(
      'swarm:RPRH.link:15f11861-693a-4f70-8480-5d82bb8d14a7',
      'https://rprh.link/'
    )).toBe('15f11861-693a-4f70-8480-5d82bb8d14a7');
  });

  it('leaves genuinely remote swarm IDs unchanged', () => {
    const id = 'swarm:remote.example:15f11861-693a-4f70-8480-5d82bb8d14a7';
    expect(normalizeSameNodePostId(id, 'rprh.link')).toBe(id);
  });
});
