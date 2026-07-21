import {
  db,
  feedFeedback,
  feedImpressions,
  follows,
  likes,
  posts,
  remoteFollows,
  remoteLikes,
  remoteReposts,
  reports,
  userSwarmLikes,
  userSwarmReposts,
  users,
} from '@/db';
import { and, eq, inArray, isNotNull, lte, or, sql } from 'drizzle-orm';
import type { Post } from '@/lib/types';
import { tokenizePostSearch } from '@/lib/search/post-index';
import {
  canonicalForYouAuthor,
  type ForYouEngagementSignal,
  type ForYouViewerSignals,
} from './for-you-feed';

interface ViewerIdentity {
  id: string;
  handle: string;
}

function emptyEngagement(): ForYouEngagementSignal {
  return { likes: 0, reposts: 0, replies: 0 };
}

function incrementEngagement(
  map: Map<string, ForYouEngagementSignal>,
  postKey: string | null | undefined,
  kind: keyof ForYouEngagementSignal,
  count: number,
) {
  if (!postKey || !Number.isFinite(count) || count <= 0) return;
  const current = map.get(postKey) || emptyEngagement();
  map.set(postKey, { ...current, [kind]: current[kind] + count });
}

function swarmPostKey(nodeDomain: string, originalPostId: string): string {
  return `swarm:${nodeDomain}:${originalPostId}`;
}

function addAffinity(map: Map<string, number>, author: string | null | undefined, weight: number) {
  if (!author) return;
  map.set(author, (map.get(author) || 0) + weight);
}

function addTopics(map: Map<string, number>, content: string | null | undefined, weight: number) {
  if (!content) return;
  tokenizePostSearch(content).forEach((term) => {
    if (term.length > 2) map.set(term, Math.min(20, (map.get(term) || 0) + weight));
  });
}

function decayedInteractionWeight(base: number, occurredAt: Date, snapshotAt: Date): number {
  const ageDays = Math.max(0, (snapshotAt.getTime() - occurredAt.getTime()) / 86_400_000);
  return base * (0.2 + 0.8 * Math.exp(-ageDays / 120));
}

function candidateAuthorMap(candidates: Post[]): Map<string, { author: string; content: string }> {
  return new Map(candidates.map((post) => {
    const domain = post.nodeDomain || post.author.nodeDomain;
    return [post.id, {
      author: canonicalForYouAuthor(post.author.handle, domain),
      content: post.content,
    }];
  }));
}

function applyCandidateInteraction(
  candidates: Map<string, { author: string; content: string }>,
  affinity: Map<string, number>,
  topics: Map<string, number>,
  postKey: string | null | undefined,
  weight: number,
) {
  if (!postKey) return;
  const candidate = candidates.get(postKey);
  if (!candidate) return;
  addAffinity(affinity, candidate.author, weight);
  addTopics(topics, candidate.content, weight);
}

