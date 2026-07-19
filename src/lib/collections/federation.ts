import { z } from 'zod';

import type { CollectionDetail, CollectionSummary } from '@/lib/collections/types';
import { mapRemoteProfilePost } from '@/lib/swarm/remote-profile-posts';
import { isNodeBlocked } from '@/lib/swarm/node-blocklist';
import { getPublicSwarmDomain, normalizeNodeDomain } from '@/lib/swarm/node-domain';
import { parseRemoteProfileResponse } from '@/lib/swarm/remote-post-payload';
import { getKnownSwarmNodeNsfw } from '@/lib/swarm/registry';
import { signedFederationRead } from '@/lib/swarm/signed-read';
import { federationMediaUrlSchema } from '@/lib/utils/federation';

const DEVELOPMENT_LOOPBACK_DOMAIN = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i;
const boundedCount = z.number().int().nonnegative().max(1_000_000);
const collectionSummarySchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(1).max(80),
  description: z.string().max(240).nullable(),
  coverUrl: federationMediaUrlSchema.nullable(),
  previewImages: z.array(federationMediaUrlSchema).max(4),
  postCount: boundedCount,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

const collectionListResponseSchema = z.object({
  collections: z.array(collectionSummarySchema).max(200),
});

const collectionDetailResponseSchema = z.object({
  collection: collectionSummarySchema,
  nextCursor: z.string().uuid().nullable(),
});

function remoteTarget(domain: string) {
  const normalized = normalizeNodeDomain(domain);
  const publicDomain = getPublicSwarmDomain(normalized);
  const developmentDomain = process.env.NODE_ENV === 'development'
    && DEVELOPMENT_LOOPBACK_DOMAIN.test(normalized)
    ? normalized
    : null;
  const targetDomain = publicDomain ?? developmentDomain;
  if (!targetDomain) return null;
  return {
    targetDomain,
    baseUrl: developmentDomain ? `http://${targetDomain}` : `https://${targetDomain}`,
  };
}

export async function fetchRemoteCollectionList(handle: string, domain: string): Promise<{
  collections: CollectionSummary[];
  profile: { isNsfw: boolean; nodeIsNsfw: boolean };
} | null> {
  try {
    const target = remoteTarget(domain);
    const cleanHandle = handle.trim().replace(/^@/, '').toLowerCase();
    if (!target || !/^[a-z0-9_]{1,64}$/.test(cleanHandle) || await isNodeBlocked(target.targetDomain)) {
      return null;
    }
    const response = await signedFederationRead(
      new URL(`/api/swarm/users/${encodeURIComponent(cleanHandle)}/collections`, target.baseUrl).toString(),
      { headers: { Accept: 'application/json' }, maxResponseBytes: 512 * 1024 },
    );
    if (response.status < 200 || response.status >= 300) return null;
    const raw = response.json();
    const profileResponse = parseRemoteProfileResponse(raw, target.targetDomain, cleanHandle, 0);
    const parsed = collectionListResponseSchema.parse(raw);
    const knownNodeIsNsfw = await getKnownSwarmNodeNsfw(target.targetDomain);
    return {
      collections: parsed.collections,
      profile: {
        isNsfw: profileResponse.profile.isNsfw,
        nodeIsNsfw: profileResponse.profile.nodeIsNsfw || knownNodeIsNsfw === true,
      },
    };
  } catch (error) {
    console.error(`[Collections] Failed to fetch collections for ${handle}@${domain}:`, error);
    return null;
  }
}

export async function fetchRemoteCollectionDetail(
  handle: string,
  domain: string,
  collectionId: string,
  cursor?: string | null,
): Promise<{
  collection: CollectionDetail;
  nextCursor: string | null;
  profile: { isNsfw: boolean; nodeIsNsfw: boolean };
} | null> {
  try {
    const target = remoteTarget(domain);
    const cleanHandle = handle.trim().replace(/^@/, '').toLowerCase();
    if (
      !target
      || !/^[a-z0-9_]{1,64}$/.test(cleanHandle)
      || !z.string().uuid().safeParse(collectionId).success
      || await isNodeBlocked(target.targetDomain)
    ) {
      return null;
    }
    const url = new URL(
        `/api/swarm/users/${encodeURIComponent(cleanHandle)}/collections/${encodeURIComponent(collectionId)}`,
        target.baseUrl,
      );
    if (cursor && z.string().uuid().safeParse(cursor).success) url.searchParams.set('cursor', cursor);
    const response = await signedFederationRead(
      url.toString(),
      { headers: { Accept: 'application/json' }, maxResponseBytes: 1024 * 1024 },
    );
    if (response.status < 200 || response.status >= 300) return null;
    const raw = response.json();
    const profileResponse = parseRemoteProfileResponse(raw, target.targetDomain, cleanHandle, 50);
    const parsed = collectionDetailResponseSchema.parse(raw);
    const knownNodeIsNsfw = await getKnownSwarmNodeNsfw(target.targetDomain);
    return {
      collection: {
        ...parsed.collection,
        posts: profileResponse.posts.map((post) => (
          mapRemoteProfilePost(post, target.targetDomain)
        )) as unknown as CollectionDetail['posts'],
      },
      nextCursor: parsed.nextCursor,
      profile: {
        isNsfw: profileResponse.profile.isNsfw,
        nodeIsNsfw: profileResponse.profile.nodeIsNsfw || knownNodeIsNsfw === true,
      },
    };
  } catch (error) {
    console.error(`[Collections] Failed to fetch collection ${collectionId} for ${handle}@${domain}:`, error);
    return null;
  }
}
