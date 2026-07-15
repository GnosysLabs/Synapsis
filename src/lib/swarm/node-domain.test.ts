import { describe, expect, it } from 'vitest';
import {
  getCanonicalSwarmSeedDomain,
  getPublicSwarmDomain,
  isPublicSwarmDomain,
  resolveNodeAssetUrl,
} from './node-domain';

describe('public swarm domains', () => {
  it.each([
    ['synapsis.social', 'synapsis.social'],
    ['https://Node.Synapsis.Social/', 'node.synapsis.social'],
    ['node.synapsis.social:8443', 'node.synapsis.social:8443'],
    ['social.example.co.uk', 'social.example.co.uk'],
  ])('accepts a public ICANN domain: %s', (input, expected) => {
    expect(getPublicSwarmDomain(input)).toBe(expected);
  });

  it.each([
    'localhost',
    'localhost:43821',
    '127.0.0.1',
    '192.168.1.20:43821',
    '[::1]:43821',
    'synapsis.local',
    'synapsis.test',
    'synapsis.invalid',
    'synapsis.internal',
    'example.com',
    'node.example.com',
    'node.onion',
    'home.arpa',
    'not a domain',
  ])('rejects a local, reserved, or non-public domain: %s', (input) => {
    expect(isPublicSwarmDomain(input)).toBe(false);
  });
});

describe('swarm seed domains', () => {
  it('maps the retired bootstrap hostname to the official node identity', () => {
    expect(getCanonicalSwarmSeedDomain('node.synapsis.social')).toBe('synapsis.social');
    expect(getCanonicalSwarmSeedDomain('https://NODE.SYNAPSIS.SOCIAL/')).toBe('synapsis.social');
  });

  it('leaves other valid seed domains unchanged', () => {
    expect(getCanonicalSwarmSeedDomain('batorbros.bond')).toBe('batorbros.bond');
  });

  it('rejects non-public seed domains', () => {
    expect(getCanonicalSwarmSeedDomain('localhost:43821')).toBeNull();
  });
});

describe('node asset URLs', () => {
  it('resolves a relative logo path against the node domain', () => {
    expect(
      resolveNodeAssetUrl('/api/node/logo?v=1784095823196', 'batorbros.bond')
    ).toBe('https://batorbros.bond/api/node/logo?v=1784095823196');
  });

  it('preserves an absolute HTTPS asset URL', () => {
    expect(
      resolveNodeAssetUrl('https://media.example.org/node/logo.png', 'batorbros.bond')
    ).toBe('https://media.example.org/node/logo.png');
  });
});
