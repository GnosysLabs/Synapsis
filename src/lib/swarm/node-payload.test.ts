import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  parseDirectNodeInfo,
  strictSwarmNodeInfoSchema,
  swarmNodeInfoSchema,
} from './node-payload';

describe('strict swarm node payloads', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('accepts the content sequence emitted by gossip announcements', () => {
    expect(strictSwarmNodeInfoSchema.parse({
      domain: 'peer.social',
      publicKey: 'PINNED KEY',
      isNsfw: false,
      contentSequence: 42,
    })).toMatchObject({
      domain: 'peer.social',
      contentSequence: 42,
    });
  });

  it('still rejects unknown peer-controlled fields', () => {
    expect(() => strictSwarmNodeInfoSchema.parse({
      domain: 'peer.social',
      unexpected: true,
    })).toThrow();
  });

  it('preserves a legacy logo on the signed wire shape, then drops it before use', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const legacyNode = {
      domain: 'peer.social',
      publicKey: 'PINNED KEY',
      isNsfw: false,
      logoUrl: 'https://peer.social/api/node/logo?v=1',
    };

    expect(strictSwarmNodeInfoSchema.parse(legacyNode).logoUrl).toBe(legacyNode.logoUrl);
    expect(swarmNodeInfoSchema.parse(legacyNode).logoUrl).toBeUndefined();
    expect(parseDirectNodeInfo(legacyNode, 'peer.social').logoUrl).toBeUndefined();
  });
});
