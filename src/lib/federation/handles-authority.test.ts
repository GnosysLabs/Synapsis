import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({ db: null, handleRegistry: {} }));

import { canonicalHandleEntry } from './handles';

describe('authoritative handle entries', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('keeps both remote and local handles canonically qualified', () => {
    vi.stubEnv('NEXT_PUBLIC_NODE_DOMAIN', 'local.social');
    expect(canonicalHandleEntry({
      handle: 'Alice',
      did: 'did:key:alice',
      nodeDomain: 'remote.social',
    }, 'remote.social')?.handle).toBe('alice@remote.social');
    expect(canonicalHandleEntry({
      handle: '@Alice',
      did: 'did:key:alice',
      nodeDomain: 'local.social',
    }, 'local.social')?.handle).toBe('alice@local.social');
  });

  it('rejects claims for a domain other than the direct authority', () => {
    expect(canonicalHandleEntry({
      handle: 'alice',
      did: 'did:key:alice',
      nodeDomain: 'victim.social',
    }, 'attacker.social')).toBeNull();
    expect(canonicalHandleEntry({
      handle: 'alice@victim.social',
      did: 'did:key:alice',
      nodeDomain: 'attacker.social',
    }, 'attacker.social')).toBeNull();
  });
});
