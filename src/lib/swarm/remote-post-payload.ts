import { z } from 'zod';
import { mapWithConcurrency } from '@/lib/async/concurrency';
import { didKeyMatchesPublicKey, normalizeSigningPublicKey } from '@/lib/crypto/did-key';
import {
  federationMediaUrlSchema,
  federationWebUrlSchema,
  nodeDomainSchema,
} from '@/lib/utils/federation';
import { normalizeNodeDomain } from './node-domain';
import {
  relayedReplyProvenanceSchema,
  verifyRelayedReplyProvenance,
  type NodeProofVerifier,
} from './reply-provenance';

const MAX_REMOTE_POSTS = 50;
const MAX_REMOTE_REPLIES = 50;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1_000;
const boundedCount = z.number().int().nonnegative().max(1_000_000_000);
const localHandle = z.string().min(1).max(64).regex(/^[a-zA-Z0-9_]+$/);
const timestamp = z.string().datetime();

const mediaSchema = z.object({
  id: z.string().max(512).optional(),
  url: federationMediaUrlSchema,
  mimeType: z.string().max(255).nullish(),
  altText: z.string().max(2_000).nullish(),
});

const previewMediaSchema = z.object({
  url: federationMediaUrlSchema,
  width: z.number().int().positive().max(100_000).nullish(),
  height: z.number().int().positive().max(100_000).nullish(),
  mimeType: z.string().max(255).nullish(),
});

const authorSchema = z.object({
  handle: z.string().min(1).max(640),
  displayName: z.string().min(1).max(50).nullish(),
  avatarUrl: federationMediaUrlSchema.nullish(),
  isNsfw: z.boolean().optional(),
  nodeIsNsfw: z.boolean().optional(),
  nodeDomain: nodeDomainSchema.nullish(),
});

const reposterSchema = authorSchema.extend({
  id: z.string().min(1).max(1_024).optional(),
});

const shallowPostSchema = z.object({
  id: z.string().uuid(),
  originalPostId: z.string().uuid().optional(),
  nodeDomain: nodeDomainSchema.nullish(),
  content: z.string().max(600),
  createdAt: timestamp,
  feedActivityAt: timestamp.optional(),
  isReply: z.boolean().optional(),
  replyToId: z.string().max(512).nullish(),
  swarmReplyToId: z.string().max(512).nullish(),
  isNsfw: z.boolean().optional(),
  nodeIsNsfw: z.boolean().optional(),
  originUnavailable: z.boolean().optional(),
  likesCount: boundedCount.optional(),
  repostsCount: boundedCount.optional(),
  repliesCount: boundedCount.optional(),
  likeCount: boundedCount.optional(),
  repostCount: boundedCount.optional(),
  replyCount: boundedCount.optional(),
  repostOfId: z.string().uuid().nullish(),
  repostedBy: z.array(reposterSchema).max(20).optional(),
  repostedByCount: boundedCount.optional(),
  author: authorSchema,
  media: z.array(mediaSchema).max(4).optional(),
  linkPreviewUrl: federationWebUrlSchema.nullish(),
  linkPreviewTitle: z.string().max(300).nullish(),
  linkPreviewDescription: z.string().max(1_000).nullish(),
  linkPreviewImage: federationMediaUrlSchema.nullish(),
  linkPreviewType: z.enum(['card', 'image', 'gallery', 'video']).nullish(),
  linkPreviewVideoUrl: federationMediaUrlSchema.nullish(),
  linkPreviewMedia: z.array(previewMediaSchema).max(4).nullish(),
});

const postSchema = shallowPostSchema.extend({
  // The nested schema deliberately has no recursive relation fields. Zod
  // strips any deeper attacker-provided nesting before the value is returned.
  repostOf: shallowPostSchema.nullish(),
});

const relayedReplyCandidateSchema = shallowPostSchema.extend({
  provenance: relayedReplyProvenanceSchema,
});

