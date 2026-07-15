import { describe, expect, it } from 'vitest';
import { getPublicSwarmDomain, isPublicSwarmDomain } from './node-domain';

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

