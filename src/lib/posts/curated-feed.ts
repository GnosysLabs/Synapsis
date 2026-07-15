import type { Post } from '@/lib/types';

export const CURATED_FEED_WINDOW_HOURS = 72;

export const CURATED_FEED_WEIGHTS = {
  engagement: 1,
  recency: 0.45,
  authorRepeat: 1.15,
  nodeRepeat: 0.4,
  formatRepeat: 0.18,
  consecutiveAuthor: 0.85,
  consecutiveNode: 0.25,
} as const;

type CuratedFormat = 'repost' | 'media' | 'link' | 'text';

export interface CuratedFeedMeta {
  score: number;
  baseScore: number;
  reasons: string[];
  engagement: {
    likes: number;
    reposts: number;
    replies: number;
  };
  diversity: {
    authorPenalty: number;
    nodePenalty: number;
    formatPenalty: number;
    adjacencyPenalty: number;
  };
}

export type CuratedFeedPost = Post & { feedMeta: CuratedFeedMeta };

interface RankOptions {
  limit?: number;
  now?: number;
  windowHours?: number;
}

interface Candidate {
  post: Post;
  authorKey: string;
  nodeKey: string;
  format: CuratedFormat;
  createdAt: number;
  ageHours: number;
  engagement: number;
  baseScore: number;
}

function normalizedHandle(handle: string): string {
  return handle.trim().toLowerCase().replace(/^@/, '').split('@')[0];
}

function nodeKeyFor(post: Post): string {
  return (post.nodeDomain || post.author.nodeDomain || 'local').trim().toLowerCase();
}

function authorKeyFor(post: Post): string {
  return `${nodeKeyFor(post)}:${normalizedHandle(post.author.handle)}`;
}

function formatFor(post: Post): CuratedFormat {
  if (post.repostOf || post.repostOfId) return 'repost';
  if (post.media?.length) return 'media';
  if (post.linkPreviewUrl) return 'link';
  return 'text';
}

function increment(map: Map<string, number>, key: string) {
  map.set(key, (map.get(key) || 0) + 1);
}

function roundScore(value: number): number {
  return Number(value.toFixed(3));
}

function baseReasons(candidate: Candidate): string[] {
  const post = candidate.post;
  const reasons = [`From ${candidate.nodeKey}`];

  if (candidate.engagement >= 5) {
    reasons.push(`Popular: ${post.likesCount || 0} likes, ${post.repostsCount || 0} reposts`);
  } else if ((post.repliesCount || 0) > 0) {
    reasons.push(`Active conversation: ${post.repliesCount} replies`);
  }

  if (candidate.ageHours <= 6) {
    reasons.push('Posted recently');
  } else if (candidate.ageHours <= 24) {
    reasons.push('Posted today');
  }

  return reasons;
}

/**
 * Rank a relevance-scored pool with a maximal-marginal-relevance style pass.
 * Repeated authors, nodes, and formats receive progressively larger penalties,
 * with extra protection against adjacent posts from the same source.
 */