/** Build a viewer profile exclusively from interactions observed by this node. */
export async function buildForYouViewerSignals(options: {
  viewer: ViewerIdentity;
  candidates: Post[];
  snapshotAt: Date;
  localNodeDomain: string;
}): Promise<ForYouViewerSignals> {
  const { viewer, candidates, snapshotAt, localNodeDomain } = options;
  const candidateByKey = candidateAuthorMap(candidates);

  const [
    followedLocalRows,
    followedRemoteRows,
    viewerLocalLikes,
    viewerLocalPosts,
    viewerSwarmLikes,
    viewerSwarmReposts,
    impressionRows,
    feedbackRows,
    reportRows,
    localLikeCounts,
    localRepostCounts,
    localReplyCounts,
    swarmLikeCounts,
    swarmRepostCounts,
    observedRemoteLikes,
    observedRemoteReposts,
  ] = await Promise.all([
    db.select({ id: users.id, handle: users.handle })
      .from(follows)
      .innerJoin(users, eq(users.id, follows.followingId))
      .where(and(eq(follows.followerId, viewer.id), lte(follows.createdAt, snapshotAt))),
    db.select({ handle: remoteFollows.targetHandle })
      .from(remoteFollows)
      .where(and(
        eq(remoteFollows.followerId, viewer.id),
        lte(remoteFollows.createdAt, snapshotAt),
        sql`${remoteFollows.suspendedAt} is null`,
      )),
    db.select({
      postId: likes.postId,
      content: posts.content,
      authorHandle: users.handle,
      authorDomain: users.homeDomain,
      createdAt: likes.createdAt,
    }).from(likes)
      .innerJoin(posts, eq(posts.id, likes.postId))
      .innerJoin(users, eq(users.id, posts.userId))
      .where(and(eq(likes.userId, viewer.id), lte(likes.createdAt, snapshotAt))),
    db.select({
      repostOfId: posts.repostOfId,
      replyToId: posts.replyToId,
      swarmReplyToId: posts.swarmReplyToId,
      createdAt: posts.createdAt,
    }).from(posts).where(and(
      eq(posts.userId, viewer.id),
      lte(posts.createdAt, snapshotAt),
      or(isNotNull(posts.repostOfId), isNotNull(posts.replyToId), isNotNull(posts.swarmReplyToId)),
    )),
    db.select().from(userSwarmLikes).where(and(
      eq(userSwarmLikes.userId, viewer.id),
      lte(userSwarmLikes.likedAt, snapshotAt),
    )),
    db.select().from(userSwarmReposts).where(and(
      eq(userSwarmReposts.userId, viewer.id),
      lte(userSwarmReposts.repostedAt, snapshotAt),
    )),
    db.select().from(feedImpressions).where(and(
      eq(feedImpressions.userId, viewer.id),
      lte(feedImpressions.lastSeenAt, snapshotAt),
    )),
    db.select().from(feedFeedback).where(and(
      eq(feedFeedback.userId, viewer.id),
      lte(feedFeedback.updatedAt, snapshotAt),
    )),
    db.select({ targetId: reports.targetId }).from(reports).where(and(
      eq(reports.reporterId, viewer.id),
      eq(reports.targetType, 'post'),
      lte(reports.createdAt, snapshotAt),
    )),
    db.select({ postId: likes.postId, count: sql<number>`count(*)` })
      .from(likes).where(lte(likes.createdAt, snapshotAt)).groupBy(likes.postId),
    db.select({ postId: posts.repostOfId, count: sql<number>`count(*)` })
      .from(posts).where(and(
        isNotNull(posts.repostOfId),
        lte(posts.createdAt, snapshotAt),
      )).groupBy(posts.repostOfId),
    db.select({
      localPostId: posts.replyToId,
      swarmPostId: posts.swarmReplyToId,
      count: sql<number>`count(*)`,
    }).from(posts).where(and(
      or(isNotNull(posts.replyToId), isNotNull(posts.swarmReplyToId)),
      lte(posts.createdAt, snapshotAt),
    )).groupBy(posts.replyToId, posts.swarmReplyToId),
    db.select({
      nodeDomain: userSwarmLikes.nodeDomain,
      originalPostId: userSwarmLikes.originalPostId,
      count: sql<number>`count(*)`,
    }).from(userSwarmLikes)
      .where(lte(userSwarmLikes.likedAt, snapshotAt))
      .groupBy(userSwarmLikes.nodeDomain, userSwarmLikes.originalPostId),
    db.select({
      nodeDomain: userSwarmReposts.nodeDomain,
      originalPostId: userSwarmReposts.originalPostId,
      count: sql<number>`count(*)`,
    }).from(userSwarmReposts)
      .where(lte(userSwarmReposts.repostedAt, snapshotAt))
      .groupBy(userSwarmReposts.nodeDomain, userSwarmReposts.originalPostId),
    db.select({
      postId: remoteLikes.postId,
      actorHandle: remoteLikes.actorHandle,
      actorNodeDomain: remoteLikes.actorNodeDomain,
    }).from(remoteLikes).where(lte(remoteLikes.createdAt, snapshotAt)),
    db.select({
      postId: remoteReposts.postId,
      actorHandle: remoteReposts.actorHandle,
      actorNodeDomain: remoteReposts.actorNodeDomain,
    }).from(remoteReposts).where(lte(remoteReposts.createdAt, snapshotAt)),
  ]);

  const followedAuthors = new Set<string>();
  followedLocalRows.forEach((row) => followedAuthors.add(canonicalForYouAuthor(row.handle, localNodeDomain)));
  followedRemoteRows.forEach((row) => followedAuthors.add(canonicalForYouAuthor(row.handle)));

  const authorAffinity = new Map<string, number>();
  const authorDisinterest = new Map<string, number>();
  const topicWeights = new Map<string, number>();
  const negativeTopicWeights = new Map<string, number>();
  viewerLocalLikes.forEach((row) => {
    const weight = decayedInteractionWeight(1.5, row.createdAt, snapshotAt);
    addAffinity(authorAffinity, canonicalForYouAuthor(row.authorHandle, row.authorDomain), weight);
    addTopics(topicWeights, row.content, weight);
  });
  viewerLocalPosts.forEach((row) => {
    applyCandidateInteraction(candidateByKey, authorAffinity, topicWeights, row.repostOfId,
      decayedInteractionWeight(3, row.createdAt, snapshotAt));
    applyCandidateInteraction(candidateByKey, authorAffinity, topicWeights, row.replyToId,
      decayedInteractionWeight(4, row.createdAt, snapshotAt));
    applyCandidateInteraction(candidateByKey, authorAffinity, topicWeights, row.swarmReplyToId,
      decayedInteractionWeight(4, row.createdAt, snapshotAt));
  });
  viewerSwarmLikes.forEach((row) => {
    const weight = decayedInteractionWeight(1.5, row.likedAt, snapshotAt);
    addAffinity(authorAffinity, canonicalForYouAuthor(row.authorHandle, row.nodeDomain), weight);
    addTopics(topicWeights, row.content, weight);
  });
  viewerSwarmReposts.forEach((row) => {
    const weight = decayedInteractionWeight(3, row.repostedAt, snapshotAt);
    addAffinity(authorAffinity, canonicalForYouAuthor(row.authorHandle, row.nodeDomain), weight);
    addTopics(topicWeights, row.content, weight);
  });
  feedbackRows.forEach((row) => {
    addAffinity(authorDisinterest, canonicalForYouAuthor(row.authorHandle, row.nodeDomain), 1);
    addTopics(negativeTopicWeights, candidateByKey.get(row.postKey)?.content, 1.5);
  });

  const postEngagement = new Map<string, ForYouEngagementSignal>();
  localLikeCounts.forEach((row) => incrementEngagement(postEngagement, row.postId, 'likes', Number(row.count)));
  localRepostCounts.forEach((row) => incrementEngagement(postEngagement, row.postId, 'reposts', Number(row.count)));
  localReplyCounts.forEach((row) => {
    incrementEngagement(postEngagement, row.localPostId || row.swarmPostId, 'replies', Number(row.count));
  });
  swarmLikeCounts.forEach((row) => incrementEngagement(
    postEngagement,
    swarmPostKey(row.nodeDomain, row.originalPostId),
    'likes',
    Number(row.count),
  ));
  swarmRepostCounts.forEach((row) => incrementEngagement(
    postEngagement,
    swarmPostKey(row.nodeDomain, row.originalPostId),
    'reposts',
    Number(row.count),
  ));
  observedRemoteLikes.forEach((row) => incrementEngagement(postEngagement, row.postId, 'likes', 1));
  observedRemoteReposts.forEach((row) => incrementEngagement(postEngagement, row.postId, 'reposts', 1));

  const followedLocalIds = followedLocalRows.map((row) => row.id);
  const socialEngagement = new Map<string, ForYouEngagementSignal>();
  if (followedLocalIds.length > 0) {
    const [socialLikes, socialReposts, socialReplies, socialSwarmLikes, socialSwarmReposts] = await Promise.all([
      db.select({ postId: likes.postId, count: sql<number>`count(*)` })
        .from(likes).where(and(
          inArray(likes.userId, followedLocalIds),
          lte(likes.createdAt, snapshotAt),
        )).groupBy(likes.postId),
      db.select({ postId: posts.repostOfId, count: sql<number>`count(*)` })
        .from(posts).where(and(
          inArray(posts.userId, followedLocalIds),
          isNotNull(posts.repostOfId),
          lte(posts.createdAt, snapshotAt),
        )).groupBy(posts.repostOfId),
      db.select({
        localPostId: posts.replyToId,
        swarmPostId: posts.swarmReplyToId,
        count: sql<number>`count(*)`,
      }).from(posts).where(and(
        inArray(posts.userId, followedLocalIds),
        or(isNotNull(posts.replyToId), isNotNull(posts.swarmReplyToId)),
        lte(posts.createdAt, snapshotAt),
      )).groupBy(posts.replyToId, posts.swarmReplyToId),
      db.select({
        nodeDomain: userSwarmLikes.nodeDomain,
        originalPostId: userSwarmLikes.originalPostId,
        count: sql<number>`count(*)`,
      }).from(userSwarmLikes).where(and(
        inArray(userSwarmLikes.userId, followedLocalIds),
        lte(userSwarmLikes.likedAt, snapshotAt),
      )).groupBy(userSwarmLikes.nodeDomain, userSwarmLikes.originalPostId),
      db.select({
        nodeDomain: userSwarmReposts.nodeDomain,
        originalPostId: userSwarmReposts.originalPostId,
        count: sql<number>`count(*)`,
      }).from(userSwarmReposts).where(and(
        inArray(userSwarmReposts.userId, followedLocalIds),
        lte(userSwarmReposts.repostedAt, snapshotAt),
      )).groupBy(userSwarmReposts.nodeDomain, userSwarmReposts.originalPostId),
    ]);
    socialLikes.forEach((row) => incrementEngagement(socialEngagement, row.postId, 'likes', Number(row.count)));
    socialReposts.forEach((row) => incrementEngagement(socialEngagement, row.postId, 'reposts', Number(row.count)));
    socialReplies.forEach((row) => incrementEngagement(
      socialEngagement,
      row.localPostId || row.swarmPostId,
      'replies',
      Number(row.count),
    ));
    socialSwarmLikes.forEach((row) => incrementEngagement(
      socialEngagement,
      swarmPostKey(row.nodeDomain, row.originalPostId),
      'likes',
      Number(row.count),
    ));
    socialSwarmReposts.forEach((row) => incrementEngagement(
      socialEngagement,
      swarmPostKey(row.nodeDomain, row.originalPostId),
      'reposts',
      Number(row.count),
    ));
  }
  observedRemoteLikes.forEach((row) => {
    const actor = canonicalForYouAuthor(row.actorHandle, row.actorNodeDomain);
    if (followedAuthors.has(actor)) incrementEngagement(socialEngagement, row.postId, 'likes', 1);
  });
  observedRemoteReposts.forEach((row) => {
    const actor = canonicalForYouAuthor(row.actorHandle, row.actorNodeDomain);
    if (followedAuthors.has(actor)) incrementEngagement(socialEngagement, row.postId, 'reposts', 1);
  });

  const seenPosts = new Map(impressionRows.map((row) => [row.postKey, {
    count: row.viewCount,
    lastSeenAt: row.lastSeenAt,
  }]));
  const negativePosts = new Set([
    ...feedbackRows.map((row) => row.postKey),
    ...reportRows.map((row) => row.targetId),
  ]);
  const weightedInteractionCount = followedAuthors.size * 2
    + viewerLocalLikes.length
    + viewerSwarmLikes.length
    + (viewerLocalPosts.filter((row) => row.repostOfId).length + viewerSwarmReposts.length) * 2
    + viewerLocalPosts.filter((row) => row.replyToId || row.swarmReplyToId).length * 3;

  return {
    viewerHandle: canonicalForYouAuthor(viewer.handle, localNodeDomain),
    localNodeDomain,
    followedAuthors,
    authorAffinity,
    authorDisinterest,
    postEngagement,
    socialEngagement,
    seenPosts,
    negativePosts,
    topicWeights,
    negativeTopicWeights,
    personalizationConfidence: 1 - Math.exp(-weightedInteractionCount / 20),
  };
}
