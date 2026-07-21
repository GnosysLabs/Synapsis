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

import { getActiveSwarmNode, getKnownSwarmNodeNsfw } from './registry';
import type { SwarmNodeInfo } from './types';
import { isNodeBlocked, normalizeNodeDomain } from './node-blocklist';
import { getPublicSwarmDomain } from './node-domain';
import { signedFederationRead } from './signed-read';
import { serializeLinkPreviewMedia } from '@/lib/media/linkPreview';
import { parseMentions } from '@/lib/mentions/parser';
import { safeFederationRequest } from './safe-federation-http';
import type { FederatedUserAction } from './federated-action';
import {
  createFederationActionContext,
  LEGACY_FEDERATED_ACTION_PROTOCOL,
} from './federated-action';
import {
  applyAuthenticatedProfileNodeClassification,
  parseRemotePostDetailResponse,
  parseRemoteProfileResponse,
  type RemoteSwarmPost,
  type RemoteSwarmProfile,
  type RemoteSwarmProfileResponse,
  verifyRemoteProfilePresentation,
} from './remote-post-payload';
import type { SwarmPost } from '@/app/api/swarm/timeline/route';
import type { StuffboxBadge } from '@/lib/types';
import { indexRemotePostContent } from '@/lib/search/post-index';
import {
  clearRemoteNodeAccessDenied,
  isRemoteNodeAccessDenied,
  isRemoteNodeBlockResponse,
  markRemoteNodeAccessDenied,
  NODE_BLOCKED_CODE,
} from './remote-access';
import {
  parseAccountAddress,
  resolveAccountAddress,
} from '@/lib/identity/account-address';
import { refreshPinnedRemoteUserPresentation } from './user-cache';

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
  statusCode?: number;
  retryable?: boolean;
  code?: string;
}

export interface SwarmLikePayload {
  userAction: FederatedUserAction;
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
  userAction: FederatedUserAction;
  postId: string;
  unlike: {
    actorHandle: string;
    actorNodeDomain: string;
    interactionId: string;
    timestamp: string;
  };
}

export interface SwarmRepostPayload {
  userAction: FederatedUserAction;
  postId: string;
  repost: {
    actorHandle: string;
    actorDisplayName: string;
    actorAvatarUrl?: string;
    actorIsNsfw?: boolean;
    actorNodeDomain: string;
    repostId: string; // The ID of the repost on the actor's node
    interactionId: string;
    timestamp: string;
  };
}

export interface SwarmFollowPayload {
  userAction: FederatedUserAction;
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
  userAction: FederatedUserAction;
  targetHandle: string;
  unfollow: {
    followerHandle: string;
    followerNodeDomain: string;
    interactionId: string;
    timestamp: string;
  };
}

export interface SwarmUnrepostPayload {
  userAction: FederatedUserAction;
  postId: string;
  unrepost: {
    actorHandle: string;
    actorNodeDomain: string;
    interactionId: string;
    timestamp: string;
  };
}

