/**
 * Swarm Interactions
 * 
 * Handles direct node-to-node interactions in the swarm network.
 * All interactions are delivered directly via the swarm protocol.
 * 
 * Supported interactions:
 * - Likes: Direct like delivery between swarm nodes
 * - Reposts: Direct repost/boost delivery
 * - Follows: Swarm-native follow relationships
 * - Replies: Already implemented in /api/swarm/replies
 * - Mentions: Direct mention notifications
 */

import { getActiveSwarmNodes } from './registry';
import type { SwarmNodeInfo } from './types';
import { filterBlockedDomains, isNodeBlocked, normalizeNodeDomain } from './node-blocklist';
import { serializeLinkPreviewMedia } from '@/lib/media/linkPreview';

// ============================================
// TYPES
// ============================================

export interface SwarmInteraction {
  type: 'like' | 'unlike' | 'repost' | 'unrepost' | 'follow' | 'unfollow' | 'mention';
  // The actor performing the action
  actor: {
    handle: string;
    displayName: string;
    avatarUrl?: string;
    nodeDomain: string;
  };
  // The target of the action
  target: {
    // For likes/reposts: the post ID and author
    postId?: string;
    postAuthorHandle?: string;
    // For follows: the user being followed
    userHandle?: string;
    // For mentions: the mentioned user and post context
    mentionedHandle?: string;
    mentionPostId?: string;
    mentionContent?: string;
  };
  // Metadata
  timestamp: string;
  interactionId: string; // Unique ID for deduplication
}

export interface SwarmInteractionResponse {
  success: boolean;
  message?: string;
  error?: string;
}

export interface SwarmLikePayload {
  postId: string;
  like: {
    actorHandle: string;
    actorDisplayName: string;
    actorAvatarUrl?: string;
    actorNodeDomain: string;
    interactionId: string;
    timestamp: string;
  };
}

export interface SwarmUnlikePayload {
  postId: string;
  unlike: {
    actorHandle: string;
    actorNodeDomain: string;
    interactionId: string;
    timestamp: string;
  };
}

export interface SwarmRepostPayload {
  postId: string;
  repost: {
    actorHandle: string;
    actorDisplayName: string;
    actorAvatarUrl?: string;
    actorNodeDomain: string;
    repostId: string; // The ID of the repost on the actor's node
    interactionId: string;
    timestamp: string;
  };
}

export interface SwarmFollowPayload {
  targetHandle: string;
  follow: {
    followerHandle: string;
    followerDisplayName: string;
    followerAvatarUrl?: string;
    followerBio?: string;
    followerNodeDomain: string;
    interactionId: string;
    timestamp: string;
  };
}

export interface SwarmUnfollowPayload {
  targetHandle: string;
  unfollow: {
    followerHandle: string;
    followerNodeDomain: string;
    interactionId: string;
    timestamp: string;
  };
}

export interface SwarmUnrepostPayload {
  postId: string;
  unrepost: {
    actorHandle: string;
    actorNodeDomain: string;
    interactionId: string;
    timestamp: string;
  };
}

export interface SwarmMentionPayload {
  mentionedHandle: string;
  mention: {
    actorHandle: string;
    actorDisplayName: string;
    actorAvatarUrl?: string;
    actorNodeDomain: string;
    postId: string;
    postContent: string;
    interactionId: string;
    timestamp: string;
  };
}

// ============================================
// SWARM NODE DETECTION
// ============================================

/**
 * Check if a domain is a known Synapsis swarm node
 */
export async function isSwarmNode(domain: string): Promise<boolean> {
  const normalizedDomain = normalizeNodeDomain(domain);
  if (await isNodeBlocked(normalizedDomain)) {
    return false;
  }
  const nodes = await getActiveSwarmNodes(500);
  return nodes.some(n => n.domain === normalizedDomain);
}

/**
 * Get swarm node info if the domain is a swarm node
 */
export async function getSwarmNodeInfo(domain: string): Promise<SwarmNodeInfo | null> {
  const normalizedDomain = normalizeNodeDomain(domain);
  if (await isNodeBlocked(normalizedDomain)) {
    return null;
  }
  const nodes = await getActiveSwarmNodes(500);
  return nodes.find(n => n.domain === normalizedDomain) || null;
}

