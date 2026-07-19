import crypto from 'node:crypto';
import {
  db,
  e2eeRemoteKeyBundles,
  handleRegistry,
  notifications,
  posts as localPosts,
  remoteFollows,
  remoteFollowers,
  remoteLikes,
  remotePosts,
  remoteReposts,
  swarmRelationshipStates,
  userSwarmLikes,
  userSwarmReposts,
  users,
  swarmContentSyncStates,
  swarmNodes,
} from '@/db';
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  lte,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';
import type { SwarmAccountDeletion, SwarmPost } from '@/app/api/swarm/timeline/route';
import { mapWithConcurrency } from '@/lib/async/concurrency';
import { parseRemoteTimelineResponse } from './remote-timeline-payload';
import { signedFederationRead } from './signed-read';
import { SWARM_CONFIG } from './types';
import { normalizeNodeDomain } from './node-domain';
import { markNodeSuccess } from './registry';
import { decodeFeedCursorPosition, type FeedCursorPosition } from '@/lib/posts/feed-pagination';
import { indexRemotePostContent, searchIndexedPostIds } from '@/lib/search/post-index';

const DEFAULT_SYNC_BATCH_SIZE = 8;
const MAX_SYNC_BATCH_SIZE = 64;
const TARGET_FULL_SWEEP_MINUTES = 30;
const SYNC_CONCURRENCY = 4;
const SYNC_LEASE_MS = 45_000;
const SUCCESS_REFRESH_MS = 5 * 60_000;
const FAILURE_BACKOFF_BASE_MS = 60_000;
const FAILURE_BACKOFF_MAX_MS = 60 * 60_000;
const MAX_POSTS_PER_NODE = 250;
const CACHE_RETENTION_MS = 90 * 24 * 60 * 60_000;
const MAX_CACHED_QUERY_ROWS = 400;

export interface CachedTimelineOptions {
  limit?: number;
  cursor?: Date | string | FeedCursorPosition | null;
  includeNsfw?: boolean;
  query?: string;
  excludeDomains?: ReadonlySet<string>;
  authorHandles?: readonly string[];
  followedByUserId?: string;
}

export interface CachedTimelineResult {
  posts: SwarmPost[];
  sources: Array<{ domain: string; postCount: number; isNsfw?: boolean }>;
  fetchedAt: string;
  continuationDate: string | null;
}

export interface ContentSyncResult {
  claimed: number;
  synced: number;
  failed: number;
  cached: number;
  domains: Array<{ domain: string; cached: number; error?: string }>;
}

interface ClaimedPeer {
  domain: string;
  nodeIsNsfw: boolean;
  classificationKnown: boolean;
  highWaterAt: Date | null;
  highWaterId: string | null;
  changeCursor: number | null;
  accountChangeCursor: number | null;
  legacyReconcileCursor: string | null;
  legacyReconcileComplete: boolean;
  leaseOwner: string;
}

function boundedInteger(value: string | undefined, fallback: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? Math.min(parsed, maximum)
    : fallback;
}

function failureDelay(failures: number): number {
  return Math.min(
    FAILURE_BACKOFF_BASE_MS * (2 ** Math.min(Math.max(failures - 1, 0), 8)),
    FAILURE_BACKOFF_MAX_MS,
  );
}

function refreshJitter(domain: string): number {
  const firstWord = crypto.createHash('sha256').update(domain).digest().readUInt32BE(0);
  return firstWord % (2 * 60_000);
}