const profileSchema = z.object({
  handle: localHandle,
  displayName: z.string().min(1).max(50),
  bio: z.string().max(160).optional(),
  avatarUrl: federationMediaUrlSchema.optional(),
  headerUrl: federationMediaUrlSchema.optional(),
  website: federationWebUrlSchema.optional(),
  followersCount: boundedCount,
  followingCount: boundedCount,
  postsCount: boundedCount,
  createdAt: timestamp,
  isNsfw: z.boolean(),
  nodeIsNsfw: z.boolean(),
  nodeDomain: nodeDomainSchema,
  publicKey: z.string().min(1).max(2_048),
  did: z.string().min(16).max(2_048),
  nsfwRestricted: z.boolean().optional(),
});

const profileResponseSchema = z.object({
  profile: profileSchema,
  posts: z.array(z.unknown()).max(MAX_REMOTE_POSTS),
  nodeDomain: nodeDomainSchema,
  timestamp,
});

const detailResponseSchema = z.object({
  post: z.unknown(),
  replies: z.array(z.unknown()).max(MAX_REMOTE_REPLIES).optional(),
});

const repliesResponseSchema = z.object({
  postId: z.string().uuid().optional(),
  replies: z.array(z.unknown()).max(MAX_REMOTE_REPLIES).optional(),
  nodeDomain: nodeDomainSchema.optional(),
});

const postListResponseSchema = z.object({
  posts: z.array(z.unknown()).max(MAX_REMOTE_POSTS),
});

export type RemoteSwarmProfile = z.infer<typeof profileSchema>;
export type RemoteSwarmPost = z.infer<typeof postSchema>;

export interface RemoteSwarmProfileResponse {
  profile: RemoteSwarmProfile;
  posts: RemoteSwarmPost[];
  nodeDomain: string;
  timestamp: string;
}

function assertNotFuture(value: string, label: string): void {
  if (new Date(value).getTime() > Date.now() + MAX_FUTURE_SKEW_MS) {
    throw new Error(`${label} is future-dated`);
  }
}

function sourceOwnedHandle(value: string, sourceDomain: string): string {
  const normalized = value.trim().replace(/^@/, '').toLowerCase();
  const atIndex = normalized.lastIndexOf('@');
  const bareHandle = atIndex === -1 ? normalized : normalized.slice(0, atIndex);
  const claimedDomain = atIndex === -1 ? sourceDomain : normalizeNodeDomain(normalized.slice(atIndex + 1));
  if (!localHandle.safeParse(bareHandle).success || claimedDomain !== sourceDomain) {
    throw new Error('Remote payload attempted a cross-node identity claim');
  }
  return bareHandle;
}

function assertSourceDomain(value: string | null | undefined, sourceDomain: string): void {
  if (value && normalizeNodeDomain(value) !== sourceDomain) {
    throw new Error('Remote payload attempted to assert a different node origin');
  }
}

