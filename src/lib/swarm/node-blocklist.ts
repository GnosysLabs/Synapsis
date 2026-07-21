import {
  chatMessages,
  db,
  follows,
  mentionDeliveries,
  notifications,
  posts,
  pushMessageDeliveries,
  remoteFeedStories,
  remoteFollowers,
  remoteFollows,
  remoteFollowSyncStates,
  remoteLikes,
  remotePosts,
  remoteReposts,
  swarmChangeBundles,
  swarmChangeNoticeStates,
  swarmContentSyncStates,
  swarmNodes,
  users,
  userSwarmLikes,
  userSwarmReposts,
} from '@/db';
import {
  and,
  eq,
  inArray,
  isNotNull,
  isNull,
  like,
  or,
  sql,
} from 'drizzle-orm';
import {
  getCanonicalSwarmSeedDomain,
  getPublicSwarmDomain,
  normalizeNodeDomain,
} from './node-domain';

export { normalizeNodeDomain } from './node-domain';

const NODE_BLOCK_SUSPENSION_REASON = 'node_block';
const NODE_BLOCK_DEAD_LETTER_REASON = 'Cancelled because the remote node was blocked by an administrator.';

export interface NodeBlockQuarantineReport {
  outgoingFollowsSuspended: number;
  incomingFollowersSuspended: number;
  remoteLikesRemoved: number;
  remoteRepostsRemoved: number;
  remoteRepliesRemoved: number;
  notificationsRemoved: number;
  cachedPostsRemoved: number;
  cachedFeedStoriesRemoved: number;
  localRemoteLikesRemoved: number;
  localRemoteRepostsScrubbed: number;
  localReplyParentsScrubbed: number;
  mentionDeliveriesCancelled: number;
  messagePushesCancelled: number;
  chatMessagesRedacted: number;
  cachedProfilesRedacted: number;
  changeNoticesCancelled: number;
  changeBundlesRemoved: number;
}

export interface NodeBlockMutationResult {
  node: typeof swarmNodes.$inferSelect;
  quarantine: NodeBlockQuarantineReport | null;
  quarantinePending: boolean;
}

function canonicalBlockedNodeDomain(value: string): string | null {
  const publicDomain = getCanonicalSwarmSeedDomain(value) ?? getPublicSwarmDomain(value);
  if (publicDomain) return publicDomain;

  const normalized = normalizeNodeDomain(value).replace(/\.$/, '');
  return process.env.NODE_ENV !== 'production'
    && /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i.test(normalized)
    ? normalized
    : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 1_000) : 'Unknown quarantine error';
}

function sumCounts(rows: Array<{ count: number }>): number {
  return rows.reduce((sum, row) => sum + Number(row.count), 0);
}

export async function isNodeBlocked(domain: string | null | undefined): Promise<boolean> {
  if (!domain) return false;

  const normalized = canonicalBlockedNodeDomain(domain);
  if (!normalized) return false;

  const node = await db.query.swarmNodes.findFirst({
    where: { domain: normalized },
    columns: {
      isBlocked: true,
    },
  });

  return Boolean(node?.isBlocked);
}

export async function getBlockedNodeDomains(): Promise<Set<string>> {
  const rows = await db.query.swarmNodes.findMany({
    where: { isBlocked: true },
    columns: {
      domain: true,
    },
  });

  return new Set(rows.map((row) => canonicalBlockedNodeDomain(row.domain) ?? row.domain));
}

export async function filterBlockedDomains(domains: string[]): Promise<string[]> {
  if (domains.length === 0) return domains;

  const normalized = Array.from(new Set(
    domains
      .map(canonicalBlockedNodeDomain)
      .filter((domain): domain is string => Boolean(domain)),
  ));
  if (normalized.length === 0) return [];

  const blocked = await db.query.swarmNodes.findMany({
    where: { AND: [{ domain: { in: normalized } }, { isBlocked: true }] },
    columns: {
      domain: true,
    },
  });

  const blockedSet = new Set(blocked.map((row) => row.domain));
  return normalized.filter((domain) => !blockedSet.has(domain));
}

/**
 * Remove a blocked node from every active projection while retaining identity
 * pins, replay/ordering ledgers, signed provenance, and encrypted chat history.
 * This is intentionally idempotent so an interrupted cleanup can be retried.
 */