function normalizedCursor(value: Date | string | FeedCursorPosition | null | undefined): FeedCursorPosition | null {
  if (!value) return null;
  if (typeof value === 'object' && !(value instanceof Date) && 'at' in value) return value;
  if (typeof value === 'string') {
    const decoded = decodeFeedCursorPosition(value);
    if (decoded) return decoded;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : { at: date, id: null };
}

function normalizedAuthorHandles(handles: readonly string[] | undefined): string[] {
  return Array.from(new Set((handles || [])
    .map((handle) => handle.trim().replace(/^@/, '').toLowerCase())
    .filter((handle) => handle.length >= 3 && handle.length <= 640)))
    .slice(0, 5_000);
}

function applyAuthoritativeNodeClassification(
  post: SwarmPost,
  knownNodeIsNsfw: boolean | undefined,
): SwarmPost {
  const effectiveNodeIsNsfw = knownNodeIsNsfw === true || post.nodeIsNsfw === true
    ? true
    : knownNodeIsNsfw === false && post.nodeIsNsfw === false
      ? false
      : undefined;
  return {
    ...post,
    nodeIsNsfw: effectiveNodeIsNsfw as boolean,
    repostOf: post.repostOf
      ? applyAuthoritativeNodeClassification(post.repostOf, effectiveNodeIsNsfw)
      : post.repostOf,
  };
}

/** Insert scheduling rows in one indexed statement; existing leases survive. */
export async function seedSwarmContentSyncStates(
  database: Pick<typeof db, 'run'> = db,
): Promise<void> {
  await database.run(sql`
    insert into ${swarmContentSyncStates} (${sql.identifier('domain')})
    select ${swarmNodes.domain}
    from ${swarmNodes}
    where ${swarmNodes.isActive} = 1
      and ${swarmNodes.isBlocked} = 0
      and ${swarmNodes.nsfwClassificationKnown} = 1
      and ${swarmNodes.publicKey} is not null
      and ${swarmNodes.discoveredVia} in ('direct', 'announcement')
    on conflict (${sql.identifier('domain')}) do nothing
  `);
}

async function claimDuePeers(batchSize: number): Promise<ClaimedPeer[]> {
  await seedSwarmContentSyncStates();
  const now = new Date();
  const candidates = await db.select({
    domain: swarmContentSyncStates.domain,
    nodeIsNsfw: swarmNodes.isNsfw,
    classificationKnown: swarmNodes.nsfwClassificationKnown,
    highWaterAt: swarmContentSyncStates.highWaterAt,
    highWaterId: swarmContentSyncStates.highWaterId,
    changeCursor: swarmContentSyncStates.changeCursor,
    accountChangeCursor: swarmContentSyncStates.accountChangeCursor,
    legacyReconcileCursor: swarmContentSyncStates.legacyReconcileCursor,
    legacyReconcileComplete: swarmContentSyncStates.legacyReconcileComplete,
  })
    .from(swarmContentSyncStates)
    .innerJoin(swarmNodes, eq(swarmNodes.domain, swarmContentSyncStates.domain))
    .where(and(
      eq(swarmNodes.isActive, true),
      eq(swarmNodes.isBlocked, false),
      eq(swarmNodes.nsfwClassificationKnown, true),
      sql`${swarmNodes.publicKey} is not null`,
      sql`${swarmNodes.discoveredVia} in ('direct', 'announcement')`,
      lte(swarmContentSyncStates.nextAttemptAt, now),
      or(
        isNull(swarmContentSyncStates.leaseExpiresAt),
        lte(swarmContentSyncStates.leaseExpiresAt, now),
      ),
    ))
    .orderBy(
      asc(swarmContentSyncStates.lastSuccessAt),
      asc(swarmContentSyncStates.nextAttemptAt),
      asc(swarmContentSyncStates.domain),
    )
    .limit(batchSize * 3);

  const claimed: ClaimedPeer[] = [];
  for (const candidate of candidates) {
    if (claimed.length >= batchSize) break;
    const leaseOwner = crypto.randomUUID();
    const [row] = await db.update(swarmContentSyncStates)
      .set({
        leaseOwner,
        leaseExpiresAt: new Date(Date.now() + SYNC_LEASE_MS),
        lastAttemptAt: now,
        updatedAt: now,
      })
      .where(and(
        eq(swarmContentSyncStates.domain, candidate.domain),
        lte(swarmContentSyncStates.nextAttemptAt, now),
        or(
          isNull(swarmContentSyncStates.leaseExpiresAt),
          lte(swarmContentSyncStates.leaseExpiresAt, now),
        ),
      ))
      .returning({ domain: swarmContentSyncStates.domain });
    if (row) claimed.push({ ...candidate, leaseOwner });
  }
  return claimed;
}

async function cacheValidatedPosts(
  domain: string,
  posts: SwarmPost[],
  knownNodeIsNsfw: boolean | undefined,
): Promise<number> {
  const now = new Date();
  for (const rawPost of posts) {
    const post = applyAuthoritativeNodeClassification(rawPost, knownNodeIsNsfw);
    const apId = `swarm:${domain}:${post.id}`;
    const feedActivityAt = new Date(post.feedActivityAt || post.createdAt);
    const authorHandle = `${post.author.handle}@${domain}`.toLowerCase();
    const values = {
      apId,
      nodeDomain: domain,
      originalPostId: post.id,
      postJson: JSON.stringify(post),
      authorHandle,
      authorActorUrl: `swarm://${domain}/${post.author.handle}`,
      authorDisplayName: post.author.displayName,
      authorAvatarUrl: post.author.avatarUrl || null,
      content: post.content,
      publishedAt: new Date(post.createdAt),
      feedActivityAt,
      isReply: Boolean(post.isReply || post.replyToId || post.swarmReplyToId),
      isNsfw: typeof post.isNsfw === 'boolean' ? post.isNsfw : null,
      authorIsNsfw: typeof post.author.isNsfw === 'boolean' ? post.author.isNsfw : null,
      nodeIsNsfw: typeof post.nodeIsNsfw === 'boolean' ? post.nodeIsNsfw : null,
      likesCount: post.likeCount,
      repostsCount: post.repostCount,
      repliesCount: post.replyCount,
      linkPreviewUrl: post.linkPreviewUrl || null,
      linkPreviewTitle: post.linkPreviewTitle || null,
      linkPreviewDescription: post.linkPreviewDescription || null,
      linkPreviewImage: post.linkPreviewImage || null,
      linkPreviewType: post.linkPreviewType || null,
      linkPreviewVideoUrl: post.linkPreviewVideoUrl || null,
      linkPreviewMediaJson: post.linkPreviewMedia ? JSON.stringify(post.linkPreviewMedia) : null,
      mediaJson: post.media ? JSON.stringify(post.media) : null,
      fetchedAt: now,
    };
    const [cachedRow] = await db.insert(remotePosts).values(values)
      .onConflictDoUpdate({
        target: [remotePosts.nodeDomain, remotePosts.originalPostId],
        set: values,
      }).returning({ id: remotePosts.id });
    if (cachedRow) await indexRemotePostContent(cachedRow.id, post.content);
  }

  const overflow = await db.select({ id: remotePosts.id })
    .from(remotePosts)
    .where(eq(remotePosts.nodeDomain, domain))
    .orderBy(desc(remotePosts.feedActivityAt), desc(remotePosts.id))
    .limit(100)
    .offset(MAX_POSTS_PER_NODE);
  if (overflow.length > 0) {
    await db.delete(remotePosts).where(inArray(remotePosts.id, overflow.map((row) => row.id)));
  }
  return posts.length;
}

async function finishPeerSync(
  peer: ClaimedPeer,
  outcome: {
    success: true;
    highWaterAt: Date | null;
    highWaterId: string | null;
    changeCursor: number;
    accountChangeCursor: number | null;
    legacyReconcileCursor: string | null;
    legacyReconcileComplete: boolean;
    hasMore: boolean;
  } | { success: false; error: string },
): Promise<void> {
  const now = new Date();
  const current = await db.query.swarmContentSyncStates.findFirst({
    where: { AND: [{ domain: peer.domain }, { leaseOwner: peer.leaseOwner }] },
  });
  if (!current) return;

  const failures = outcome.success ? 0 : current.failures + 1;
  await db.update(swarmContentSyncStates).set({
    failures,
    nextAttemptAt: new Date(Date.now() + (outcome.success
      ? outcome.hasMore ? 0 : SUCCESS_REFRESH_MS + refreshJitter(peer.domain)
      : failureDelay(failures))),
    lastSuccessAt: outcome.success ? now : current.lastSuccessAt,
    highWaterAt: outcome.success
      ? outcome.highWaterAt ?? current.highWaterAt
      : current.highWaterAt,
    highWaterId: outcome.success
      ? outcome.highWaterId ?? current.highWaterId
      : current.highWaterId,
    changeCursor: outcome.success ? outcome.changeCursor : current.changeCursor,
    accountChangeCursor: outcome.success
      ? outcome.accountChangeCursor ?? current.accountChangeCursor
      : current.accountChangeCursor,
    legacyReconcileCursor: outcome.success
      ? outcome.legacyReconcileCursor ?? current.legacyReconcileCursor
      : current.legacyReconcileCursor,
    legacyReconcileComplete: outcome.success
      ? outcome.legacyReconcileComplete
      : current.legacyReconcileComplete,
    leaseOwner: null,
    leaseExpiresAt: null,
    lastError: outcome.success ? null : outcome.error.slice(0, 1_000),
    updatedAt: now,
  }).where(and(
    eq(swarmContentSyncStates.domain, peer.domain),
    eq(swarmContentSyncStates.leaseOwner, peer.leaseOwner),
  ));
}

export async function applyRemotePostDeletions(
  domainInput: string,
  postIds: string[],
  database: typeof db = db,
): Promise<void> {
  const domain = normalizeNodeDomain(domainInput);
  const deletedPostIds = Array.from(new Set(postIds)).slice(0, 50);
  if (deletedPostIds.length === 0) return;

  const deletedSwarmIds = deletedPostIds.map((postId) => `swarm:${domain}:${postId}`);
  const repostOwners = await database.select({
    userId: userSwarmReposts.userId,
    count: sql<number>`count(*)`,
  }).from(userSwarmReposts).where(and(
    eq(userSwarmReposts.nodeDomain, domain),
    inArray(userSwarmReposts.originalPostId, deletedPostIds),
  )).groupBy(userSwarmReposts.userId);

  await database.transaction(async (tx) => {
    await tx.delete(remotePosts).where(and(
      eq(remotePosts.nodeDomain, domain),
      inArray(remotePosts.originalPostId, deletedPostIds),
    ));
    await tx.delete(userSwarmLikes).where(and(
      eq(userSwarmLikes.nodeDomain, domain),
      inArray(userSwarmLikes.originalPostId, deletedPostIds),
    ));
    await tx.delete(userSwarmReposts).where(and(
      eq(userSwarmReposts.nodeDomain, domain),
      inArray(userSwarmReposts.originalPostId, deletedPostIds),
    ));
    await tx.update(localPosts).set({
      swarmReplyToContent: null,
      swarmReplyToAuthor: null,
    }).where(inArray(localPosts.swarmReplyToId, deletedSwarmIds));
    await tx.update(notifications).set({
      postContent: null,
    }).where(and(
      eq(notifications.remotePostDomain, domain),
      inArray(notifications.remotePostId, deletedPostIds),
    ));
    for (const owner of repostOwners) {
      await tx.update(users).set({
        postsCount: sql`max(0, ${users.postsCount} - ${Number(owner.count || 0)})`,
      }).where(eq(users.id, owner.userId));
    }
  });
}

/**
 * Apply exact-origin account tombstones to every mutable local projection.
 * The handle-to-DID tombstone remains permanently, so an origin cannot delete
 * an identity and later smuggle a different DID into the same handle.
 */
export async function applyRemoteAccountDeletions(
  domainInput: string,
  changes: SwarmAccountDeletion[],
  database: typeof db = db,
): Promise<number> {
  const domain = normalizeNodeDomain(domainInput);
  let applied = 0;

  for (const change of changes) {
    const bareHandle = change.handle.toLowerCase();
    const qualifiedHandle = `${bareHandle}@${domain}`;
    const actorUrl = `swarm://${domain}/${bareHandle}`;
    const deletedAt = new Date(change.deletedAt);

    const didOwner = await database.query.handleRegistry.findFirst({
      where: { AND: [
        { nodeDomain: domain },
        { did: change.did },
        { identityVerified: true },
      ] },
    });
    const handleOwner = await database.query.handleRegistry.findFirst({
      where: { handle: qualifiedHandle },
    });
    const [cachedRemoteUser] = await database.select({ id: users.id })
      .from(users)
      .where(and(eq(users.handle, qualifiedHandle), eq(users.did, change.did)))
      .limit(1);
    if ((didOwner && didOwner.handle !== qualifiedHandle)
      || (handleOwner?.identityVerified && handleOwner.did !== change.did)) {
      console.warn(`[Swarm] Rejected conflicting account tombstone for ${qualifiedHandle}`);
      continue;
    }

    await database.transaction(async (tx) => {
      const outgoingFollowOwners = await tx.select({
        userId: remoteFollows.followerId,
        count: sql<number>`count(*)`,
      }).from(remoteFollows).where(sql<boolean>`
        lower(ltrim(${remoteFollows.targetHandle}, '@')) = ${qualifiedHandle}
      `).groupBy(remoteFollows.followerId);
      const incomingFollowOwners = await tx.select({
        userId: remoteFollowers.userId,
        count: sql<number>`count(*)`,
      }).from(remoteFollowers).where(or(
        sql<boolean>`lower(ltrim(${remoteFollowers.handle}, '@')) = ${qualifiedHandle}`,
        eq(remoteFollowers.actorUrl, actorUrl),
      )).groupBy(remoteFollowers.userId);
      const likeTargets = await tx.select({
        postId: remoteLikes.postId,
        count: sql<number>`count(*)`,
      }).from(remoteLikes).where(and(
        eq(remoteLikes.actorNodeDomain, domain),
        or(
          sql<boolean>`lower(ltrim(${remoteLikes.actorHandle}, '@')) = ${bareHandle}`,
          sql<boolean>`lower(ltrim(${remoteLikes.actorHandle}, '@')) = ${qualifiedHandle}`,
        ),
      )).groupBy(remoteLikes.postId);
      const repostTargets = await tx.select({
        postId: remoteReposts.postId,
        count: sql<number>`count(*)`,
      }).from(remoteReposts).where(and(
        eq(remoteReposts.actorNodeDomain, domain),
        or(
          sql<boolean>`lower(ltrim(${remoteReposts.actorHandle}, '@')) = ${bareHandle}`,
          sql<boolean>`lower(ltrim(${remoteReposts.actorHandle}, '@')) = ${qualifiedHandle}`,
        ),
      )).groupBy(remoteReposts.postId);
      const repostOwners = await tx.select({
        userId: userSwarmReposts.userId,
        count: sql<number>`count(*)`,
      }).from(userSwarmReposts).where(and(
        eq(userSwarmReposts.nodeDomain, domain),
        or(
          sql<boolean>`lower(ltrim(${userSwarmReposts.authorHandle}, '@')) = ${bareHandle}`,
          sql<boolean>`lower(ltrim(${userSwarmReposts.authorHandle}, '@')) = ${qualifiedHandle}`,
        ),
      )).groupBy(userSwarmReposts.userId);
      const remoteReplyParents = cachedRemoteUser
        ? await tx.select({
            postId: localPosts.replyToId,
            count: sql<number>`count(*)`,
          }).from(localPosts).where(and(
            eq(localPosts.userId, cachedRemoteUser.id),
            sql<boolean>`${localPosts.replyToId} IS NOT NULL`,
          )).groupBy(localPosts.replyToId)
        : [];

      if (handleOwner) {
        await tx.update(handleRegistry).set({
          did: change.did,
          nodeDomain: domain,
          identityVerified: true,
          deletedAt,
          updatedAt: new Date(),
        }).where(and(
          eq(handleRegistry.handle, qualifiedHandle),
          eq(handleRegistry.did, handleOwner.did),
        ));
      } else {
        await tx.insert(handleRegistry).values({
          handle: qualifiedHandle,
          did: change.did,
          nodeDomain: domain,
          identityVerified: true,
          deletedAt,
          updatedAt: new Date(),
        });
      }

      await tx.delete(remotePosts).where(and(
        eq(remotePosts.nodeDomain, domain),
        sql<boolean>`lower(ltrim(${remotePosts.authorHandle}, '@')) = ${qualifiedHandle}`,
      ));
      await tx.delete(userSwarmLikes).where(and(
        eq(userSwarmLikes.nodeDomain, domain),
        or(
          sql<boolean>`lower(ltrim(${userSwarmLikes.authorHandle}, '@')) = ${bareHandle}`,
          sql<boolean>`lower(ltrim(${userSwarmLikes.authorHandle}, '@')) = ${qualifiedHandle}`,
        ),
      ));
      await tx.delete(userSwarmReposts).where(and(
        eq(userSwarmReposts.nodeDomain, domain),
        or(
          sql<boolean>`lower(ltrim(${userSwarmReposts.authorHandle}, '@')) = ${bareHandle}`,
          sql<boolean>`lower(ltrim(${userSwarmReposts.authorHandle}, '@')) = ${qualifiedHandle}`,
        ),
      ));
      await tx.delete(remoteFollows).where(sql<boolean>`
        lower(ltrim(${remoteFollows.targetHandle}, '@')) = ${qualifiedHandle}
      `);
      await tx.delete(remoteFollowers).where(or(
        sql<boolean>`lower(ltrim(${remoteFollowers.handle}, '@')) = ${qualifiedHandle}`,
        eq(remoteFollowers.actorUrl, actorUrl),
      ));
      await tx.delete(remoteLikes).where(and(
        eq(remoteLikes.actorNodeDomain, domain),
        or(
          sql<boolean>`lower(ltrim(${remoteLikes.actorHandle}, '@')) = ${bareHandle}`,
          sql<boolean>`lower(ltrim(${remoteLikes.actorHandle}, '@')) = ${qualifiedHandle}`,
        ),
      ));
      await tx.delete(remoteReposts).where(and(
        eq(remoteReposts.actorNodeDomain, domain),
        or(
          sql<boolean>`lower(ltrim(${remoteReposts.actorHandle}, '@')) = ${bareHandle}`,
          sql<boolean>`lower(ltrim(${remoteReposts.actorHandle}, '@')) = ${qualifiedHandle}`,
        ),
      ));
      await tx.delete(notifications).where(and(
        eq(notifications.actorNodeDomain, domain),
        or(
          sql<boolean>`lower(ltrim(${notifications.actorHandle}, '@')) = ${bareHandle}`,
          sql<boolean>`lower(ltrim(${notifications.actorHandle}, '@')) = ${qualifiedHandle}`,
        ),
      ));
      await tx.delete(e2eeRemoteKeyBundles).where(eq(e2eeRemoteKeyBundles.did, change.did));
      await tx.delete(swarmRelationshipStates).where(and(
        eq(swarmRelationshipStates.sourceDomain, domain),
        eq(swarmRelationshipStates.actorDid, change.did),
      ));
      if (cachedRemoteUser) {
        await tx.delete(localPosts).where(eq(localPosts.userId, cachedRemoteUser.id));
      }
      await tx.delete(users).where(and(
        eq(users.handle, qualifiedHandle),
        eq(users.did, change.did),
      ));

      for (const owner of outgoingFollowOwners) {
        await tx.update(users).set({
          followingCount: sql`max(0, ${users.followingCount} - ${Number(owner.count || 0)})`,
        }).where(eq(users.id, owner.userId));
      }
      for (const owner of incomingFollowOwners) {
        await tx.update(users).set({
          followersCount: sql`max(0, ${users.followersCount} - ${Number(owner.count || 0)})`,
        }).where(eq(users.id, owner.userId));
      }
      for (const owner of repostOwners) {
        await tx.update(users).set({
          postsCount: sql`max(0, ${users.postsCount} - ${Number(owner.count || 0)})`,
        }).where(eq(users.id, owner.userId));
      }
      for (const target of likeTargets) {
        await tx.update(localPosts).set({
          likesCount: sql`max(0, ${localPosts.likesCount} - ${Number(target.count || 0)})`,
        }).where(eq(localPosts.id, target.postId));
      }
      for (const target of repostTargets) {
        await tx.update(localPosts).set({
          repostsCount: sql`max(0, ${localPosts.repostsCount} - ${Number(target.count || 0)})`,
        }).where(eq(localPosts.id, target.postId));
      }
      for (const parent of remoteReplyParents) {
        if (!parent.postId) continue;
        await tx.update(localPosts).set({
          repliesCount: sql`max(0, ${localPosts.repliesCount} - ${Number(parent.count || 0)})`,
        }).where(eq(localPosts.id, parent.postId));
      }
    });
    applied += 1;
  }

  return applied;
}

async function reconcileLegacyPeerReferences(peer: ClaimedPeer): Promise<{
  cursor: string | null;
  complete: boolean;
  progressed: boolean;
}> {
  if (peer.legacyReconcileComplete) {
    return { cursor: peer.legacyReconcileCursor, complete: true, progressed: false };
  }
  const cursorCondition = peer.legacyReconcileCursor
    ? gt(userSwarmLikes.originalPostId, peer.legacyReconcileCursor)
    : undefined;
  const repostCursorCondition = peer.legacyReconcileCursor
    ? gt(userSwarmReposts.originalPostId, peer.legacyReconcileCursor)
    : undefined;
  const [liked, reposted] = await Promise.all([
    db.select({ id: userSwarmLikes.originalPostId }).from(userSwarmLikes).where(and(
      eq(userSwarmLikes.nodeDomain, peer.domain),
      cursorCondition,
    )).orderBy(asc(userSwarmLikes.originalPostId)).limit(51),
    db.select({ id: userSwarmReposts.originalPostId }).from(userSwarmReposts).where(and(
      eq(userSwarmReposts.nodeDomain, peer.domain),
      repostCursorCondition,
    )).orderBy(asc(userSwarmReposts.originalPostId)).limit(51),
  ]);
  const candidates = Array.from(new Set([
    ...liked.map((row) => row.id),
    ...reposted.map((row) => row.id),
  ])).sort().slice(0, 50);
  if (candidates.length === 0) {
    return { cursor: peer.legacyReconcileCursor, complete: true, progressed: true };
  }

  const validIds = candidates.filter((id) => (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
  ));
  let available = new Set<string>();
  if (validIds.length > 0) {
    const statusUrl = new URL(`https://${peer.domain}/api/swarm/posts/status`);
    statusUrl.searchParams.set('ids', validIds.join(','));
    const response = await signedFederationRead(statusUrl.toString(), {
      headers: { Accept: 'application/json' },
      timeoutMs: 8_000,
      maxResponseBytes: 64 * 1024,
    });
    // Rolling upgrades may contact a node that has the change stream but not
    // this reconciliation endpoint yet. Retry on the ordinary refresh cadence.
    if (response.status === 404) {
      return { cursor: peer.legacyReconcileCursor, complete: false, progressed: false };
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Legacy post reconciliation failed with HTTP ${response.status}`);
    }
    const body = response.json() as { availablePostIds?: unknown };
    if (!Array.isArray(body.availablePostIds)
      || body.availablePostIds.length > validIds.length
      || body.availablePostIds.some((id) => typeof id !== 'string' || !validIds.includes(id))) {
      throw new Error('Legacy post reconciliation returned an invalid response');
    }
    available = new Set(body.availablePostIds);
  }

  await applyRemotePostDeletions(
    peer.domain,
    candidates.filter((id) => !available.has(id)),
  );
  return {
    cursor: candidates.at(-1) || peer.legacyReconcileCursor,
    complete: candidates.length < 50,
    progressed: true,
  };
}

async function syncPeer(peer: ClaimedPeer): Promise<{ domain: string; cached: number; error?: string }> {
  try {
    const [cacheState] = await db.select({ count: sql<number>`count(*)` })
      .from(remotePosts)
      .where(eq(remotePosts.nodeDomain, peer.domain));
    // A persisted cursor without its corresponding cache can happen after an
    // interrupted migration or manual recovery. Asking only for later changes
    // would leave the peer permanently empty, so rebuild from a bounded full
    // snapshot whenever the cache is missing.
    const requestFullSnapshot = Number(cacheState?.count || 0) === 0;
    const timelineUrl = new URL(`https://${peer.domain}/api/swarm/timeline`);
    timelineUrl.searchParams.set('limit', '50');
    timelineUrl.searchParams.set('accountsSince', String(peer.accountChangeCursor ?? 0));
    if (!requestFullSnapshot && peer.changeCursor !== null && peer.changeCursor >= 0) {
      timelineUrl.searchParams.set('changesSince', String(peer.changeCursor));
    } else if (!requestFullSnapshot && peer.changeCursor === -1 && peer.highWaterAt) {
      timelineUrl.searchParams.set('since', peer.highWaterAt.toISOString());
      if (peer.highWaterId) timelineUrl.searchParams.set('sinceId', peer.highWaterId);
    }
    const response = await signedFederationRead(
      timelineUrl.toString(),
      {
        headers: { Accept: 'application/json' },
        timeoutMs: 8_000,
        maxResponseBytes: 1024 * 1024,
      },
    );
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`HTTP ${response.status}`);
    }
    const parsed = parseRemoteTimelineResponse(response.json(), peer.domain);
    await applyRemoteAccountDeletions(peer.domain, parsed.accountChanges);
    const reconciliation = parsed.changeCursor !== undefined
      ? await reconcileLegacyPeerReferences(peer)
      : {
          cursor: peer.legacyReconcileCursor,
          complete: peer.legacyReconcileComplete,
          progressed: false,
        };
    const authoritativeNodeIsNsfw = peer.nodeIsNsfw || parsed.nodeIsNsfw === true
      ? true
      : peer.classificationKnown && parsed.nodeIsNsfw === false
        ? false
        : undefined;
    if (parsed.nodeIsNsfw === true && !peer.nodeIsNsfw) {
      await db.update(swarmNodes).set({
        isNsfw: true,
        nsfwClassificationKnown: true,
        updatedAt: new Date(),
      }).where(eq(swarmNodes.domain, peer.domain));
    }
    // The first change-stream snapshot is authoritative for this bounded
    // cache. Clearing only this peer repairs stale rows created before
    // tombstones existed without touching media or local interaction data.
    if ((peer.changeCursor === null || requestFullSnapshot) && parsed.changeCursor !== undefined) {
      await db.delete(remotePosts).where(eq(remotePosts.nodeDomain, peer.domain));
    }

    const deletedPostIds = Array.from(new Set(parsed.changes
      .filter((change) => change.type === 'delete')
      .map((change) => change.postId)));
    await applyRemotePostDeletions(peer.domain, deletedPostIds);

    const changedPosts = parsed.changes.flatMap((change) => (
      change.type === 'upsert' && change.post ? [change.post] : []
    ));
    const snapshots = parsed.changes.length > 0 ? changedPosts : parsed.posts;
    const cached = await cacheValidatedPosts(peer.domain, snapshots, authoritativeNodeIsNsfw);
    const highWater = parsed.posts.reduce<{ at: Date; id: string } | null>((newest, post) => {
      const activityAt = new Date(post.feedActivityAt || post.createdAt);
      return !newest
        || activityAt > newest.at
        || (activityAt.getTime() === newest.at.getTime() && post.id > newest.id)
        ? { at: activityAt, id: post.id }
        : newest;
    }, peer.highWaterAt ? { at: peer.highWaterAt, id: peer.highWaterId || '' } : null);
    // A valid, bounded timeline response from a pinned peer is the successful
    // exchange that ends availability quarantine. Content is still treated as
    // untrusted and must pass all parsing/classification/display filters.
    await markNodeSuccess(peer.domain, { verifiedContent: true });
    await finishPeerSync(peer, {
      success: true,
      highWaterAt: highWater?.at || null,
      highWaterId: highWater?.id || null,
      changeCursor: parsed.changeCursor ?? -1,
      accountChangeCursor: parsed.accountChangeCursor ?? null,
      legacyReconcileCursor: reconciliation.cursor,
      legacyReconcileComplete: reconciliation.complete,
      hasMore: parsed.hasMoreChanges === true
        || parsed.hasMoreAccountChanges === true
        || (reconciliation.progressed && !reconciliation.complete)
        || Boolean(peer.changeCursor === -1 && peer.highWaterAt && parsed.posts.length === 50),
    });
    return { domain: peer.domain, cached };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    await finishPeerSync(peer, { success: false, error: message });
    return { domain: peer.domain, cached: 0, error: message };
  }
}

