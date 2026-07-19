import { describe, expect, it } from 'vitest';
import { strictSwarmNodeInfoSchema } from './node-payload';

describe('strict swarm node payloads', () => {
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
});
