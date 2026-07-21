import type { Post } from '@/lib/types';
import { resolveAccountAddress } from '@/lib/identity/account-address';
import { tokenizePostSearch } from '@/lib/search/post-index';

export const FOR_YOU_ALGORITHM = 'for-you-v1-personalized-diversity';
export const FOR_YOU_SESSION_TTL_MS = 2 * 60 * 60_000;

const RECENT_AUTHOR_LIMIT = 12;
const RECENT_NODE_LIMIT = 10;
const RECENT_FORMAT_LIMIT = 8;

const TOPIC_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from', 'has',
  'he', 'her', 'his', 'i', 'if', 'in', 'is', 'it', 'its', 'me', 'my', 'not',
  'of', 'on', 'or', 'our', 'she', 'so', 'that', 'the', 'their', 'them', 'they',
  'this', 'to', 'was', 'we', 'were', 'will', 'with', 'you', 'your',
]);

export type ForYouFormat = 'repost' | 'media' | 'link' | 'text';

export interface ForYouEngagementSignal {
  likes: number;
  reposts: number;
  replies: number;
}

export interface ForYouSeenSignal {
  count: number;
  lastSeenAt: Date;
}

export interface ForYouViewerSignals {
  viewerHandle: string;
  localNodeDomain: string;
  followedAuthors: ReadonlySet<string>;
  authorAffinity: ReadonlyMap<string, number>;
  authorDisinterest: ReadonlyMap<string, number>;
  postEngagement: ReadonlyMap<string, ForYouEngagementSignal>;
  socialEngagement: ReadonlyMap<string, ForYouEngagementSignal>;
  seenPosts: ReadonlyMap<string, ForYouSeenSignal>;
  negativePosts: ReadonlySet<string>;
  topicWeights: ReadonlyMap<string, number>;
  negativeTopicWeights: ReadonlyMap<string, number>;
  personalizationConfidence: number;
}

export interface ForYouDiversityState {
  recentAuthors: string[];
  recentNodes: string[];
  recentFormats: ForYouFormat[];
}

export interface ForYouFeedMeta {
  algorithm: typeof FOR_YOU_ALGORITHM;
  score: number;
  reasons: string[];
  signals: {
    freshness: number;
    engagement: number;
    social: number;
    affinity: number;
    topic: number;
    negative: number;
    seenPenalty: number;
    diversityPenalty: number;
  };
}

export type ForYouFeedPost = Post & { feedMeta: ForYouFeedMeta };

export interface RankForYouResult {
  posts: ForYouFeedPost[];
  state: ForYouDiversityState;
  remainingCount: number;
}

interface ScoredCandidate {
  post: Post;
  postKey: string;
  authorKey: string;
  nodeKey: string;
  format: ForYouFormat;
  activityAt: number;
  baseScore: number;
  reasons: string[];
  signals: ForYouFeedMeta['signals'];
}

function boundedNumber(value: unknown, maximum = 1_000_000): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(maximum, value))
    : 0;
}

function roundScore(value: number): number {
  return Number(value.toFixed(3));
}

export function canonicalForYouAuthor(handle: string, fallbackDomain?: string | null): string {
  return resolveAccountAddress(handle, fallbackDomain)?.canonical
    ?? handle.trim().toLowerCase();
}

export function forYouPostKey(post: Post): string {
  return post.id;
}

export function forYouFormat(post: Post): ForYouFormat {
  if (post.repostOf || post.repostOfId) return 'repost';
  if (post.media?.length) return 'media';
  if (post.linkPreviewUrl) return 'link';
  return 'text';
}

export function emptyForYouDiversityState(): ForYouDiversityState {
  return { recentAuthors: [], recentNodes: [], recentFormats: [] };
}

function validStringList(value: unknown, maximum: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string' && item.length > 0 && item.length <= 640)
    .slice(-maximum);
}

export function parseForYouDiversityState(value: string | null | undefined): ForYouDiversityState {
  if (!value) return emptyForYouDiversityState();
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return {
      recentAuthors: validStringList(parsed.recentAuthors, RECENT_AUTHOR_LIMIT),
      recentNodes: validStringList(parsed.recentNodes, RECENT_NODE_LIMIT),
      recentFormats: validStringList(parsed.recentFormats, RECENT_FORMAT_LIMIT)
        .filter((item): item is ForYouFormat => ['repost', 'media', 'link', 'text'].includes(item)),
    };
  } catch {
    return emptyForYouDiversityState();
  }
}

