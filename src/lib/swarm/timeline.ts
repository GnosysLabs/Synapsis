/**
 * Swarm Timeline
 * 
 * Fetches and aggregates posts from across the swarm network.
 */

import { getActiveSwarmNodes } from './registry';
import type { SwarmPost } from '@/app/api/swarm/timeline/route';
import { filterBlockedDomains, isNodeBlocked, normalizeNodeDomain } from './node-blocklist';
import { feedActivityDate, getSourceContinuationDate } from '@/lib/posts/feed-pagination';
import { isPostSensitive } from '@/lib/nsfw/content-visibility';
import { signedFederationRead } from './signed-read';
import { parseRemoteTimelineResponse } from './remote-timeline-payload';
import { mapWithConcurrency } from '@/lib/async/concurrency';

const MAX_FEDERATION_NODES_PER_TIMELINE = 24;
const MAX_CONCURRENT_TIMELINE_FETCHES = 6;
const MAX_AGGREGATED_TIMELINE_POSTS = 200;

interface TimelineResult {
  posts: SwarmPost[];
  sources: { domain: string; postCount: number; filteredCount?: number; isNsfw?: boolean; error?: string }[];
  fetchedAt: string;
  continuationDate: string | null;
}

interface TimelineOptions {
  includeNsfw?: boolean; // Whether to include NSFW content
  cursor?: string; // Timestamp cursor for pagination
  query?: string; // Optional post-content search query
  excludeDomains?: ReadonlySet<string>;
}

function isReplyPost(post: SwarmPost): boolean {
  return Boolean(
    post.isReply ||
    post.replyToId ||
    post.swarmReplyToId ||
    // Defensive against older or non-conforming node payloads.
    (post as SwarmPost & { replyTo?: unknown }).replyTo
  );
}

function isSensitiveSwarmPost(
  post: SwarmPost,
  fallbackNodeIsNsfw?: boolean,
): boolean {
  const nodeIsNsfw = typeof post.nodeIsNsfw === 'boolean'
    ? post.nodeIsNsfw || fallbackNodeIsNsfw === true
    : fallbackNodeIsNsfw;
  if (isPostSensitive({
    postIsNsfw: post.isNsfw,
    authorIsNsfw: post.author?.isNsfw,
    nodeIsNsfw,
    isRemote: true,
  })) {
    return true;
  }

  if (post.repostOf && isSensitiveSwarmPost(post.repostOf, post.repostOf.nodeIsNsfw)) {
    return true;
  }
  const legacyReply = (post as SwarmPost & { replyTo?: SwarmPost | null }).replyTo;
  return Boolean(legacyReply && isSensitiveSwarmPost(legacyReply, legacyReply.nodeIsNsfw));
}

/**
 * Fetch timeline from a single node
 */
async function fetchNodeTimeline(
  domain: string,
  limit: number = 20,
  cursor?: string,
  query?: string,
): Promise<{ posts: SwarmPost[]; nodeIsNsfw?: boolean; error?: string }> {
  try {
    const normalizedDomain = normalizeNodeDomain(domain);
    if (await isNodeBlocked(normalizedDomain)) {
      return { posts: [], error: 'Blocked node' };
    }

    // Determine protocol - use http for localhost, https for everything else
    let baseUrl: string;
    if (domain.startsWith('http')) {
      baseUrl = domain;
    } else if (normalizedDomain.startsWith('localhost') || normalizedDomain.startsWith('127.0.0.1')) {
      baseUrl = `http://${normalizedDomain}`;
    } else {
      baseUrl = `https://${normalizedDomain}`;
    }
    const url = `${baseUrl}/api/swarm/timeline?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}${query ? `&q=${encodeURIComponent(query)}` : ''}`;

    const response = await signedFederationRead(url, {
      headers: { 'Accept': 'application/json' },
      timeoutMs: 5_000,
      maxResponseBytes: 1024 * 1024,
    });

    if (response.status < 200 || response.status >= 300) {
      return { posts: [], error: `HTTP ${response.status}` };
    }

    return parseRemoteTimelineResponse(response.json(), normalizedDomain);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { posts: [], error: message };
  }
}

/**
 * Fetch aggregated timeline from the swarm
 * 
 * Queries multiple nodes in parallel and merges results.
 * Filters out NSFW content unless explicitly requested.
 */
