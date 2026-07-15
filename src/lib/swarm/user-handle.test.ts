import { describe, expect, it } from 'vitest';
import { resolveUserHandle } from './user-handle';

describe('resolveUserHandle', () => {
  it('normalizes an unqualified local handle', () => {
    expect(resolveUserHandle('  @Alice  ', 'social.example.org')).toEqual({
      canonicalHandle: 'alice',
      handle: 'alice',
      domain: null,
      isQualified: false,
      isLocal: true,
      remote: null,
    });
  });

  it('canonicalizes a same-node qualified handle to its local database handle', () => {
    expect(resolveUserHandle('Alice@Social.Example.org', 'https://social.example.org/')).toEqual({
      canonicalHandle: 'alice',
      handle: 'alice',
      domain: 'social.example.org',
      isQualified: true,
      isLocal: true,
      remote: null,
    });
  });

  it('preserves a genuinely remote qualified handle', () => {
    expect(resolveUserHandle('Alice@remote.example.org', 'social.example.org')).toEqual({
      canonicalHandle: 'alice@remote.example.org',
      handle: 'alice',
      domain: 'remote.example.org',
      isQualified: true,
      isLocal: false,
      remote: {
        handle: 'alice',
        domain: 'remote.example.org',
      },
    });
  });

  it('compares development domains including ports', () => {
    expect(resolveUserHandle('Alice@localhost:43821', 'http://localhost:43821')).toMatchObject({
      canonicalHandle: 'alice',
      isLocal: true,
      remote: null,
    });
    expect(resolveUserHandle('Alice@localhost:43822', 'localhost:43821')).toMatchObject({
      canonicalHandle: 'alice@localhost:43822',
      isLocal: false,
      remote: { handle: 'alice', domain: 'localhost:43822' },
    });
  });

  it('does not misclassify malformed handles as remote', () => {
    expect(resolveUserHandle('alice@@social.example.org', 'social.example.org')).toMatchObject({
      canonicalHandle: 'alice@@social.example.org',
      isQualified: false,
      isLocal: true,
      remote: null,
    });
  });
});