export async function quarantineBlockedNode(domain: string): Promise<NodeBlockQuarantineReport> {
  const normalized = canonicalBlockedNodeDomain(domain);
  if (!normalized) throw new Error('Invalid node domain');

  return db.transaction(async (tx) => {
    const blockedNode = await tx.query.swarmNodes.findFirst({
      where: { domain: normalized },
      columns: { id: true, isBlocked: true },
    });
    if (!blockedNode?.isBlocked) {
      throw new Error('Refusing to quarantine a node before its block perimeter is active');
    }

    const now = new Date();
    const outgoingFollowCounts = await tx.select({
      userId: remoteFollows.followerId,
      count: sql<number>`count(*)`,
    }).from(remoteFollows).where(and(
      eq(remoteFollows.targetNodeDomain, normalized),
      isNull(remoteFollows.suspendedAt),
    )).groupBy(remoteFollows.followerId);
    const incomingFollowerCounts = await tx.select({
      userId: remoteFollowers.userId,
      count: sql<number>`count(*)`,
    }).from(remoteFollowers).where(and(
      eq(remoteFollowers.actorNodeDomain, normalized),
      isNull(remoteFollowers.suspendedAt),
    )).groupBy(remoteFollowers.userId);

    await tx.update(remoteFollows).set({
      suspendedAt: now,
      suspensionReason: NODE_BLOCK_SUSPENSION_REASON,
      displayName: null,
      bio: null,
      avatarUrl: null,
    }).where(and(
      eq(remoteFollows.targetNodeDomain, normalized),
      isNull(remoteFollows.suspendedAt),
    ));
    await tx.update(remoteFollowers).set({
      suspendedAt: now,
      suspensionReason: NODE_BLOCK_SUSPENSION_REASON,
    }).where(and(
      eq(remoteFollowers.actorNodeDomain, normalized),
      isNull(remoteFollowers.suspendedAt),
    ));

    for (const { userId } of outgoingFollowCounts) {
      const [local] = await tx.select({ count: sql<number>`count(*)` })
        .from(follows).where(eq(follows.followerId, userId));
      const [remote] = await tx.select({ count: sql<number>`count(*)` })
        .from(remoteFollows).where(and(
          eq(remoteFollows.followerId, userId),
          isNull(remoteFollows.suspendedAt),
        ));
      await tx.update(users).set({
        followingCount: Number(local?.count ?? 0) + Number(remote?.count ?? 0),
        updatedAt: now,
      }).where(eq(users.id, userId));
    }
    for (const { userId } of incomingFollowerCounts) {
      const [local] = await tx.select({ count: sql<number>`count(*)` })
        .from(follows).where(eq(follows.followingId, userId));
      const [remote] = await tx.select({ count: sql<number>`count(*)` })
        .from(remoteFollowers).where(and(
          eq(remoteFollowers.userId, userId),
          isNull(remoteFollowers.suspendedAt),
        ));
      await tx.update(users).set({
        followersCount: Number(local?.count ?? 0) + Number(remote?.count ?? 0),
        updatedAt: now,
      }).where(eq(users.id, userId));
    }

    const remoteLikeCounts = await tx.select({
      postId: remoteLikes.postId,
      count: sql<number>`count(*)`,
    }).from(remoteLikes).where(eq(remoteLikes.actorNodeDomain, normalized))
      .groupBy(remoteLikes.postId);
    const deletedRemoteLikes = await tx.delete(remoteLikes)
      .where(eq(remoteLikes.actorNodeDomain, normalized))
      .returning({ id: remoteLikes.id });
    for (const row of remoteLikeCounts) {
      await tx.update(posts).set({
        likesCount: sql<number>`max(0, ${posts.likesCount} - ${Number(row.count)})`,
      }).where(eq(posts.id, row.postId));
    }

    const remoteRepostCounts = await tx.select({
      postId: remoteReposts.postId,
      count: sql<number>`count(*)`,
    }).from(remoteReposts).where(eq(remoteReposts.actorNodeDomain, normalized))
      .groupBy(remoteReposts.postId);
    const deletedRemoteReposts = await tx.delete(remoteReposts)
      .where(eq(remoteReposts.actorNodeDomain, normalized))
      .returning({ id: remoteReposts.id });
    for (const row of remoteRepostCounts) {
      await tx.update(posts).set({
        repostsCount: sql<number>`max(0, ${posts.repostsCount} - ${Number(row.count)})`,
      }).where(eq(posts.id, row.postId));
    }

    const remoteUsers = await tx.select({ id: users.id }).from(users).where(and(
      eq(users.homeDomain, normalized),
      eq(users.isLocalAccount, false),
    ));
    let remoteRepliesRemoved = 0;
    if (remoteUsers.length > 0) {
      const remoteUserIds = remoteUsers.map((row) => row.id);
      const replyCounts = await tx.select({
        postId: posts.replyToId,
        count: sql<number>`count(*)`,
      }).from(posts).where(and(
        inArray(posts.userId, remoteUserIds),
        isNotNull(posts.replyToId),
      )).groupBy(posts.replyToId);
      const deletedReplies = await tx.delete(posts)
        .where(inArray(posts.userId, remoteUserIds))
        .returning({ id: posts.id });
      remoteRepliesRemoved = deletedReplies.length;
      for (const row of replyCounts) {
        if (!row.postId) continue;
        await tx.update(posts).set({
          repliesCount: sql<number>`max(0, ${posts.repliesCount} - ${Number(row.count)})`,
        }).where(eq(posts.id, row.postId));
      }
    }

    const removedNotifications = await tx.delete(notifications).where(or(
      eq(notifications.actorNodeDomain, normalized),
      eq(notifications.remotePostDomain, normalized),
    )).returning({ id: notifications.id });
    const removedCachedPosts = await tx.delete(remotePosts)
      .where(eq(remotePosts.nodeDomain, normalized))
      .returning({ id: remotePosts.id });
    const removedFeedStories = await tx.delete(remoteFeedStories)
      .where(eq(remoteFeedStories.nodeDomain, normalized))
      .returning({ postId: remoteFeedStories.originalPostId });
    const removedLocalLikes = await tx.delete(userSwarmLikes)
      .where(eq(userSwarmLikes.nodeDomain, normalized))
      .returning({ id: userSwarmLikes.id });
    const scrubbedLocalReposts = await tx.update(userSwarmReposts).set({
      content: '',
      authorDisplayName: null,
      authorAvatarUrl: null,
      likesCount: 0,
      repostsCount: 0,
      repliesCount: 0,
      linkPreviewUrl: null,
      linkPreviewTitle: null,
      linkPreviewDescription: null,
      linkPreviewImage: null,
      linkPreviewType: null,
      linkPreviewVideoUrl: null,
      linkPreviewMediaJson: null,
      mediaJson: null,
      originUnavailableAt: now,
    }).where(eq(userSwarmReposts.nodeDomain, normalized))
      .returning({ id: userSwarmReposts.id });
    const scrubbedReplyParents = await tx.update(posts).set({
      swarmReplyToContent: null,
      swarmReplyToAuthor: null,
      updatedAt: now,
    }).where(like(posts.swarmReplyToId, `swarm:${normalized}:%`))
      .returning({ id: posts.id });

    const cancelledMentions = await tx.update(mentionDeliveries).set({
      status: 'dead',
      lastError: NODE_BLOCK_DEAD_LETTER_REASON,
      updatedAt: now,
    }).where(and(
      eq(mentionDeliveries.targetDomain, normalized),
      inArray(mentionDeliveries.status, ['pending', 'processing', 'retry']),
    )).returning({ id: mentionDeliveries.id });
    await tx.delete(remoteFollowSyncStates)
      .where(eq(remoteFollowSyncStates.nodeDomain, normalized));
    await tx.delete(swarmContentSyncStates)
      .where(eq(swarmContentSyncStates.domain, normalized));

    const cancelledNotices = await tx.update(swarmChangeNoticeStates).set({
      status: 'dead',
      relayTargetsJson: '[]',
      pullScheduledAt: null,
      lastError: NODE_BLOCK_DEAD_LETTER_REASON,
      updatedAt: now,
    }).where(and(
      eq(swarmChangeNoticeStates.originDomain, normalized),
      inArray(swarmChangeNoticeStates.status, ['pending', 'processing', 'retry']),
    )).returning({ originDomain: swarmChangeNoticeStates.originDomain });
    const removedBundles = await tx.delete(swarmChangeBundles)
      .where(eq(swarmChangeBundles.originDomain, normalized))
      .returning({ originDomain: swarmChangeBundles.originDomain });

    const remoteMessageIds = tx.select({ id: chatMessages.id })
      .from(chatMessages)
      .where(eq(chatMessages.senderNodeDomain, normalized));
    const cancelledMessagePushes = await tx.update(pushMessageDeliveries).set({
      status: 'dead',
      lastError: NODE_BLOCK_DEAD_LETTER_REASON,
      updatedAt: now,
    }).where(and(
      inArray(pushMessageDeliveries.status, ['pending', 'processing', 'retry']),
      inArray(pushMessageDeliveries.messageId, remoteMessageIds),
    )).returning({ id: pushMessageDeliveries.id });
    const redactedChatMessages = await tx.update(chatMessages).set({
      senderDisplayName: null,
      senderAvatarUrl: null,
      readAt: sql`coalesce(${chatMessages.readAt}, unixepoch())`,
    }).where(eq(chatMessages.senderNodeDomain, normalized))
      .returning({ id: chatMessages.id });
    const redactedProfiles = await tx.update(users).set({
      displayName: null,
      bio: null,
      avatarUrl: null,
      headerUrl: null,
      website: null,
      followersCount: 0,
      followingCount: 0,
      postsCount: 0,
      updatedAt: now,
    }).where(and(
      eq(users.homeDomain, normalized),
      eq(users.isLocalAccount, false),
    )).returning({ id: users.id });

    const report: NodeBlockQuarantineReport = {
      outgoingFollowsSuspended: sumCounts(outgoingFollowCounts),
      incomingFollowersSuspended: sumCounts(incomingFollowerCounts),
      remoteLikesRemoved: deletedRemoteLikes.length,
      remoteRepostsRemoved: deletedRemoteReposts.length,
      remoteRepliesRemoved,
      notificationsRemoved: removedNotifications.length,
      cachedPostsRemoved: removedCachedPosts.length,
      cachedFeedStoriesRemoved: removedFeedStories.length,
      localRemoteLikesRemoved: removedLocalLikes.length,
      localRemoteRepostsScrubbed: scrubbedLocalReposts.length,
      localReplyParentsScrubbed: scrubbedReplyParents.length,
      mentionDeliveriesCancelled: cancelledMentions.length,
      messagePushesCancelled: cancelledMessagePushes.length,
      chatMessagesRedacted: redactedChatMessages.length,
      cachedProfilesRedacted: redactedProfiles.length,
      changeNoticesCancelled: cancelledNotices.length,
      changeBundlesRemoved: removedBundles.length,
    };

    await tx.update(swarmNodes).set({
      quarantineCompletedAt: now,
      quarantineError: null,
      updatedAt: now,
    }).where(eq(swarmNodes.id, blockedNode.id));

    return report;
  });
}

