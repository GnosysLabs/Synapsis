/**
 * Swarm Timeline
 * 
 * Fetches and aggregates posts from across the swarm network.
 */

import { getActiveSwarmNodes } from './registry';
import type { SwarmPost } from '@/app/api/swarm/timeline/route';

interface TimelineResult {
  posts: SwarmPost[];
  sources: { domain: string; postCount: number; filteredCount?: number; isNsfw?: boolean; error?: string }[];
  fetchedAt: string;
}

interface TimelineOptions {
  includeNsfw?: boolean; // Whether to include NSFW content
  cursor?: string; // Timestamp cursor for pagination
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

/**
 * Extract the first URL from post content
 */
function extractFirstUrl(content: string): string | null {
  const urlMatch = content.match(/https?:\/\/[^\s<>"{}|\\^`[\]]+/);
  if (!urlMatch) return null;
  // Clean trailing punctuation
  return urlMatch[0].replace(/[)\].,!?;:]+$/, '');
}

/**
 * Fetch link preview for a URL
 */
async function fetchLinkPreview(url: string): Promise<{
  url: string;
  title: string | null;
  description: string | null;
  image: string | null;
} | null> {
  try {
    const nodeDomain = process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost';
    const protocol = nodeDomain === 'localhost' ? 'http' : 'https';
    const previewUrl = `${protocol}://${nodeDomain}/api/media/preview?url=${encodeURIComponent(url)}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000); // 3s timeout for previews

    const response = await fetch(previewUrl, {
      headers: { 'Accept': 'application/json' },
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) return null;

    const data = await response.json();
    return {
      url: data.url || url,
      title: data.title || null,
      description: data.description || null,
      image: data.image || null,
    };
  } catch {
    return null;
  }
}

/**
 * Enrich swarm posts with link previews if they have URLs but no preview data
 */
async function enrichPostsWithPreviews(posts: SwarmPost[]): Promise<SwarmPost[]> {
  const enrichmentPromises = posts.map(async (post) => {
    // Skip if already has link preview data
    if (post.linkPreviewUrl) return post;

    // Extract URL from content
    const url = extractFirstUrl(post.content);
    if (!url) return post;

    // Skip video URLs (handled by VideoEmbed component)
    if (url.match(/(youtube\.com|youtu\.be|vimeo\.com)/)) return post;

    // Fetch preview
    const preview = await fetchLinkPreview(url);
    if (!preview) return post;

    return {
      ...post,
      linkPreviewUrl: preview.url,
      linkPreviewTitle: preview.title || undefined,
      linkPreviewDescription: preview.description || undefined,
      linkPreviewImage: preview.image || undefined,
    };
  });

  return Promise.all(enrichmentPromises);
}

/**
 * Fetch timeline from a single node
 */
async function fetchNodeTimeline(
  domain: string,
  limit: number = 20,
  cursor?: string
): Promise<{ posts: SwarmPost[]; nodeIsNsfw?: boolean; error?: string }> {
  try {
    // Determine protocol - use http for localhost, https for everything else
    let baseUrl: string;
    if (domain.startsWith('http')) {
      baseUrl = domain;
    } else if (domain.startsWith('localhost') || domain.startsWith('127.0.0.1')) {
      baseUrl = `http://${domain}`;
    } else {
      baseUrl = `https://${domain}`;
    }
    const url = `${baseUrl}/api/swarm/timeline?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000); // 5s timeout

    const response = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      return { posts: [], error: `HTTP ${response.status}` };
    }

    const data = await response.json();
    return { posts: data.posts || [], nodeIsNsfw: data.nodeIsNsfw };
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
  maxNodes: number = 10,
  postsPerNode: number = 10,
  options: TimelineOptions = {}
): Promise<TimelineResult> {
  const { includeNsfw = false, cursor } = options;

  // Get active nodes to query
  const nodes = await getActiveSwarmNodes(maxNodes);

  // Always include our own posts
  const ourDomain = process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost';

  // Always query all nodes - we filter posts, not nodes
  const nodesToQuery = [
    ourDomain,
    ...nodes.map(n => n.domain).filter(d => d !== ourDomain)
  ].slice(0, maxNodes);

  console.log(`[Swarm Timeline] Querying ${nodesToQuery.length} nodes: ${nodesToQuery.join(', ')}`);
  console.log(`[Swarm Timeline] includeNsfw: ${includeNsfw}, cursor: ${cursor || 'none'}`);

  // Fetch from all nodes in parallel
  const results = await Promise.all(
    nodesToQuery.map(async (domain) => {
      const result = await fetchNodeTimeline(domain, postsPerNode, cursor);
      return {
        domain,
        ...result,
      };
    })
  );

  // Collect all posts and track sources
  const allPosts: SwarmPost[] = [];
  const sources: TimelineResult['sources'] = [];

  for (const result of results) {
    const nonReplyPosts = result.posts.filter(post => !isReplyPost(post));

    // Filter NSFW posts only if user doesn't want NSFW content
    // A post is NSFW if it's explicitly marked OR comes from an NSFW node
    const filteredPosts = includeNsfw
      ? nonReplyPosts
      : nonReplyPosts.filter(p => !p.isNsfw && !p.nodeIsNsfw);

    // Log filtering details for debugging
    const nsfwPosts = nonReplyPosts.filter(p => p.isNsfw);
    const nodeNsfwPosts = nonReplyPosts.filter(p => p.nodeIsNsfw);
    const replyPosts = result.posts.length - nonReplyPosts.length;
    console.log(`[Swarm Timeline] ${result.domain}: ${result.posts.length} posts fetched, ${replyPosts} replies filtered, ${nsfwPosts.length} marked NSFW, ${nodeNsfwPosts.length} from NSFW node, ${filteredPosts.length} after filter (includeNsfw: ${includeNsfw})`);

    sources.push({
      domain: result.domain,
      postCount: result.posts.length,
      filteredCount: filteredPosts.length,
      isNsfw: result.nodeIsNsfw,
      error: result.error,
    });

    allPosts.push(...filteredPosts);
  }

  // Sort by createdAt descending and dedupe by id
  const seen = new Set<string>();
  const uniquePosts = allPosts
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .filter(post => {
      const key = `${post.nodeDomain}:${post.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  // Enrich posts that have URLs but no link preview data
  const enrichedPosts = await enrichPostsWithPreviews(uniquePosts);

  return {
    posts: enrichedPosts,
    sources,
    fetchedAt: new Date().toISOString(),
  };
}