/** Claim and synchronize a fair, fixed-size peer batch. */
export async function syncSwarmContentBatch(): Promise<ContentSyncResult> {
  const configuredBatchSize = process.env.SWARM_CONTENT_SYNC_BATCH_SIZE;
  const effectiveBatchSize = configuredBatchSize
    ? boundedInteger(configuredBatchSize, DEFAULT_SYNC_BATCH_SIZE, MAX_SYNC_BATCH_SIZE)
    : Math.max(DEFAULT_SYNC_BATCH_SIZE, Math.min(
        MAX_SYNC_BATCH_SIZE,
        Math.ceil(Number((await db.select({ count: sql<number>`count(*)` })
          .from(swarmNodes)
          .where(and(
            eq(swarmNodes.isActive, true),
            eq(swarmNodes.isBlocked, false),
            eq(swarmNodes.nsfwClassificationKnown, true),
            sql`${swarmNodes.publicKey} is not null`,
            sql`${swarmNodes.discoveredVia} in ('direct', 'announcement')`,
          )))[0]?.count || 0) / TARGET_FULL_SWEEP_MINUTES),
      ));
  const peers = await claimDuePeers(effectiveBatchSize);
  const domains = await mapWithConcurrency(peers, SYNC_CONCURRENCY, syncPeer);
  const staleBefore = new Date(Date.now() - CACHE_RETENTION_MS);
  await db.delete(remotePosts).where(and(
    lt(remotePosts.fetchedAt, staleBefore),
    lt(remotePosts.publishedAt, staleBefore),
  ));
  return {
    claimed: peers.length,
    synced: domains.filter((item) => !item.error).length,
    failed: domains.filter((item) => Boolean(item.error)).length,
    cached: domains.reduce((sum, item) => sum + item.cached, 0),
    domains,
  };
}