/**
 * Extract domain from a handle (e.g., "user@node.example.com" -> "node.example.com")
 */
export function extractDomainFromHandle(handle: string): string | null {
  const clean = handle.toLowerCase().replace(/^@/, '');
  const parts = clean.split('@');
  if (parts.length === 2) {
    return parts[1];
  }
  return null;
}

/**
 * Check if a handle belongs to a swarm node
 */
export async function isSwarmHandle(handle: string): Promise<boolean> {
  const domain = extractDomainFromHandle(handle);
  if (!domain) return false;
  return isSwarmNode(domain);
}

// ============================================
// INTERACTION DELIVERY
// ============================================

/**
 * Deliver a like to a swarm node
 */
export async function deliverSwarmLike(
  targetDomain: string,
  payload: SwarmLikePayload
): Promise<SwarmInteractionResponse> {
  return deliverSwarmInteraction(targetDomain, '/api/swarm/interactions/like', payload);
}

/**
 * Deliver an unlike to a swarm node
 */
export async function deliverSwarmUnlike(
  targetDomain: string,
  payload: SwarmUnlikePayload
): Promise<SwarmInteractionResponse> {
  return deliverSwarmInteraction(targetDomain, '/api/swarm/interactions/unlike', payload);
}

/**
 * Deliver a repost to a swarm node
 */
export async function deliverSwarmRepost(
  targetDomain: string,
  payload: SwarmRepostPayload
): Promise<SwarmInteractionResponse> {
  return deliverSwarmInteraction(targetDomain, '/api/swarm/interactions/repost', payload);
}

/**
 * Deliver a follow to a swarm node
 */
export async function deliverSwarmFollow(
  targetDomain: string,
  payload: SwarmFollowPayload
): Promise<SwarmInteractionResponse> {
  return deliverSwarmInteraction(targetDomain, '/api/swarm/interactions/follow', payload);
}

/**
 * Deliver an unfollow to a swarm node
 */
export async function deliverSwarmUnfollow(
  targetDomain: string,
  payload: SwarmUnfollowPayload
): Promise<SwarmInteractionResponse> {
  return deliverSwarmInteraction(targetDomain, '/api/swarm/interactions/unfollow', payload);
}

/**
 * Deliver an unrepost to a swarm node
 */
export async function deliverSwarmUnrepost(
  targetDomain: string,
  payload: SwarmUnrepostPayload
): Promise<SwarmInteractionResponse> {
  return deliverSwarmInteraction(targetDomain, '/api/swarm/interactions/unrepost', payload);
}

/**
 * Deliver a mention notification to a swarm node
 */
export async function deliverSwarmMention(
  targetDomain: string,
  payload: SwarmMentionPayload
): Promise<SwarmInteractionResponse> {
  return deliverSwarmInteraction(targetDomain, '/api/swarm/interactions/mention', payload);
}

/**
 * Generic interaction delivery with cryptographic signature
 */
async function deliverSwarmInteraction(
  targetDomain: string,
  endpoint: string,
  payload: unknown
): Promise<SwarmInteractionResponse> {
  try {
    const normalizedTargetDomain = normalizeNodeDomain(targetDomain);
    if (await isNodeBlocked(normalizedTargetDomain)) {
      return {
        success: false,
        error: `Blocked node: ${normalizedTargetDomain}`,
      };
    }

    const baseUrl = targetDomain.startsWith('http')
      ? targetDomain
      : normalizedTargetDomain.startsWith('localhost') || normalizedTargetDomain.startsWith('127.0.0.1')
        ? `http://${normalizedTargetDomain}`
        : `https://${normalizedTargetDomain}`;

    const url = `${baseUrl}${endpoint}`;

    // SECURITY: Sign the payload with the node's private key
    const { signPayload, getNodePrivateKey } = await import('./signature');
    const privateKey = await getNodePrivateKey();

    const signature = signPayload(payload, privateKey);
    const signedPayload = { ...payload as object, signature };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000); // 10s timeout

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(signedPayload),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      return {
        success: false,
        error: `HTTP ${response.status}: ${errorText}`,
      };
    }

    const data = await response.json();
    return {
      success: true,
      message: data.message,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}


