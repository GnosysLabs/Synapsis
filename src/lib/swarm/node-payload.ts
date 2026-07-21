import { z } from 'zod';
import type { SwarmNodeInfo } from './types';
import { getPublicSwarmDomain } from './node-domain';
import {
  federationWebUrlSchema,
  sanitizeFederationMediaUrl,
} from '@/lib/utils/federation';

const boundedCount = z.number().int().nonnegative().max(1_000_000_000);

const swarmNodeInfoWireSchema = z.object({
  domain: z.string().min(1).max(253),
  name: z.string().max(100).optional(),
  description: z.string().max(1_000).optional(),
  // Keep the original URL until signed ingress has verified the payload.
  // Consumers sanitize it before storage or rendering.
  logoUrl: federationWebUrlSchema.optional(),
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

export function sanitizeSwarmNodeInfo(node: SwarmNodeInfo): SwarmNodeInfo {
  return {
    ...node,
    logoUrl: sanitizeFederationMediaUrl(node.logoUrl),
  };
}

export const swarmNodeInfoSchema = swarmNodeInfoWireSchema.transform(sanitizeSwarmNodeInfo);

// Ingress routes must reject unknown peer-controlled fields, but they should
// share the same canonical node shape as discovery and gossip clients. Keeping
// a separate strict copy caused `contentSequence` to be emitted by every node
// and rejected by every peer with HTTP 400.
export const strictSwarmNodeInfoSchema = swarmNodeInfoWireSchema.strict();

const directNodeInfoSchema = swarmNodeInfoWireSchema.extend({
  publicKey: z.string().min(1).max(16_384),
  isNsfw: z.boolean(),
}).transform(sanitizeSwarmNodeInfo);

export function parseDirectNodeInfo(value: unknown, expectedDomain: string): SwarmNodeInfo {
  const parsed = directNodeInfoSchema.safeParse(value);
  const expected = getPublicSwarmDomain(expectedDomain);
  if (!parsed.success || !expected || getPublicSwarmDomain(parsed.data.domain) !== expected) {
    throw new Error('Remote node returned an invalid or different domain identity');
  }
  return { ...parsed.data, domain: expected };
}
