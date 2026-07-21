import { describe, expect, it } from 'vitest';

import {
  displayAccountAddress,
  canonicalAccountHomeDomain,
  isAccountOnNode,
  parseAccountAddress,
  resolveAccountAddress,
  sameAccountAddress,
} from './account-address';

describe('canonical account addresses', () => {
  it('keeps same-node accounts qualified', () => {
    expect(resolveAccountAddress('@Alice', 'Social.Example.org')).toEqual({
      username: 'alice',
      homeDomain: 'social.example.org',
      canonical: 'alice@social.example.org',
    });
    expect(parseAccountAddress('@Alice@Social.Example.org')?.canonical)
      .toBe('alice@social.example.org');
  });

  it('accepts a bare username only with authoritative origin context', () => {
    expect(resolveAccountAddress('alice')).toBeNull();
    expect(resolveAccountAddress('alice', 'remote.example.org')?.canonical)
      .toBe('alice@remote.example.org');
  });

  it('does not conflate the same username on different nodes', () => {
    expect(sameAccountAddress(
      'alice@one.example.org',
      'alice@two.example.org',
    )).toBe(false);
    expect(isAccountOnNode('alice@one.example.org', 'one.example.org')).toBe(true);
  });

  it('renders exactly one display sigil', () => {
    expect(displayAccountAddress('alice@social.example.org'))
      .toBe('@alice@social.example.org');
    expect(displayAccountAddress('@alice@social.example.org'))
      .toBe('@alice@social.example.org');
  });

  it('canonicalizes the legacy public seed alias', () => {
    expect(canonicalAccountHomeDomain('https://node.synapsis.social/'))
      .toBe('synapsis.social');
    expect(parseAccountAddress('alice@node.synapsis.social')?.canonical)
      .toBe('alice@synapsis.social');
  });
});
