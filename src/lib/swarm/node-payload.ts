import { z } from 'zod';
import type { SwarmNodeInfo } from './types';
import { getPublicSwarmDomain } from './node-domain';
import { federationMediaUrlSchema } from '@/lib/utils/federation';

const boundedCount = z.number().int().nonnegative().max(1_000_000_000);

export const swarmNodeInfoSchema = z.object({
  domain: z.string().min(1).max(253),
  name: z.string().max(100).optional(),
  description: z.string().max(1_000).optional(),
  logoUrl: federationMediaUrlSchema.optional(),
  publicKey: z.string().max(16_384).optional(),
  softwareVersion: z.string().max(100).optional(),
  userCount: boundedCount.optional(),
  postCount: boundedCount.optional(),
  mediaCount: boundedCount.optional(),
  contentSequence: boundedCount.optional(),
  isNsfw: z.boolean().optional(),
  capabilities: z.array(z.enum([
    'handles', 'gossip', 'relay', 'search', 'interactions', 'e2ee_dm_v1',
  ])).max(6).optional(),
  lastSeenAt: z.string().datetime().optional(),
});

const directNodeInfoSchema = swarmNodeInfoSchema.extend({
  publicKey: z.string().min(1).max(16_384),
  isNsfw: z.boolean(),
});

export function parseDirectNodeInfo(value: unknown, expectedDomain: string): SwarmNodeInfo {
  const parsed = directNodeInfoSchema.safeParse(value);
  const expected = getPublicSwarmDomain(expectedDomain);
  if (!parsed.success || !expected || getPublicSwarmDomain(parsed.data.domain) !== expected) {
    throw new Error('Remote node returned an invalid or different domain identity');
  }
  return { ...parsed.data, domain: expected };
}