// ============================================
// PROFILE FETCHING
// ============================================

export interface SwarmUserProfile {
  handle: string;
  displayName: string;
  bio?: string;
  avatarUrl?: string;
  headerUrl?: string;
  website?: string;
  followersCount: number;
  followingCount: number;
  postsCount: number;
  createdAt: string;
  isBot?: boolean;
  botOwnerHandle?: string; // Handle of the bot's owner (e.g., "user" or "user@domain")
  nodeDomain: string;
  chatPublicKey?: string;
  publicKey?: string;
  did?: string;
}

export interface SwarmUserPost {
  id: string;
  originalPostId?: string;
  content: string;
  createdAt: string;
  isNsfw: boolean;
  likesCount: number;
  repostsCount: number;
  repliesCount: number;
  nodeDomain?: string;
  author?: {
    handle: string;
    displayName?: string;
    avatarUrl?: string;
    isBot?: boolean;
    nodeDomain?: string;
  };
  media?: { url: string; mimeType?: string; altText?: string }[];
  linkPreviewUrl?: string;
  linkPreviewTitle?: string;
  linkPreviewDescription?: string;
  linkPreviewImage?: string;
  linkPreviewType?: 'card' | 'image' | 'gallery' | 'video';
  linkPreviewVideoUrl?: string;
  linkPreviewMedia?: Array<{ url: string; width?: number | null; height?: number | null; mimeType?: string | null }>;
  repostOfId?: string;
  repostOf?: SwarmUserPost | null;
}

export interface SwarmProfileResponse {
  profile: SwarmUserProfile;
  posts: SwarmUserPost[];
  nodeDomain: string;
  timestamp: string;
}

/**
 * Fetch a user profile from a swarm node
 */
export async function fetchSwarmUserProfile(
  handle: string,
  domain: string,
  postsLimit: number = 25
): Promise<SwarmProfileResponse | null> {
  try {
    const normalizedDomain = normalizeNodeDomain(domain);
    if (await isNodeBlocked(normalizedDomain)) {
      return null;
    }

    const baseUrl = domain.startsWith('http')
      ? domain
      : normalizedDomain.startsWith('localhost') || normalizedDomain.startsWith('127.0.0.1')
        ? `http://${normalizedDomain}`
        : `https://${normalizedDomain}`;

    const url = `${baseUrl}/api/swarm/users/${handle}?limit=${postsLimit}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      return null;
    }

    return await response.json();
  } catch (error) {
    console.error(`[Swarm] Failed to fetch profile for ${handle}@${domain}:`, error);
    return null;
  }
}

/**
 * Cache swarm user posts in the remotePosts table
 * Similar to cacheRemoteUserPosts but for swarm nodes
 */
export async function cacheSwarmUserPosts(
  handle: string,
  domain: string,
  fullHandle: string, // e.g., "user@domain.com"
  limit: number = 20
): Promise<{ cached: number; skipped: number }> {
  try {
    const profileData = await fetchSwarmUserProfile(handle, domain, limit);

    if (!profileData || !profileData.posts) {
      return { cached: 0, skipped: 0 };
    }

    const { db, remotePosts } = await import('@/db');
    const { eq } = await import('drizzle-orm');

    if (!db) {
      return { cached: 0, skipped: 0 };
    }

    let cached = 0;
    let skipped = 0;

    const actorUrl = `swarm://${domain}/${handle}`;
    const profile = profileData.profile;

    for (const post of profileData.posts) {
      // Generate a unique AP-style ID for the post
      const apId = `swarm://${domain}/posts/${post.id}`;

      // Check if we already have this post
      const existing = await db.query.remotePosts.findFirst({
        where: eq(remotePosts.apId, apId),
      });

      if (existing) {
        skipped++;
        continue;
      }

      // Cache the post
      await db.insert(remotePosts).values({
        apId,
        authorHandle: fullHandle,
        authorActorUrl: actorUrl,
        authorDisplayName: profile.displayName || handle,
        authorAvatarUrl: profile.avatarUrl || null,
        content: post.content,
        publishedAt: new Date(post.createdAt),
        linkPreviewUrl: post.linkPreviewUrl || null,
        linkPreviewTitle: post.linkPreviewTitle || null,
        linkPreviewDescription: post.linkPreviewDescription || null,
        linkPreviewImage: post.linkPreviewImage || null,
        linkPreviewType: post.linkPreviewType || null,
        linkPreviewVideoUrl: post.linkPreviewVideoUrl || null,
        linkPreviewMediaJson: serializeLinkPreviewMedia(post.linkPreviewMedia),
        mediaJson: post.media ? JSON.stringify(post.media) : null,
      });

      cached++;
    }

    return { cached, skipped };
  } catch (error) {
    console.error(`[Swarm] Error caching posts for ${fullHandle}:`, error);
    return { cached: 0, skipped: 0 };
  }
}