function pushRecent<T>(items: T[], item: T, maximum: number): T[] {
  return [...items, item].slice(-maximum);
}

function occurrences<T>(items: readonly T[], value: T): number {
  return items.reduce((count, item) => count + (item === value ? 1 : 0), 0);
}

function stableExplorationValue(viewer: string, postKey: string, snapshotAt: number): number {
  const day = Math.floor(snapshotAt / 86_400_000);
  const input = `${viewer}:${postKey}:${day}`;
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 0xffffffff;
}

function topicScore(post: Post, weights: ReadonlyMap<string, number>): number {
  if (weights.size === 0 || !post.content) return 0;
  const terms = tokenizePostSearch(post.content)
    .filter((term) => term.length > 2 && !TOPIC_STOP_WORDS.has(term));
  if (terms.length === 0) return 0;
  const total = terms.reduce((score, term) => score + boundedNumber(weights.get(term), 20), 0);
  return Math.min(2, Math.log1p(total) * 0.55);
}

function engagementValue(signal: ForYouEngagementSignal | undefined): number {
  if (!signal) return 0;
  return boundedNumber(signal.likes)
    + boundedNumber(signal.reposts) * 2.5
    + boundedNumber(signal.replies) * 1.5;
}

function scoreCandidate(
  post: Post,
  signals: ForYouViewerSignals,
  snapshotAt: number,
): ScoredCandidate | null {
  const postKey = forYouPostKey(post);
  if (signals.negativePosts.has(postKey)) return null;

  const nodeKey = (post.nodeDomain || post.author.nodeDomain || signals.localNodeDomain)
    .trim().toLowerCase();
  const authorKey = canonicalForYouAuthor(post.author.handle, nodeKey);
  const activityAt = new Date(post.feedActivityAt || post.createdAt).getTime();
  const safeActivityAt = Number.isFinite(activityAt) ? Math.min(activityAt, snapshotAt) : 0;
  if (safeActivityAt > snapshotAt) return null;
  const ageHours = Math.max(0, (snapshotAt - safeActivityAt) / 3_600_000);

  // Two decay curves keep the first page fresh without making older posts
  // permanently ineligible for a deep infinite scroll.
  const freshness = Math.exp(-ageHours / 36) * 1.65
    + Math.exp(-ageHours / (24 * 21)) * 0.35;
  const localEngagement = engagementValue(signals.postEngagement.get(postKey));
  const engagement = Math.log1p(localEngagement) * 0.72
    + Math.log1p(localEngagement / Math.sqrt(ageHours + 2)) * 0.4;
  const social = Math.log1p(engagementValue(signals.socialEngagement.get(postKey))) * 0.78;
  const affinityRaw = boundedNumber(signals.authorAffinity.get(authorKey), 100);
  const followed = signals.followedAuthors.has(authorKey);
  const affinity = (followed ? 1.4 : 0) + Math.min(2.5, Math.log1p(affinityRaw) * 0.72);
  const topic = topicScore(post, signals.topicWeights);
  const negative = Math.min(3,
    Math.log1p(boundedNumber(signals.authorDisinterest.get(authorKey), 100)) * 1.15
    + topicScore(post, signals.negativeTopicWeights) * 1.2);
  const confidence = Math.max(0, Math.min(1, signals.personalizationConfidence));
  const seen = signals.seenPosts.get(postKey);
  let seenPenalty = 0;
  if (seen) {
    const seenAgeHours = Math.max(0, (snapshotAt - seen.lastSeenAt.getTime()) / 3_600_000);
    const recentPenalty = seenAgeHours < 24 ? 4.5 : seenAgeHours < 168 ? 2.2 : 0.65;
    seenPenalty = recentPenalty + Math.min(1.5, Math.log1p(seen.count) * 0.45);
  }

  const localNodeBoost = nodeKey === signals.localNodeDomain ? 0.34 * (1 - confidence) : 0;
  const exploration = stableExplorationValue(signals.viewerHandle, postKey, snapshotAt)
    * (0.42 - confidence * 0.2);
  const ownPostPenalty = authorKey === signals.viewerHandle ? 0.8 : 0;
  const personalized = affinity + social + topic;
  const baseScore = freshness
    + engagement
    + personalized * (0.38 + confidence * 0.62)
    + localNodeBoost
    + exploration
    - negative
    - seenPenalty
    - ownPostPenalty;

  const reasons: string[] = [];
  if (followed) reasons.push('From someone you follow');
  if (affinityRaw >= 2) reasons.push('Based on posts you interact with');
  if (social >= 0.5) reasons.push('People you follow are engaging');
  if (topic >= 0.45) reasons.push('Matches topics you engage with');
  if (localEngagement >= 3) reasons.push('Active on your node');
  if (ageHours <= 6) reasons.push('Posted recently');
  if (!seen) reasons.push('New to you');
  if (reasons.length === 0) reasons.push('From across the Synapsis network');

  return {
    post,
    postKey,
    authorKey,
    nodeKey,
    format: forYouFormat(post),
    activityAt: safeActivityAt,
    baseScore,
    reasons,
    signals: {
      freshness: roundScore(freshness),
      engagement: roundScore(engagement),
      social: roundScore(social),
      affinity: roundScore(affinity),
      topic: roundScore(topic),
      negative: roundScore(negative),
      seenPenalty: roundScore(seenPenalty),
      diversityPenalty: 0,
    },
  };
}