export interface SwarmMentionPayload {
  userAction: FederatedUserAction;
  mentionedHandle: string;
  mention: {
    actorHandle: string;
    actorDisplayName: string;
    actorAvatarUrl?: string;
    actorNodeDomain: string;
    actorDid?: string;
    actorPublicKey?: string;
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
  return Boolean(await getActiveSwarmNode(normalizedDomain));
}

/**
 * Get swarm node info if the domain is a swarm node
 */
export async function getSwarmNodeInfo(domain: string): Promise<SwarmNodeInfo | null> {
  const normalizedDomain = normalizeNodeDomain(domain);
  if (await isNodeBlocked(normalizedDomain)) {
    return null;
  }
  return getActiveSwarmNode(normalizedDomain);
}

/**
 * Extract domain from a handle (e.g., "user@node.example.com" -> "node.example.com")
 */
export function extractDomainFromHandle(handle: string): string | null {
  return parseAccountAddress(handle)?.homeDomain ?? null;
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
  payload: object
): Promise<SwarmInteractionResponse> {
  try {
    const normalizedTargetDomain = normalizeNodeDomain(targetDomain);
    if (await isNodeBlocked(normalizedTargetDomain)) {
      return {
        success: false,
        statusCode: 403,
        retryable: false,
        error: `Blocked node: ${normalizedTargetDomain}`,
      };
    }
    if (await isRemoteNodeAccessDenied(normalizedTargetDomain)) {
      return {
        success: false,
        statusCode: 403,
        retryable: false,
        code: NODE_BLOCKED_CODE,
        error: `The origin ${normalizedTargetDomain} has blocked federation access from this node`,
      };
    }

    const baseUrl = targetDomain.startsWith('http')
      ? targetDomain
      : normalizedTargetDomain.startsWith('localhost') || normalizedTargetDomain.startsWith('127.0.0.1')
        ? `http://${normalizedTargetDomain}`
        : `https://${normalizedTargetDomain}`;

    const url = `${baseUrl}${endpoint}`;

    // Bind every node signature to the exact protocol, destination, method,
    // and route. State-changing receivers additionally require `userAction`.
    const legacySignedHandle = 'userAction' in payload
      && typeof payload.userAction === 'object'
      && payload.userAction !== null
      && 'handle' in payload.userAction
      && typeof payload.userAction.handle === 'string'
      && !parseAccountAddress(payload.userAction.handle);
    const authorizedPayload = {
      ...payload,
      federation: createFederationActionContext({
        destinationDomain: normalizedTargetDomain,
        method: 'POST',
        path: endpoint,
        // A queued historical user action cannot be rewritten without
        // invalidating its signature. Carry it in the v2 compatibility
        // envelope; all newly signed canonical actions emit v3.
        protocol: legacySignedHandle ? LEGACY_FEDERATED_ACTION_PROTOCOL : undefined,
      }),
    };

    // SECURITY: Sign the complete destination-bound envelope with the node key.
    const { signPayload, getNodePrivateKey } = await import('./signature');
    const privateKey = await getNodePrivateKey();

    const signature = signPayload(authorizedPayload, privateKey);
    const signedPayload = { ...authorizedPayload, signature };

    const response = await safeFederationRequest(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(signedPayload),
      timeoutMs: 8_000,
      maxResponseBytes: 256 * 1024,
    });

    if (response.status < 200 || response.status >= 300) {
      const errorText = response.text();
      const remotelyBlocked = isRemoteNodeBlockResponse(response);
      if (remotelyBlocked) {
        await markRemoteNodeAccessDenied(normalizedTargetDomain);
      }
      return {
        success: false,
        statusCode: response.status,
        retryable: response.status === 408 || response.status === 429 || response.status >= 500,
        ...(remotelyBlocked ? { code: NODE_BLOCKED_CODE } : {}),
        error: `HTTP ${response.status}: ${errorText}`,
      };
    }

    await clearRemoteNodeAccessDenied(normalizedTargetDomain);
    const data = response.json() as { message?: string };
    return {
      success: true,
      message: data.message,
    };
  } catch (error) {
    return {
      success: false,
      retryable: true,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}


// ============================================
// PROFILE FETCHING
// ============================================

export type SwarmUserProfile = RemoteSwarmProfile;
export type SwarmUserPost = RemoteSwarmPost;
export type SwarmProfileResponse = RemoteSwarmProfileResponse;

const DEVELOPMENT_LOOPBACK_DOMAIN =
  /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i;

/**
 * Fetch a user profile from a swarm node
 */
export async function fetchSwarmUserProfile(
  handle: string,
  domain: string,
  postsLimit: number = 25,
  cursor?: string,
  timeoutMs?: number,
): Promise<SwarmProfileResponse | null> {
  try {
    const normalizedDomain = normalizeNodeDomain(domain);
    const publicDomain = getPublicSwarmDomain(normalizedDomain);
    const developmentDomain =
      process.env.NODE_ENV === 'development' &&
      DEVELOPMENT_LOOPBACK_DOMAIN.test(normalizedDomain)
        ? normalizedDomain
        : null;
    const targetDomain = publicDomain ?? developmentDomain;
    const address = resolveAccountAddress(handle, targetDomain);

    if (
      !targetDomain ||
      !address ||
      address.homeDomain !== targetDomain ||
      (await isNodeBlocked(targetDomain)) ||
      (await isRemoteNodeAccessDenied(targetDomain))
    ) {
      return null;
    }

    const baseUrl = developmentDomain
      ? `http://${targetDomain}`
      : `https://${targetDomain}`;
    const url = new URL(`/api/swarm/users/${encodeURIComponent(address.username)}`, baseUrl);
    url.searchParams.set(
      'limit',
      String(Number.isSafeInteger(postsLimit) ? Math.min(Math.max(postsLimit, 0), 50) : 25)
    );
    if (cursor) url.searchParams.set('cursor', cursor.slice(0, 128));

    const response = await signedFederationRead(url.toString(), {
      headers: { 'Accept': 'application/json' },
      ...(timeoutMs ? { timeoutMs } : {}),
      maxResponseBytes: 1024 * 1024,
    });

    if (response.status < 200 || response.status >= 300) {
      return null;
    }

    const effectivePostsLimit = Number.isSafeInteger(postsLimit)
      ? Math.min(Math.max(postsLimit, 0), 50)
      : 25;
    const parsedPayload = parseRemoteProfileResponse(
      response.json(),
      targetDomain,
      address.username,
      effectivePostsLimit,
    );
    const payload = {
      ...parsedPayload,
      profile: await verifyRemoteProfilePresentation(parsedPayload.profile),
    };
    const { verifyStuffboxBadgeAttestation, verifyStuffboxBadgeOnPost } = await import('@/lib/stuffbox/badge');
    const profileBadge = payload.profile.stuffboxBadge?.attestation
      ? await verifyStuffboxBadgeAttestation(
          payload.profile.stuffboxBadge.attestation,
          payload.profile.handle,
        )
      : null;
    const verifiedPayload = {
      ...payload,
      profile: { ...payload.profile, stuffboxBadge: profileBadge },
      posts: await Promise.all(payload.posts.map((post) => verifyStuffboxBadgeOnPost(post))),
    };

    if (verifiedPayload.profile.profilePresentationVerified) {
      try {
        await refreshPinnedRemoteUserPresentation({
          handle: verifiedPayload.profile.handle,
          displayName: verifiedPayload.profile.displayName,
          avatarUrl: verifiedPayload.profile.avatarUrl ?? null,
          bio: verifiedPayload.profile.bio ?? null,
          headerUrl: verifiedPayload.profile.headerUrl ?? null,
          website: verifiedPayload.profile.website ?? null,
          did: verifiedPayload.profile.did,
          publicKey: verifiedPayload.profile.publicKey,
          isNsfw: verifiedPayload.profile.isNsfw,
          profileDocument: verifiedPayload.profile.profileDocument,
          stuffboxBadge: verifiedPayload.profile.stuffboxBadge as StuffboxBadge | null | undefined,
        });
      } catch (cacheError) {
        // A valid live response remains usable if the optional local cache is
        // busy. Its version will be reconsidered on the next profile read.
        console.warn(`[Swarm] Could not cache signed profile for ${handle}:`, cacheError);
      }
    }

    const knownNodeIsNsfw = await getKnownSwarmNodeNsfw(normalizedDomain);
    if (knownNodeIsNsfw === true && verifiedPayload.profile.nodeIsNsfw !== true) {
      return {
        ...verifiedPayload,
        profile: { ...verifiedPayload.profile, nodeIsNsfw: true },
        posts: verifiedPayload.posts.map((post) => ({
          ...post,
          isNsfw: true,
          author: post.author ? { ...post.author, nodeIsNsfw: true } : post.author,
        })),
      };
    }

    return verifiedPayload;
  } catch (error) {
    console.error(`[Swarm] Failed to fetch profile for ${handle}:`, error);
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
): Promise<{ cached: number; skipped: number; success: boolean }> {
  try {
    const canonicalDomain = getPublicSwarmDomain(domain) ?? normalizeNodeDomain(domain);
    const address = resolveAccountAddress(fullHandle || handle, canonicalDomain);
    if (!address || address.homeDomain !== canonicalDomain) {
      return { cached: 0, skipped: 0, success: false };
    }
    const profileData = await fetchSwarmUserProfile(address.canonical, domain, limit);

    if (!profileData || !profileData.posts) {
      return { cached: 0, skipped: 0, success: false };
    }

    const { db, remotePosts } = await import('@/db');

    if (!db) {
      return { cached: 0, skipped: 0, success: false };
    }

    let cached = 0;
    const skipped = 0;

    const actorUrl = `swarm://${domain}/${address.username}`;
    const profile = profileData.profile;

    // The fair background profile scheduler also powers notification actor
    // presentation. Keep the verified user cache current even when this
    // account has no new posts to materialize.
    await refreshPinnedRemoteUserPresentation({
      handle: address.canonical,
      displayName: profile.displayName,
      avatarUrl: profile.avatarUrl ?? null,
      bio: profile.bio ?? null,
      headerUrl: profile.headerUrl ?? null,
      website: profile.website ?? null,
      did: profile.did,
      publicKey: profile.publicKey,
      isNsfw: profile.isNsfw,
      profileDocument: profile.profileDocument,
      // fetchSwarmUserProfile verifies and expands the transport proof before
      // it reaches this cache boundary.
      stuffboxBadge: profile.stuffboxBadge as StuffboxBadge | null | undefined,
    });

    const toTimelinePost = (post: RemoteSwarmPost): SwarmPost => ({
      id: post.id,
      content: post.content,
      createdAt: post.createdAt,
      feedActivityAt: post.feedActivityAt,
      isReply: Boolean(post.isReply || post.replyToId || post.swarmReplyToId),
      replyToId: post.replyToId,
      swarmReplyToId: post.swarmReplyToId,
      repostOfId: post.repostOfId,
      repostOf: post.repostOf ? toTimelinePost(post.repostOf) : post.repostOf,
      repostedBy: post.repostedBy?.map((reposter) => ({
        id: reposter.id || `swarm:${domain}:${reposter.handle}`,
        handle: reposter.handle,
        displayName: reposter.displayName || reposter.handle,
        avatarUrl: reposter.avatarUrl || null,
        isNsfw: reposter.isNsfw ?? true,
        nodeIsNsfw: reposter.nodeIsNsfw ?? true,
        nodeDomain: domain,
        isRemote: true,
        isSwarm: true,
        stuffboxBadge: reposter.stuffboxBadge as StuffboxBadge | null | undefined,
      })),
      repostedByCount: post.repostedByCount,
      author: {
        handle: post.author.handle,
        displayName: post.author.displayName || post.author.handle,
        avatarUrl: post.author.avatarUrl || undefined,
        isNsfw: post.author.isNsfw ?? profile.isNsfw,
        nodeIsNsfw: post.author.nodeIsNsfw ?? profile.nodeIsNsfw,
        nodeDomain: normalizeNodeDomain(domain),
        stuffboxBadge: post.author.stuffboxBadge as StuffboxBadge | null | undefined,
      },
      nodeDomain: normalizeNodeDomain(domain),
      nodeIsNsfw: post.nodeIsNsfw ?? profile.nodeIsNsfw,
      isNsfw: post.isNsfw ?? true,
      originUnavailable: post.originUnavailable,
      likeCount: post.likesCount ?? post.likeCount ?? 0,
      repostCount: post.repostsCount ?? post.repostCount ?? 0,
      replyCount: post.repliesCount ?? post.replyCount ?? 0,
      media: post.media?.map((item) => ({
        url: item.url,
        mimeType: item.mimeType || undefined,
        altText: item.altText || undefined,
      })),
      linkPreviewUrl: post.linkPreviewUrl || undefined,
      linkPreviewTitle: post.linkPreviewTitle || undefined,
      linkPreviewDescription: post.linkPreviewDescription || undefined,
      linkPreviewImage: post.linkPreviewImage || undefined,
      linkPreviewType: post.linkPreviewType || undefined,
      linkPreviewVideoUrl: post.linkPreviewVideoUrl || undefined,
      linkPreviewMedia: post.linkPreviewMedia || undefined,
    });

    for (const rawPost of profileData.posts) {
      const post = applyAuthenticatedProfileNodeClassification(rawPost, profile.nodeIsNsfw);
      const apId = `swarm:${canonicalDomain}:${post.id}`;
      const snapshot = toTimelinePost(post);
      const values = {
        apId,
        nodeDomain: canonicalDomain,
        originalPostId: post.id,
        postJson: JSON.stringify(snapshot),
        authorHandle: address.canonical,
        authorActorUrl: actorUrl,
        authorDisplayName: profile.displayName || address.username,
        authorAvatarUrl: profile.avatarUrl || null,
        content: post.content,
        publishedAt: new Date(post.createdAt),
        feedActivityAt: new Date(post.feedActivityAt || post.createdAt),
        isReply: Boolean(post.isReply || post.replyToId || post.swarmReplyToId),
        isNsfw: post.isNsfw ?? true,
        authorIsNsfw: post.author.isNsfw ?? profile.isNsfw,
        nodeIsNsfw: post.nodeIsNsfw ?? profile.nodeIsNsfw,
        likesCount: post.likesCount ?? post.likeCount ?? 0,
        repostsCount: post.repostsCount ?? post.repostCount ?? 0,
        repliesCount: post.repliesCount ?? post.replyCount ?? 0,
        linkPreviewUrl: post.linkPreviewUrl || null,
        linkPreviewTitle: post.linkPreviewTitle || null,
        linkPreviewDescription: post.linkPreviewDescription || null,
        linkPreviewImage: post.linkPreviewImage || null,
        linkPreviewType: post.linkPreviewType || null,
        linkPreviewVideoUrl: post.linkPreviewVideoUrl || null,
        linkPreviewMediaJson: serializeLinkPreviewMedia(post.linkPreviewMedia),
        mediaJson: post.media ? JSON.stringify(post.media) : null,
        fetchedAt: new Date(),
      };
      const [cachedRow] = await db.insert(remotePosts).values(values).onConflictDoUpdate({
        target: [remotePosts.nodeDomain, remotePosts.originalPostId],
        set: values,
      }).returning({ id: remotePosts.id });
      if (cachedRow) await indexRemotePostContent(cachedRow.id, post.content);

      cached++;
    }

    return { cached, skipped, success: true };
  } catch (error) {
    console.error(`[Swarm] Error caching posts for ${fullHandle}:`, error);
    return { cached: 0, skipped: 0, success: false };
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
    if (
      await isNodeBlocked(normalizedDomain)
      || await isRemoteNodeAccessDenied(normalizedDomain)
    ) {
      return null;
    }

    const baseUrl = domain.startsWith('http')
      ? domain
      : normalizedDomain.startsWith('localhost') || normalizedDomain.startsWith('127.0.0.1')
        ? `http://${normalizedDomain}`
        : `https://${normalizedDomain}`;

    const url = `${baseUrl}/api/swarm/posts/${postId}`;

    const response = await signedFederationRead(url, {
      headers: { 'Accept': 'application/json' },
      timeoutMs: 8_000,
      maxResponseBytes: 1024 * 1024,
    });

    if (response.status < 200 || response.status >= 300) {
      return null;
    }

    return parseRemotePostDetailResponse(
      response.json(),
      normalizedDomain,
      postId,
    ).post;
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
  return parseMentions(content).map(({ handle, domain }) => ({ handle, domain }));
}