export async function upsertBlockedNode(
  domain: string,
  reason?: string | null,
): Promise<NodeBlockMutationResult | null> {
  const normalized = canonicalBlockedNodeDomain(domain);
  if (!normalized) return null;

  const now = new Date();
  const existing = await db.query.swarmNodes.findFirst({
    where: { domain: normalized },
  });
  const [blockedNode] = existing
    ? await db.update(swarmNodes).set({
      isBlocked: true,
      blockReason: reason || null,
      blockedAt: now,
      quarantineCompletedAt: null,
      quarantineError: null,
      isActive: false,
      updatedAt: now,
    }).where(eq(swarmNodes.id, existing.id)).returning()
    : await db.insert(swarmNodes).values({
      domain: normalized,
      isBlocked: true,
      blockReason: reason || null,
      blockedAt: now,
      quarantineCompletedAt: null,
      quarantineError: null,
      isActive: false,
      trustScore: 0,
    }).returning();

  try {
    const quarantine = await quarantineBlockedNode(normalized);
    const node = await db.query.swarmNodes.findFirst({ where: { domain: normalized } });
    return {
      node: node ?? blockedNode,
      quarantine,
      quarantinePending: false,
    };
  } catch (error) {
    const message = errorMessage(error);
    const [node] = await db.update(swarmNodes).set({
      quarantineError: message,
      updatedAt: new Date(),
    }).where(eq(swarmNodes.id, blockedNode.id)).returning();
    console.error(`Blocked-node quarantine pending for ${normalized}:`, error);
    return {
      node,
      quarantine: null,
      quarantinePending: true,
    };
  }
}