/**
 * Score the complete eligible corpus, then greedily choose a page while
 * carrying short-term diversity across page boundaries. The page limit is not
 * a candidate limit: every unserved candidate participates in every choice.
 */
export function rankForYouFeed(
  posts: Post[],
  viewerSignals: ForYouViewerSignals,
  options: {
    limit: number;
    snapshotAt?: number;
    state?: ForYouDiversityState;
  },
): RankForYouResult {
  const snapshotAt = options.snapshotAt ?? Date.now();
  const limit = Math.max(0, Math.min(50, Math.floor(options.limit)));
  let state = options.state ?? emptyForYouDiversityState();
  const remaining = posts
    .map((post) => scoreCandidate(post, viewerSignals, snapshotAt))
    .filter((candidate): candidate is ScoredCandidate => candidate !== null);
  const selected: ForYouFeedPost[] = [];

  while (remaining.length > 0 && selected.length < limit) {
    let bestIndex = 0;
    let bestScore = Number.NEGATIVE_INFINITY;
    let bestPenalty = 0;

    remaining.forEach((candidate, index) => {
      const authorRepeats = occurrences(state.recentAuthors, candidate.authorKey);
      const nodeRepeats = occurrences(state.recentNodes, candidate.nodeKey);
      const formatRepeats = occurrences(state.recentFormats, candidate.format);
      const previousAuthor = state.recentAuthors.at(-1);
      const previousNode = state.recentNodes.at(-1);
      const diversityPenalty = authorRepeats * 0.72
        + nodeRepeats * 0.16
        + Math.max(0, formatRepeats - 1) * 0.08
        + (previousAuthor === candidate.authorKey ? 0.95 : 0)
        + (previousNode === candidate.nodeKey ? 0.18 : 0);
      const score = candidate.baseScore - diversityPenalty;
      const best = remaining[bestIndex];
      if (
        score > bestScore
        || (score === bestScore && candidate.baseScore > best.baseScore)
        || (score === bestScore && candidate.baseScore === best.baseScore && candidate.activityAt > best.activityAt)
        || (score === bestScore && candidate.baseScore === best.baseScore
          && candidate.activityAt === best.activityAt && candidate.postKey < best.postKey)
      ) {
        bestIndex = index;
        bestScore = score;
        bestPenalty = diversityPenalty;
      }
    });

    const [winner] = remaining.splice(bestIndex, 1);
    const reasons = [...winner.reasons];
    if (selected.length > 0 && !state.recentAuthors.includes(winner.authorKey)) {
      reasons.push('A different voice');
    }
    if (selected.length > 0 && !state.recentNodes.includes(winner.nodeKey)) {
      reasons.push('A different community');
    }
    selected.push({
      ...winner.post,
      feedMeta: {
        algorithm: FOR_YOU_ALGORITHM,
        score: roundScore(bestScore),
        reasons: Array.from(new Set(reasons)).slice(0, 4),
        signals: {
          ...winner.signals,
          diversityPenalty: roundScore(bestPenalty),
        },
      },
    });
    state = {
      recentAuthors: pushRecent(state.recentAuthors, winner.authorKey, RECENT_AUTHOR_LIMIT),
      recentNodes: pushRecent(state.recentNodes, winner.nodeKey, RECENT_NODE_LIMIT),
      recentFormats: pushRecent(state.recentFormats, winner.format, RECENT_FORMAT_LIMIT),
    };
  }

  return { posts: selected, state, remainingCount: remaining.length };
}