export function rankCuratedFeed(posts: Post[], options: RankOptions = {}): CuratedFeedPost[] {
  const now = options.now ?? Date.now();
  const limit = Math.max(0, options.limit ?? posts.length);
  const windowHours = options.windowHours ?? CURATED_FEED_WINDOW_HOURS;

  const remaining: Candidate[] = posts.map((post) => {
    const createdAt = new Date(post.createdAt).getTime();
    const ageHours = Number.isFinite(createdAt)
      ? Math.max(0, (now - createdAt) / 3_600_000)
      : windowHours;
    const engagement = (post.likesCount || 0)
      + (post.repostsCount || 0) * 2
      + (post.repliesCount || 0) * 0.75;
    const engagementScore = Math.min(2.5, Math.log1p(Math.max(0, engagement)));
    const recencyScore = Math.max(0, 1 - ageHours / windowHours);

    return {
      post,
      authorKey: authorKeyFor(post),
      nodeKey: nodeKeyFor(post),
      format: formatFor(post),
      createdAt: Number.isFinite(createdAt) ? createdAt : 0,
      ageHours,
      engagement,
      baseScore: engagementScore * CURATED_FEED_WEIGHTS.engagement
        + recencyScore * CURATED_FEED_WEIGHTS.recency,
    };
  });

  const authorCounts = new Map<string, number>();
  const nodeCounts = new Map<string, number>();
  const formatCounts = new Map<string, number>();
  const selected: CuratedFeedPost[] = [];
  let previous: Candidate | null = null;

  while (remaining.length > 0 && selected.length < limit) {
    let bestIndex = 0;
    let bestScore = Number.NEGATIVE_INFINITY;
    let bestDiversity = {
      authorPenalty: 0,
      nodePenalty: 0,
      formatPenalty: 0,
      adjacencyPenalty: 0,
    };

    remaining.forEach((candidate, index) => {
      const authorRepeats = authorCounts.get(candidate.authorKey) || 0;
      const nodeRepeats = nodeCounts.get(candidate.nodeKey) || 0;
      const formatRepeats = formatCounts.get(candidate.format) || 0;
      const authorPenalty = authorRepeats === 0
        ? 0
        : CURATED_FEED_WEIGHTS.authorRepeat * (1 + (authorRepeats - 1) * 0.35);
      const nodePenalty = nodeRepeats * CURATED_FEED_WEIGHTS.nodeRepeat;
      const formatPenalty = formatRepeats * CURATED_FEED_WEIGHTS.formatRepeat;
      const adjacencyPenalty = previous
        ? (previous.authorKey === candidate.authorKey ? CURATED_FEED_WEIGHTS.consecutiveAuthor : 0)
          + (previous.nodeKey === candidate.nodeKey ? CURATED_FEED_WEIGHTS.consecutiveNode : 0)
        : 0;
      const score = candidate.baseScore - authorPenalty - nodePenalty - formatPenalty - adjacencyPenalty;

      const bestCandidate = remaining[bestIndex];
      if (
        score > bestScore
        || (score === bestScore && candidate.baseScore > bestCandidate.baseScore)
        || (score === bestScore && candidate.baseScore === bestCandidate.baseScore && candidate.createdAt > bestCandidate.createdAt)
        || (score === bestScore && candidate.baseScore === bestCandidate.baseScore
          && candidate.createdAt === bestCandidate.createdAt && candidate.post.id < bestCandidate.post.id)
      ) {
        bestIndex = index;
        bestScore = score;
        bestDiversity = { authorPenalty, nodePenalty, formatPenalty, adjacencyPenalty };
      }
    });

    const [winner] = remaining.splice(bestIndex, 1);
    const reasons = baseReasons(winner);
    if (selected.length > 0 && (authorCounts.get(winner.authorKey) || 0) === 0) {
      reasons.push('A different voice');
    }
    if (selected.length > 0 && (nodeCounts.get(winner.nodeKey) || 0) === 0) {
      reasons.push('A different community');
    }
    if (selected.length > 0 && (formatCounts.get(winner.format) || 0) === 0) {
      reasons.push('A different kind of post');
    }
    if (reasons.length === 1) {
      reasons.push('Worth discovering');
    }

    selected.push({
      ...winner.post,
      feedMeta: {
        score: roundScore(bestScore),
        baseScore: roundScore(winner.baseScore),
        reasons,
        engagement: {
          likes: winner.post.likesCount || 0,
          reposts: winner.post.repostsCount || 0,
          replies: winner.post.repliesCount || 0,
        },
        diversity: {
          authorPenalty: roundScore(bestDiversity.authorPenalty),
          nodePenalty: roundScore(bestDiversity.nodePenalty),
          formatPenalty: roundScore(bestDiversity.formatPenalty),
          adjacencyPenalty: roundScore(bestDiversity.adjacencyPenalty),
        },
      },
    });

    increment(authorCounts, winner.authorKey);
    increment(nodeCounts, winner.nodeKey);
    increment(formatCounts, winner.format);
    previous = winner;
  }

  return selected;
}
