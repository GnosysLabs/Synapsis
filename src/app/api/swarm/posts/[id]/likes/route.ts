/**
 * Swarm Post Likes Endpoint
 * 
 * GET: Check who has liked a post (for real-time like status)
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { z } from 'zod';
import { authorizeFederationRead, federationReadFailureResponse } from '@/lib/swarm/signed-read';
import { requireLocalNodeNsfwClassification } from '@/lib/node/local-node';
import { isPostSensitive } from '@/lib/nsfw/content-visibility';
import { hasStrictLocalUserOrigin } from '@/lib/swarm/local-user-origin';
import { resolveAccountAddress } from '@/lib/identity/account-address';
import { federatedHandleSchema, nodeDomainSchema } from '@/lib/utils/federation';
import {
  getCanonicalSwarmSeedDomain,
  normalizeNodeDomain,
} from '@/lib/swarm/node-domain';

type RouteContext = { params: Promise<{ id: string }> };

// Schema for post ID parameter
const postIdSchema = z.string().uuid('Invalid post ID format');

// Schema for query parameters
const likesQuerySchema = z.object({
  checkHandle: federatedHandleSchema.optional(),
  checkDomain: nodeDomainSchema.optional(),
});

function canonicalNodeDomain(value: string): string {
  const normalized = normalizeNodeDomain(value);
  return getCanonicalSwarmSeedDomain(normalized) ?? normalized;
}

/**
 * GET /api/swarm/posts/[id]/likes
 * 
 * Returns like information for a post.
 * Query params:
 *   - checkHandle: Check if a specific handle has liked this post
 *   - checkDomain: The domain of the user to check (required with checkHandle for remote users)
 */
export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const readAuthorization = await authorizeFederationRead(request);
    if (!readAuthorization.ok) return federationReadFailureResponse(readAuthorization);
    if (!db) {
      return NextResponse.json({ error: 'Database not available' }, { status: 503 });
    }

    const { id: rawId } = await context.params;
    
    // Validate post ID
    const idResult = postIdSchema.safeParse(rawId);
    if (!idResult.success) {
      return NextResponse.json({ error: 'Invalid post ID', details: idResult.error.issues }, { status: 400 });
    }
    const postId = idResult.data;
    
    const { searchParams } = new URL(request.url);
    
    // Validate query parameters
    const queryResult = likesQuerySchema.safeParse({
      checkHandle: searchParams.get('checkHandle') || undefined,
      checkDomain: searchParams.get('checkDomain') || undefined,
    });
    
    if (!queryResult.success) {
      return NextResponse.json({ error: 'Invalid query parameters', details: queryResult.error.issues }, { status: 400 });
    }
    
    const { checkHandle, checkDomain } = queryResult.data;

    // Find the post
    const post = await db.query.posts.findFirst({
      where: { id: postId },
      with: { author: true },
    });

    if (!post || post.isRemoved) {
      return NextResponse.json({ error: 'Post not found' }, { status: 404 });
    }
    if (!post.author || !hasStrictLocalUserOrigin(post.author)) {
      return NextResponse.json({ error: 'Post not found' }, { status: 404 });
    }

    const trustedReadSource = readAuthorization.sourceDomain;
    const trustedRead = true;
    const localNodeIsNsfw = await requireLocalNodeNsfwClassification();
    const authorIsLocal = true;
    const sensitive = isPostSensitive({
      postIsNsfw: post.isNsfw,
      authorIsNsfw: post.author.isNsfw,
      nodeIsNsfw: authorIsLocal ? localNodeIsNsfw : undefined,
      isRemote: !authorIsLocal,
    });
    if ((sensitive || checkHandle) && !trustedRead) {
      return NextResponse.json(
        { error: 'Trusted federation read required' },
        { status: 403, headers: { 'Cache-Control': 'private, no-store' } },
      );
    }
    const privateHeaders = { 'Cache-Control': 'private, no-store' };

    // If checking a specific handle
    if (checkHandle) {
      const authenticatedSource = trustedReadSource
        ? canonicalNodeDomain(trustedReadSource)
        : null;
      const claimedSource = checkDomain ? canonicalNodeDomain(checkDomain) : null;
      const actorAddress = claimedSource
        ? resolveAccountAddress(checkHandle, claimedSource)
        : null;

      // Actor-specific state may only be queried by that actor's home node.
      // A node signature authenticates the peer; it does not authorize that
      // peer to enumerate arbitrary local users' relationship state.
      if (!authenticatedSource
        || !claimedSource
        || claimedSource !== authenticatedSource
        || !actorAddress
        || actorAddress.homeDomain !== authenticatedSource) {
        return NextResponse.json(
          { error: 'Like-state checks must be scoped to the authenticated source node' },
          { status: 403, headers: privateHeaders },
        );
      }

      const remoteLike = await db.query.remoteLikes.findFirst({
        where: {
          AND: [
            { postId },
            { actorHandle: actorAddress.canonical },
            { actorNodeDomain: authenticatedSource },
          ],
        },
      });

      return NextResponse.json({
        postId,
        likesCount: post.likesCount,
        isLiked: !!remoteLike,
        checkedHandle: actorAddress.canonical,
        checkedDomain: authenticatedSource,
      }, { headers: privateHeaders });
    }

    // Return general like info
    return NextResponse.json({
      postId,
      likesCount: post.likesCount,
    }, { headers: privateHeaders });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid input', details: error.issues }, { status: 400 });
    }
    console.error('[Swarm] Post likes error:', error);
    return NextResponse.json({ error: 'Failed to get likes' }, { status: 500 });
  }
}