export async function fetchSwarmTimeline(
  maxNodes: number | undefined = undefined,
  postsPerNode: number = 10,
  options: TimelineOptions = {}
): Promise<TimelineResult> {
  const { includeNsfw = false, cursor, query, excludeDomains } = options;
  const effectiveMaxNodes = Math.max(1, Math.min(
    maxNodes ?? MAX_FEDERATION_NODES_PER_TIMELINE,
    MAX_FEDERATION_NODES_PER_TIMELINE,
  ));
  const effectivePostsPerNode = Math.max(1, Math.min(postsPerNode, 50));

  // Get active nodes to query
  const nodes = await getActiveSwarmNodes(effectiveMaxNodes);

  // Always include our own posts
  const ourDomain = normalizeNodeDomain(process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost');

  // Always query all nodes - we filter posts, not nodes
  const normalizedExcludedDomains = new Set(
    Array.from(excludeDomains || []).map(normalizeNodeDomain),
  );
  const candidateDomains = [
    ourDomain,
    ...nodes.map(n => n.domain).filter(d => d !== ourDomain)
  ].filter((domain) => !normalizedExcludedDomains.has(normalizeNodeDomain(domain)));
  const allowedDomains = await filterBlockedDomains(candidateDomains);
  const nodesToQuery = allowedDomains.slice(0, effectiveMaxNodes);
  const knownNsfwByDomain = new Map(
    nodes.map((node) => [normalizeNodeDomain(node.domain), node.isNsfw]),
  );

  console.log(`[Swarm Timeline] Querying ${nodesToQuery.length} nodes: ${nodesToQuery.join(', ')}`);
  console.log(`[Swarm Timeline] includeNsfw: ${includeNsfw}, cursor: ${cursor || 'none'}`);

  // Fetch from all nodes in parallel
  const results = await mapWithConcurrency(
    nodesToQuery,
    MAX_CONCURRENT_TIMELINE_FETCHES,
    async (domain) => {
      const result = await fetchNodeTimeline(domain, effectivePostsPerNode, cursor, query);
      return {
        domain,
        knownNodeIsNsfw: knownNsfwByDomain.get(normalizeNodeDomain(domain)),
        ...result,
      };
    },
  );

  // Collect all posts and track sources
  const allPosts: SwarmPost[] = [];
  const sources: TimelineResult['sources'] = [];

  for (const result of results) {
    const nonReplyPosts = result.posts.filter(post => !isReplyPost(post));
    const effectiveNodeIsNsfw = result.knownNodeIsNsfw === true
      || result.nodeIsNsfw === true;

    // Filter NSFW posts only if user doesn't want NSFW content
    // A post is NSFW if it's explicitly marked OR comes from an NSFW node
    const filteredPosts = includeNsfw
      ? nonReplyPosts
      : nonReplyPosts.filter((post) => !isSensitiveSwarmPost(
          post,
          typeof result.nodeIsNsfw === 'boolean' || typeof result.knownNodeIsNsfw === 'boolean'
            ? effectiveNodeIsNsfw
            : undefined,
        ));

    // Log filtering details for debugging
    const nsfwPosts = nonReplyPosts.filter(p => p.isNsfw);
    const nodeNsfwPosts = nonReplyPosts.filter(p => p.nodeIsNsfw);
    const replyPosts = result.posts.length - nonReplyPosts.length;
    console.log(`[Swarm Timeline] ${result.domain}: ${result.posts.length} posts fetched, ${replyPosts} replies filtered, ${nsfwPosts.length} marked NSFW, ${nodeNsfwPosts.length} from NSFW node, ${filteredPosts.length} after filter (includeNsfw: ${includeNsfw})`);

    sources.push({
      domain: result.domain,
      postCount: result.posts.length,
      filteredCount: filteredPosts.length,
      isNsfw: typeof result.nodeIsNsfw === 'boolean' || typeof result.knownNodeIsNsfw === 'boolean'
        ? effectiveNodeIsNsfw
        : undefined,
      error: result.error,
    });

    allPosts.push(...filteredPosts);
  }

  // Sort by createdAt descending and dedupe by id
  const seen = new Set<string>();
  const uniquePosts = allPosts
    .sort((a, b) => feedActivityDate(b).getTime() - feedActivityDate(a).getTime())
    .filter(post => {
      const key = `${post.nodeDomain}:${post.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_AGGREGATED_TIMELINE_POSTS);

  return {
    // Never background-fetch arbitrary URLs embedded by a hostile peer. A
    // remote post may supply bounded preview metadata, or clients render its
    // ordinary link without disclosing this node's IP/timing to that target.
    posts: uniquePosts,
    sources,
    fetchedAt: new Date().toISOString(),
    continuationDate: getSourceContinuationDate(results, effectivePostsPerNode)?.toISOString() || null,
  };
}