function normalizePost(
  raw: unknown,
  sourceDomain: string,
  expectedAuthor?: string,
): RemoteSwarmPost {
  const parsed = postSchema.safeParse(raw);
  if (!parsed.success) throw new Error('Remote post failed validation');
  const post = parsed.data;
  assertSourceDomain(post.nodeDomain, sourceDomain);
  assertSourceDomain(post.author.nodeDomain, sourceDomain);
  assertNotFuture(post.createdAt, 'Remote post');
  if (post.feedActivityAt) assertNotFuture(post.feedActivityAt, 'Remote post activity');

  const authorHandle = sourceOwnedHandle(post.author.handle, sourceDomain);
  if (expectedAuthor && authorHandle !== expectedAuthor) {
    throw new Error('Remote profile post author does not match the requested account');
  }

  let repostOf: RemoteSwarmPost | null | undefined;
  if (post.repostOf) {
    assertSourceDomain(post.repostOf.nodeDomain, sourceDomain);
    assertSourceDomain(post.repostOf.author.nodeDomain, sourceDomain);
    assertNotFuture(post.repostOf.createdAt, 'Nested remote post');
    const nestedAuthor = sourceOwnedHandle(post.repostOf.author.handle, sourceDomain);
    repostOf = {
      ...post.repostOf,
      nodeDomain: sourceDomain,
      isNsfw: post.repostOf.isNsfw ?? true,
      nodeIsNsfw: post.repostOf.nodeIsNsfw ?? true,
      likesCount: post.repostOf.likesCount ?? post.repostOf.likeCount ?? 0,
      repostsCount: post.repostOf.repostsCount ?? post.repostOf.repostCount ?? 0,
      repliesCount: post.repostOf.repliesCount ?? post.repostOf.replyCount ?? 0,
      author: {
        ...post.repostOf.author,
        handle: nestedAuthor,
        nodeDomain: sourceDomain,
        isNsfw: post.repostOf.author.isNsfw ?? true,
        nodeIsNsfw: post.repostOf.author.nodeIsNsfw ?? post.repostOf.nodeIsNsfw ?? true,
      },
    };
  } else {
    repostOf = post.repostOf;
  }

  const repostedBy = post.repostedBy?.flatMap((reposter) => {
    try {
      assertSourceDomain(reposter.nodeDomain, sourceDomain);
      const handle = sourceOwnedHandle(reposter.handle, sourceDomain);
      return [{
        ...reposter,
        id: `swarm:${sourceDomain}:${handle}`,
        handle,
        nodeDomain: sourceDomain,
        isNsfw: reposter.isNsfw ?? true,
        nodeIsNsfw: reposter.nodeIsNsfw ?? true,
      }];
    } catch {
      return [];
    }
  });

  return {
    ...post,
    nodeDomain: sourceDomain,
    isNsfw: post.isNsfw ?? true,
    nodeIsNsfw: post.nodeIsNsfw ?? true,
    likesCount: post.likesCount ?? post.likeCount ?? 0,
    repostsCount: post.repostsCount ?? post.repostCount ?? 0,
    repliesCount: post.repliesCount ?? post.replyCount ?? 0,
    author: {
      ...post.author,
      handle: authorHandle,
      nodeDomain: sourceDomain,
      isNsfw: post.author.isNsfw ?? true,
      nodeIsNsfw: post.author.nodeIsNsfw ?? post.nodeIsNsfw ?? true,
    },
    repostOf,
    repostedBy,
  };
}

function validateProfileIdentity(profile: RemoteSwarmProfile, sourceDomain: string, expectedHandle: string): void {
  if (profile.handle.toLowerCase() !== expectedHandle
    || normalizeNodeDomain(profile.nodeDomain) !== sourceDomain) {
    throw new Error('Remote profile returned a different account identity');
  }
  assertNotFuture(profile.createdAt, 'Remote profile creation time');
  const normalizedKey = normalizeSigningPublicKey(profile.publicKey);
  if (!normalizedKey || !didKeyMatchesPublicKey(profile.did, normalizedKey)) {
    throw new Error('Remote profile identity is not bound to its signing key');
  }
  profile.publicKey = normalizedKey;
}

export function parseRemoteProfileResponse(
  value: unknown,
  sourceDomainInput: string,
  expectedHandleInput: string,
  postsLimit = MAX_REMOTE_POSTS,
): RemoteSwarmProfileResponse {
  const sourceDomain = normalizeNodeDomain(sourceDomainInput);
  const expectedHandle = expectedHandleInput.trim().replace(/^@/, '').toLowerCase();
  const parsed = profileResponseSchema.safeParse(value);
  if (!parsed.success) throw new Error('Remote profile response failed validation');
  if (normalizeNodeDomain(parsed.data.nodeDomain) !== sourceDomain) {
    throw new Error('Remote profile response returned a different node identity');
  }
  assertNotFuture(parsed.data.timestamp, 'Remote profile response');
  validateProfileIdentity(parsed.data.profile, sourceDomain, expectedHandle);

  const boundedLimit = Math.max(0, Math.min(MAX_REMOTE_POSTS, postsLimit));
  const posts = parsed.data.posts.slice(0, boundedLimit).flatMap((post) => {
    try {
      return [normalizePost(post, sourceDomain, expectedHandle)];
    } catch {
      return [];
    }
  });

  return {
    profile: parsed.data.profile,
    posts,
    nodeDomain: sourceDomain,
    timestamp: parsed.data.timestamp,
  };
}