/** Read a validated, bounded cross-node snapshot without remote request I/O. */
export async function getCachedSwarmTimeline(
  options: CachedTimelineOptions = {},
): Promise<CachedTimelineResult> {
  const limit = Math.max(1, Math.min(options.limit ?? 30, 200));
  const cursor = normalizedCursor(options.cursor);
  const excludeDomains = Array.from(options.excludeDomains || [])
    .map(normalizeNodeDomain)
    .filter(Boolean)
    .slice(0, 5_000);
  const authorHandles = normalizedAuthorHandles(options.authorHandles);
  const escapedQuery = options.query?.trim().slice(0, 200)
    .replaceAll('\\', '\\\\')
    .replaceAll('%', '\\%')
    .replaceAll('_', '\\_');
  const indexedPostIds = escapedQuery
    ? await searchIndexedPostIds('remote', options.query || '')
    : null;
  if (indexedPostIds?.length === 0) {
    return { posts: [], sources: [], fetchedAt: new Date().toISOString(), continuationDate: null };
  }

  const cachedFeedId = sql<string>`'swarm:' || ${remotePosts.nodeDomain} || ':' || ${remotePosts.originalPostId}`;
  const cursorCondition = cursor
    ? or(
      lt(remotePosts.feedActivityAt, cursor.at),
      ...(cursor.id ? [and(
        eq(remotePosts.feedActivityAt, cursor.at),
        lt(cachedFeedId, cursor.id),
      )] : []),
    )
    : undefined;
  const conditions = [
    eq(remotePosts.isReply, false),
    sql`${remotePosts.postJson} is not null`,
    sql`${remotePosts.nodeDomain} is not null`,
    sql`exists (
      select 1 from ${swarmNodes}
      where ${swarmNodes.domain} = ${remotePosts.nodeDomain}
        and ${swarmNodes.isActive} = 1
        and ${swarmNodes.isBlocked} = 0
        and ${swarmNodes.trustScore} > ${SWARM_CONFIG.quarantineTrustScore}
    )`,
    cursorCondition,
    ...(excludeDomains.length ? [notInArray(remotePosts.nodeDomain, excludeDomains)] : []),
    ...(authorHandles.length ? [inArray(remotePosts.authorHandle, authorHandles)] : []),
    ...(options.followedByUserId ? [sql`exists (
      select 1 from ${remoteFollows}
      where ${remoteFollows.followerId} = ${options.followedByUserId}
        and ${remoteFollows.targetHandle} = ${remotePosts.authorHandle}
    )`] : []),
    ...(indexedPostIds ? [inArray(remotePosts.id, indexedPostIds)] : []),
    ...(!options.includeNsfw ? [
      eq(remotePosts.isNsfw, false),
      eq(remotePosts.authorIsNsfw, false),
      eq(remotePosts.nodeIsNsfw, false),
    ] : []),
  ];
  const rows = await db.select().from(remotePosts)
    .where(and(...conditions))
    .orderBy(
      desc(remotePosts.feedActivityAt),
      desc(remotePosts.nodeDomain),
      desc(remotePosts.originalPostId),
    )
    .limit(Math.min(limit * 2 + 1, MAX_CACHED_QUERY_ROWS));

  const cachedDomains = Array.from(new Set(rows
    .map((row) => row.nodeDomain)
    .filter((domain): domain is string => Boolean(domain))));
  const currentClassifications = cachedDomains.length > 0
    ? await db.select({
        domain: swarmNodes.domain,
        isNsfw: swarmNodes.isNsfw,
        known: swarmNodes.nsfwClassificationKnown,
      }).from(swarmNodes).where(inArray(swarmNodes.domain, cachedDomains))
    : [];
  const classificationByDomain = new Map(currentClassifications.map((node) => [
    node.domain,
    node.isNsfw ? true : node.known ? false : undefined,
  ]));

  const posts: SwarmPost[] = [];
  for (const row of rows) {
    if (!row.postJson || !row.nodeDomain) continue;
    try {
      const parsed = parseRemoteTimelineResponse({
        posts: [JSON.parse(row.postJson)],
        nodeDomain: row.nodeDomain,
        nodeIsNsfw: row.nodeIsNsfw ?? undefined,
      }, row.nodeDomain);
      const parsedPost = parsed.posts[0];
      const post = parsedPost
        ? applyAuthoritativeNodeClassification(
            parsedPost,
            classificationByDomain.get(row.nodeDomain),
          )
        : undefined;
      if (post) posts.push(post);
      if (posts.length >= limit) break;
    } catch {
      // A corrupt/legacy row cannot enter a feed; the next sync replaces it.
    }
  }

  const sourceCounts = new Map<string, number>();
  for (const post of posts) sourceCounts.set(post.nodeDomain, (sourceCounts.get(post.nodeDomain) || 0) + 1);
  const sources = Array.from(sourceCounts, ([domain, postCount]) => ({
    domain,
    postCount,
    isNsfw: posts.find((post) => post.nodeDomain === domain)?.nodeIsNsfw,
  }));
  const oldest = posts.at(-1);
  return {
    posts,
    sources,
    fetchedAt: new Date().toISOString(),
    continuationDate: posts.length === limit && oldest
      ? (oldest.feedActivityAt || oldest.createdAt)
      : null,
  };
}
