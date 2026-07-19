import { z } from 'zod';
import type { SwarmPost } from '@/app/api/swarm/timeline/route';
import {
  federationMediaUrlSchema,
  federationWebUrlSchema,
} from '@/lib/utils/federation';
import { normalizeNodeDomain } from './node-domain';

const MAX_REMOTE_POSTS = 50;
const boundedCount = z.number().int().nonnegative().max(1_000_000_000);
const timestamp = z.string().datetime();

const mediaSchema = z.object({
  url: federationMediaUrlSchema,
  mimeType: z.string().max(255).optional(),
  altText: z.string().max(2_000).optional(),
});

const previewMediaSchema = z.object({
  url: federationMediaUrlSchema,
  width: z.number().int().positive().max(100_000).nullish(),
  height: z.number().int().positive().max(100_000).nullish(),
  mimeType: z.string().max(255).nullish(),
});

const authorSchema = z.object({
  handle: z.string().min(3).max(30).regex(/^[a-zA-Z0-9_]+$/),
  displayName: z.string().min(1).max(50),
  avatarUrl: federationMediaUrlSchema.optional(),
  isNsfw: z.boolean().optional(),
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
  linkPreviewImage: federationMediaUrlSchema.optional(),
  linkPreviewType: z.enum(['card', 'image', 'gallery', 'video']).optional(),
  linkPreviewVideoUrl: federationMediaUrlSchema.optional(),
  linkPreviewMedia: z.array(previewMediaSchema).max(4).optional(),
});

const postSchema = shallowPostSchema.extend({
  // Exactly one nested level is accepted. Unknown recursive fields are stripped.
  repostOf: shallowPostSchema.nullish(),
});

const responseSchema = z.object({
  posts: z.array(postSchema).max(MAX_REMOTE_POSTS),
  nodeDomain: z.string().min(1).max(253).optional(),
  nodeIsNsfw: z.boolean().optional(),
  timestamp: timestamp.optional(),
});

function validatePostOriginAndTime(
  post: z.infer<typeof shallowPostSchema>,
  sourceDomain: string,
): void {
  if (normalizeNodeDomain(post.nodeDomain) !== sourceDomain) {
    throw new Error('Remote timeline attempted to assert a different node origin');
  }
  const maximumTimestamp = Date.now() + 5 * 60 * 1_000;
  if (new Date(post.createdAt).getTime() > maximumTimestamp
    || (post.feedActivityAt && new Date(post.feedActivityAt).getTime() > maximumTimestamp)) {
    throw new Error('Remote timeline contains a future-dated post');
  }
}

export function parseRemoteTimelineResponse(
  value: unknown,
  sourceDomainInput: string,
): { posts: SwarmPost[]; nodeIsNsfw?: boolean } {
  const sourceDomain = normalizeNodeDomain(sourceDomainInput);
  const parsed = responseSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error('Remote timeline response failed validation');
  }
  if (parsed.data.nodeDomain
    && normalizeNodeDomain(parsed.data.nodeDomain) !== sourceDomain) {
    throw new Error('Remote timeline returned a different node identity');
  }

  for (const post of parsed.data.posts) {
    validatePostOriginAndTime(post, sourceDomain);
    if (post.repostOf) validatePostOriginAndTime(post.repostOf, sourceDomain);
  }

  return {
    posts: parsed.data.posts as SwarmPost[],
    nodeIsNsfw: parsed.data.nodeIsNsfw,
  };
}