/** Retry durable cleanup after a crash or transient database failure. */
export async function reconcileBlockedNodeQuarantines(limit = 20): Promise<{
  attempted: number;
  completed: number;
  failed: number;
}> {
  const pending = await db.select({ domain: swarmNodes.domain }).from(swarmNodes)
    .where(and(eq(swarmNodes.isBlocked, true), isNull(swarmNodes.quarantineCompletedAt)))
    .limit(limit);
  let completed = 0;
  let failed = 0;
  for (const row of pending) {
    try {
      await quarantineBlockedNode(row.domain);
      completed += 1;
    } catch (error) {
      failed += 1;
      await db.update(swarmNodes).set({
        quarantineError: errorMessage(error),
        updatedAt: new Date(),
      }).where(eq(swarmNodes.domain, row.domain));
      console.error(`Blocked-node quarantine retry failed for ${row.domain}:`, error);
    }
  }
  return { attempted: pending.length, completed, failed };
}

export async function unblockNode(domain: string) {
  const normalized = canonicalBlockedNodeDomain(domain);
  if (!normalized) return null;

  let existing = await db.query.swarmNodes.findFirst({
    where: { domain: normalized },
  });
  if (!existing) return null;

  if (existing.isBlocked && !existing.quarantineCompletedAt) {
    await quarantineBlockedNode(normalized);
    existing = await db.query.swarmNodes.findFirst({ where: { domain: normalized } }) ?? existing;
  }

  const [updated] = await db.update(swarmNodes)
    .set({
      isBlocked: false,
      blockReason: null,
      blockedAt: null,
      quarantineCompletedAt: null,
      quarantineError: null,
      // Transport remains inactive until discoverNode verifies the peer again.
      isActive: false,
      updatedAt: new Date(),
    })
    .where(eq(swarmNodes.id, existing.id))
    .returning();

  return updated;
}
