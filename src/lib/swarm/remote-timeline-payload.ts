import { z } from 'zod';
import type {
  SwarmAccountDeletion,
  SwarmPost,
  SwarmPostChange,
} from '@/app/api/swarm/timeline/route';
import {
  federationMediaUrlSchema,
  federationWebUrlSchema,
  federatedHandleSchema,
} from '@/lib/utils/federation';
import {
  canonicalAccountHomeDomain,
  requireCanonicalAccountHomeDomain,
  resolveAccountAddress,
} from '@/lib/identity/account-address';

const MAX_REMOTE_POSTS = 50;
const boundedCount = z.number().int().nonnegative().max(1_000_000_000);
const timestamp = z.string().datetime();

const mediaSchema = z.object({
  url: federationMediaUrlSchema,
  mimeType: z.string().max(255).optional(),
  altText: z.string().max(2_000).optional(),
});

const previewMediaSchema = z.object({
  url: federationWebUrlSchema,
  width: z.number().int().positive().max(100_000).nullish(),
  height: z.number().int().positive().max(100_000).nullish(),
  mimeType: z.string().max(255).nullish(),
});

const stuffboxBadgeSchema = z.object({
  attestation: z.string().min(100).max(8 * 1024),
});

const authorSchema = z.object({
  handle: federatedHandleSchema,
  displayName: z.string().min(1).max(50),
  avatarUrl: federationMediaUrlSchema.optional(),
  isNsfw: z.boolean().optional(),
  stuffboxBadge: stuffboxBadgeSchema.nullish(),
});

const reposterSchema = z.object({
  id: z.string().min(1).max(1_024),
  handle: z.string().min(3).max(640),
  displayName: z.string().min(1).max(50),
  avatarUrl: federationMediaUrlSchema.nullish(),
  isNsfw: z.boolean().optional(),
  nodeIsNsfw: z.boolean().optional(),
  nodeDomain: z.string().min(1).max(253).nullish(),
  isRemote: z.boolean().optional(),
  isSwarm: z.boolean().optional(),
  stuffboxBadge: stuffboxBadgeSchema.nullish(),
});

const shallowPostSchema = z.object({
  id: z.string().min(1).max(512),
  content: z.string().max(600),
  createdAt: timestamp,
  feedActivityAt: timestamp.optional(),
  isReply: z.boolean().optional(),
  replyToId: z.string().max(512).nullish(),
  swarmReplyToId: z.string().max(512).nullish(),
  repostOfId: z.string().max(512).nullish(),
  repostedBy: z.array(reposterSchema).max(20).optional(),
  repostedByCount: boundedCount.optional(),
  author: authorSchema,
  nodeDomain: z.string().min(1).max(253),
  nodeIsNsfw: z.boolean().optional(),
  isNsfw: z.boolean().optional(),
  likeCount: boundedCount,
  repostCount: boundedCount,
  replyCount: boundedCount,
  media: z.array(mediaSchema).max(4).optional(),
  linkPreviewUrl: federationWebUrlSchema.optional(),
  linkPreviewTitle: z.string().max(300).optional(),
  linkPreviewDescription: z.string().max(1_000).optional(),
  linkPreviewImage: federationWebUrlSchema.optional(),
  linkPreviewType: z.enum(['card', 'image', 'gallery', 'video']).optional(),
  linkPreviewVideoUrl: federationMediaUrlSchema.optional(),
  linkPreviewMedia: z.array(previewMediaSchema).max(4).optional(),
});

const postSchema = shallowPostSchema.extend({
  // Exactly one nested level is accepted. Unknown recursive fields are stripped.
  repostOf: shallowPostSchema.nullish(),
});

const changeBaseSchema = z.object({
  sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  postId: z.string().min(1).max(512),
  changedAt: timestamp,
});
const changeSchema = z.discriminatedUnion('type', [
  changeBaseSchema.extend({ type: z.literal('delete') }),
  changeBaseSchema.extend({ type: z.literal('upsert'), post: postSchema }),
]);
const accountChangeSchema = z.object({
  sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  handle: federatedHandleSchema,
  did: z.string().min(16).max(2_048),
  deletedAt: timestamp,
});

const responseSchema = z.object({
  posts: z.array(postSchema).max(MAX_REMOTE_POSTS),
  changes: z.array(changeSchema).max(MAX_REMOTE_POSTS).optional(),
  changeCursor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  hasMoreChanges: z.boolean().optional(),
  accountChanges: z.array(accountChangeSchema).max(MAX_REMOTE_POSTS).optional(),
  accountChangeCursor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  hasMoreAccountChanges: z.boolean().optional(),
  nodeDomain: z.string().min(1).max(253).optional(),
  nodeIsNsfw: z.boolean().optional(),
  timestamp: timestamp.optional(),
});

function validatePostOriginAndTime(
  post: z.infer<typeof shallowPostSchema>,
  sourceDomain: string,
): void {
  if (canonicalAccountHomeDomain(post.nodeDomain) !== sourceDomain) {
    throw new Error('Remote timeline attempted to assert a different node origin');
  }
  const authorAddress = resolveAccountAddress(post.author.handle, sourceDomain);
  if (!authorAddress || authorAddress.homeDomain !== sourceDomain) {
    throw new Error('Remote timeline attempted a cross-node author claim');
  }
  const maximumTimestamp = Date.now() + 5 * 60 * 1_000;
  if (new Date(post.createdAt).getTime() > maximumTimestamp
    || (post.feedActivityAt && new Date(post.feedActivityAt).getTime() > maximumTimestamp)) {
    throw new Error('Remote timeline contains a future-dated post');
  }
}