/**
 * Fetch a single post from a swarm node
 */
export async function fetchSwarmPost(
  postId: string,
  domain: string
): Promise<SwarmUserPost | null> {
  try {
    const normalizedDomain = normalizeNodeDomain(domain);
    if (await isNodeBlocked(normalizedDomain)) {
      return null;
    }

    const baseUrl = domain.startsWith('http')
      ? domain
      : normalizedDomain.startsWith('localhost') || normalizedDomain.startsWith('127.0.0.1')
        ? `http://${normalizedDomain}`
        : `https://${normalizedDomain}`;

    const url = `${baseUrl}/api/swarm/posts/${postId}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      return null;
    }

    return await response.json();
  } catch (error) {
    console.error(`[Swarm] Failed to fetch post ${postId} from ${domain}:`, error);
    return null;
  }
}

// ============================================
// MENTION DETECTION & DELIVERY
// ============================================

/**
 * Extract mentions from post content
 * Returns array of { handle, domain } for remote mentions
 */
export function extractMentions(content: string): { handle: string; domain: string | null }[] {
  // Match @handle or @handle@domain patterns
  const mentionRegex = /@([a-zA-Z0-9_]+)(?:@([a-zA-Z0-9.-]+))?/g;
  const mentions: { handle: string; domain: string | null }[] = [];

  let match;
  while ((match = mentionRegex.exec(content)) !== null) {
    mentions.push({
      handle: match[1].toLowerCase(),
      domain: match[2]?.toLowerCase() || null,
    });
  }

  return mentions;
}

/**
 * Deliver mention notifications to swarm nodes
 */
export async function deliverSwarmMentions(
  content: string,
  postId: string,
  actor: {
    handle: string;
    displayName: string;
    avatarUrl?: string;
    nodeDomain: string;
  }
): Promise<{ delivered: number; failed: number }> {
  const mentions = extractMentions(content);
  let delivered = 0;
  let failed = 0;

  for (const mention of mentions) {
    // Skip local mentions (no domain)
    if (!mention.domain) continue;

    // Check if it's a swarm node
    const isSwarm = await isSwarmNode(mention.domain);
    if (!isSwarm) continue;

    // Deliver the mention
    const result = await deliverSwarmMention(mention.domain, {
      mentionedHandle: mention.handle,
      mention: {
        actorHandle: actor.handle,
        actorDisplayName: actor.displayName,
        actorAvatarUrl: actor.avatarUrl,
        actorNodeDomain: actor.nodeDomain,
        postId,
        postContent: content,
        interactionId: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
      },
    });

    if (result.success) {
      delivered++;
    } else {
      failed++;
    }
  }

  return { delivered, failed };
}


// ============================================
// POST DELIVERY TO SWARM FOLLOWERS
// ============================================

export interface SwarmPostDeliveryPayload {
  post: {
    id: string;
    content: string;
    createdAt: string;
    isNsfw: boolean;
    replyToId?: string;
    repostOfId?: string;
    media?: { url: string; mimeType?: string; altText?: string }[];
    linkPreviewUrl?: string;
    linkPreviewTitle?: string;
    linkPreviewDescription?: string;
    linkPreviewImage?: string;
    linkPreviewType?: 'card' | 'image' | 'gallery' | 'video';
    linkPreviewVideoUrl?: string;
    linkPreviewMedia?: Array<{ url: string; width?: number | null; height?: number | null; mimeType?: string | null }>;
  };
  author: {
    handle: string;
    displayName: string;
    avatarUrl?: string;
    isNsfw: boolean;
  };
  nodeDomain: string;
  timestamp: string;
}

/**
 * Deliver a new post to a swarm node's inbox
 * This is used to push posts to followers on other swarm nodes
 */
export async function deliverSwarmPost(
  targetDomain: string,
  payload: SwarmPostDeliveryPayload
): Promise<SwarmInteractionResponse> {
  return deliverSwarmInteraction(targetDomain, '/api/swarm/inbox', payload);
}

/**
 * Get swarm follower domains from remote followers
 * Returns domains of swarm nodes that have followers for this user
 */
export async function getSwarmFollowerDomains(userId: string): Promise<string[]> {
  try {
    const { db, remoteFollowers } = await import('@/db');
    const { eq } = await import('drizzle-orm');

    if (!db) return [];

    const followers = await db.query.remoteFollowers.findMany({
      where: eq(remoteFollowers.userId, userId),
    });

    // Filter for swarm followers (actorUrl starts with swarm://)
    const swarmFollowers = followers.filter(f => f.actorUrl.startsWith('swarm://'));

    // Extract unique domains
    const domains = swarmFollowers.map(f => {
      const match = f.actorUrl.match(/^swarm:\/\/([^\/]+)/);
      return match ? match[1] : null;
    }).filter((d): d is string => d !== null);

    return await filterBlockedDomains([...new Set(domains)]);
  } catch (error) {
    console.error('[Swarm] Error getting swarm follower domains:', error);
    return [];
  }
}

/**
 * Deliver a post to all swarm followers
 */
export async function deliverPostToSwarmFollowers(
  userId: string,
  post: {
    id: string;
    content: string;
    createdAt: Date;
    isNsfw: boolean;
    replyToId?: string | null;
    repostOfId?: string | null;
    linkPreviewUrl?: string | null;
    linkPreviewTitle?: string | null;
    linkPreviewDescription?: string | null;
    linkPreviewImage?: string | null;
    linkPreviewType?: string | null;
    linkPreviewVideoUrl?: string | null;
    linkPreviewMedia?: Array<{ url: string; width?: number | null; height?: number | null; mimeType?: string | null }> | null;
  },
  author: {
    handle: string;
    displayName: string | null;
    avatarUrl: string | null;
    isNsfw: boolean;
  },
  media: { url: string; mimeType: string | null; altText: string | null }[],
  nodeDomain: string
): Promise<{ delivered: number; failed: number }> {
  const swarmDomains = await getSwarmFollowerDomains(userId);

  if (swarmDomains.length === 0) {
    return { delivered: 0, failed: 0 };
  }

  const payload: SwarmPostDeliveryPayload = {
    post: {
      id: post.id,
      content: post.content,
      createdAt: post.createdAt.toISOString(),
      isNsfw: post.isNsfw,
      replyToId: post.replyToId || undefined,
      repostOfId: post.repostOfId || undefined,
      media: media.length > 0 ? media.map(m => ({
        url: m.url,
        mimeType: m.mimeType || undefined,
        altText: m.altText || undefined,
      })) : undefined,
      linkPreviewUrl: post.linkPreviewUrl || undefined,
      linkPreviewTitle: post.linkPreviewTitle || undefined,
      linkPreviewDescription: post.linkPreviewDescription || undefined,
      linkPreviewImage: post.linkPreviewImage || undefined,
      linkPreviewType: (post.linkPreviewType as SwarmPostDeliveryPayload['post']['linkPreviewType']) || undefined,
      linkPreviewVideoUrl: post.linkPreviewVideoUrl || undefined,
      linkPreviewMedia: post.linkPreviewMedia || undefined,
    },
    author: {
      handle: author.handle,
      displayName: author.displayName || author.handle,
      avatarUrl: author.avatarUrl || undefined,
      isNsfw: author.isNsfw,
    },
    nodeDomain,
    timestamp: new Date().toISOString(),
  };

  let delivered = 0;
  let failed = 0;

  // Deliver to all swarm domains in parallel
  const results = await Promise.allSettled(
    swarmDomains.map(domain => deliverSwarmPost(domain, payload))
  );

  for (const result of results) {
    if (result.status === 'fulfilled' && result.value.success) {
      delivered++;
    } else {
      failed++;
    }
  }

  return { delivered, failed };
}