export function parseRemotePostDetailResponse(
  value: unknown,
  sourceDomainInput: string,
  expectedPostId: string,
): { post: RemoteSwarmPost; replies: RemoteSwarmPost[] } {
  const sourceDomain = normalizeNodeDomain(sourceDomainInput);
  const parsed = detailResponseSchema.safeParse(value);
  if (!parsed.success) throw new Error('Remote post response failed validation');
  const post = normalizePost(parsed.data.post, sourceDomain);
  if (post.id !== expectedPostId && post.originalPostId !== expectedPostId) {
    throw new Error('Remote node returned a different post');
  }
  const replies = (parsed.data.replies || []).flatMap((reply) => {
    try {
      return [normalizePost(reply, sourceDomain)];
    } catch {
      return [];
    }
  });
  return { post, replies };
}

export async function parseRemoteRepliesResponse(
  value: unknown,
  sourceDomainInput: string,
  expectedPostId: string,
  options: {
    verifyNodeProof?: NodeProofVerifier;
    verifyIdentityContinuity?: (identity: {
      sourceDomain: string;
      actorHandle: string;
      did: string;
    }) => Promise<boolean>;
  } = {},
): Promise<RemoteSwarmPost[]> {
  const sourceDomain = normalizeNodeDomain(sourceDomainInput);
  const parsed = repliesResponseSchema.safeParse(value);
  if (!parsed.success) throw new Error('Remote replies response failed validation');
  if ((parsed.data.postId && parsed.data.postId !== expectedPostId)
    || (parsed.data.nodeDomain && normalizeNodeDomain(parsed.data.nodeDomain) !== sourceDomain)) {
    throw new Error('Remote replies response identity mismatch');
  }
  const verifiedReplies = await mapWithConcurrency(
    parsed.data.replies || [],
    4,
    async (reply): Promise<RemoteSwarmPost | null> => {
    try {
      return normalizePost(reply, sourceDomain);
    } catch {
      // A contacted node may relay a reply from the author's home node only
      // when it carries the immutable original node + user proof.
    }

    const candidate = relayedReplyCandidateSchema.safeParse(reply);
    if (!candidate.success) return null;
    const verified = await verifyRelayedReplyProvenance({
      provenance: candidate.data.provenance,
      relayDomain: sourceDomain,
      expectedParentPostId: expectedPostId,
      presentation: candidate.data,
      verifyNodeProof: options.verifyNodeProof,
    });
    if (!verified) return null;
    if (!options.verifyIdentityContinuity) return null;
    try {
      if (!await options.verifyIdentityContinuity({
        sourceDomain: verified.nodeDomain,
        actorHandle: verified.authorHandle,
        did: verified.authorDid,
      })) return null;
    } catch {
      return null;
    }

    try {
      return normalizePost({
        id: verified.id,
        content: verified.content,
        createdAt: verified.createdAt,
        nodeDomain: verified.nodeDomain,
        likesCount: candidate.data.likesCount ?? candidate.data.likeCount ?? 0,
        repostsCount: candidate.data.repostsCount ?? candidate.data.repostCount ?? 0,
        repliesCount: candidate.data.repliesCount ?? candidate.data.replyCount ?? 0,
        isNsfw: verified.isNsfw,
        nodeIsNsfw: verified.nodeIsNsfw,
        author: {
          handle: verified.authorHandle,
          displayName: verified.authorHandle,
          nodeDomain: verified.nodeDomain,
          isNsfw: verified.isNsfw,
          nodeIsNsfw: verified.nodeIsNsfw,
        },
        media: verified.media,
      }, verified.nodeDomain);
    } catch {
      return null;
    }
  });
  return verifiedReplies.flatMap((reply) => reply ? [reply] : []);
}

/**
 * Parse a peer's likes/replies-style post list without trusting it to relay
 * identities or objects belonging to arbitrary third-party nodes.
 */
export function parseRemotePostListResponse(
  value: unknown,
  sourceDomainInput: string,
  postsLimit = MAX_REMOTE_POSTS,
): RemoteSwarmPost[] {
  const sourceDomain = normalizeNodeDomain(sourceDomainInput);
  const parsed = postListResponseSchema.safeParse(value);
  if (!parsed.success) throw new Error('Remote post list failed validation');
  const boundedLimit = Math.max(0, Math.min(MAX_REMOTE_POSTS, postsLimit));
  return parsed.data.posts.slice(0, boundedLimit).flatMap((post) => {
    try {
      return [normalizePost(post, sourceDomain)];
    } catch {
      return [];
    }
  });
}