function normalizeReposters(
  repostedBy: z.infer<typeof reposterSchema>[] | undefined,
  sourceDomain: string,
): z.infer<typeof reposterSchema>[] | undefined {
  return repostedBy?.flatMap((reposter) => {
    const address = resolveAccountAddress(reposter.handle, sourceDomain);

    if (!address
      || address.homeDomain !== sourceDomain
      || (reposter.nodeDomain
        && canonicalAccountHomeDomain(reposter.nodeDomain) !== sourceDomain)) {
      return [];
    }

    return [{
      ...reposter,
      id: `swarm:${sourceDomain}:${address.username}`,
      handle: address.canonical,
      nodeDomain: sourceDomain,
      isNsfw: reposter.isNsfw ?? true,
      nodeIsNsfw: reposter.nodeIsNsfw ?? true,
      isRemote: true,
      isSwarm: true,
    }];
  });
}

export function parseRemoteTimelineResponse(
  value: unknown,
  sourceDomainInput: string,
): {
  posts: SwarmPost[];
  changes: SwarmPostChange[];
  changeCursor?: number;
  hasMoreChanges?: boolean;
  accountChanges: SwarmAccountDeletion[];
  accountChangeCursor?: number;
  hasMoreAccountChanges?: boolean;
  nodeIsNsfw?: boolean;
} {
  const sourceDomain = requireCanonicalAccountHomeDomain(sourceDomainInput);
  const parsed = responseSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error('Remote timeline response failed validation');
  }
  if (parsed.data.nodeDomain
    && canonicalAccountHomeDomain(parsed.data.nodeDomain) !== sourceDomain) {
    throw new Error('Remote timeline returned a different node identity');
  }

  for (const post of parsed.data.posts) {
    validatePostOriginAndTime(post, sourceDomain);
    if (post.repostOf) validatePostOriginAndTime(post.repostOf, sourceDomain);
  }
  for (const change of parsed.data.changes || []) {
    if (change.type === 'upsert') {
      if (change.post.id !== change.postId) {
        throw new Error('Remote timeline change post identity mismatch');
      }
      validatePostOriginAndTime(change.post, sourceDomain);
      if (change.post.repostOf) validatePostOriginAndTime(change.post.repostOf, sourceDomain);
    }
  }
  for (const change of parsed.data.accountChanges || []) {
    if (new Date(change.deletedAt).getTime() > Date.now() + 5 * 60 * 1_000) {
      throw new Error('Remote timeline contains a future-dated account deletion');
    }
    const address = resolveAccountAddress(change.handle, sourceDomain);
    if (!address || address.homeDomain !== sourceDomain) {
      throw new Error('Remote timeline contains a cross-node account deletion');
    }
  }

  const posts = parsed.data.posts.map((post) => ({
    ...post,
    nodeDomain: sourceDomain,
    author: {
      ...post.author,
      handle: resolveAccountAddress(post.author.handle, sourceDomain)!.canonical,
    },
    repostedBy: normalizeReposters(post.repostedBy, sourceDomain),
    repostOf: post.repostOf
      ? {
        ...post.repostOf,
        nodeDomain: sourceDomain,
        author: {
          ...post.repostOf.author,
          handle: resolveAccountAddress(post.repostOf.author.handle, sourceDomain)!.canonical,
        },
        repostedBy: normalizeReposters(post.repostOf.repostedBy, sourceDomain),
      }
      : post.repostOf,
  })) as SwarmPost[];
  const changes = (parsed.data.changes || []).map((change): SwarmPostChange => {
    if (change.type === 'delete') return change;
    return {
      ...change,
      post: {
        ...change.post,
        nodeDomain: sourceDomain,
        author: {
          ...change.post.author,
          handle: resolveAccountAddress(change.post.author.handle, sourceDomain)!.canonical,
        },
        repostedBy: normalizeReposters(change.post.repostedBy, sourceDomain),
        repostOf: change.post.repostOf
          ? {
              ...change.post.repostOf,
              nodeDomain: sourceDomain,
              author: {
                ...change.post.repostOf.author,
                handle: resolveAccountAddress(
                  change.post.repostOf.author.handle,
                  sourceDomain,
                )!.canonical,
              },
              repostedBy: normalizeReposters(change.post.repostOf.repostedBy, sourceDomain),
            }
          : change.post.repostOf,
      } as SwarmPost,
    };
  });

  return {
    posts,
    changes,
    changeCursor: parsed.data.changeCursor,
    hasMoreChanges: parsed.data.hasMoreChanges,
    accountChanges: (parsed.data.accountChanges || []).map((change) => ({
      ...change,
      handle: resolveAccountAddress(change.handle, sourceDomain)!.canonical,
    })),
    accountChangeCursor: parsed.data.accountChangeCursor,
    hasMoreAccountChanges: parsed.data.hasMoreAccountChanges,
    nodeIsNsfw: parsed.data.nodeIsNsfw,
  };
}
