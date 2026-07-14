/**
 * Swarm Post Likes Endpoint
 * 
 * GET: Check who has liked a post (for real-time like status)
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, posts, likes, users, remoteLikes } from '@/db';
import { eq, and } from 'drizzle-orm';
import { z } from 'zod';

type RouteContext = { params: Promise<{ id: string }> };

// Schema for post ID parameter
const postIdSchema = z.string().uuid('Invalid post ID format');

// Schema for query parameters
const likesQuerySchema = z.object({
  checkHandle: z.string().min(3).max(30).optional(),
  checkDomain: z.string().min(1).max(100).optional(),
});

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
    });

    if (!post || post.isRemoved) {
      return NextResponse.json({ error: 'Post not found' }, { status: 404 });
    }

    // If checking a specific handle
    if (checkHandle) {
      // If domain is provided, check remote likes
      if (checkDomain) {
        const remoteLike = await db.query.remoteLikes.findFirst({
          where: { AND: [{ postId: postId }, { actorHandle: checkHandle }, { actorNodeDomain: checkDomain }] },
        });

        return NextResponse.json({
          postId,
          likesCount: post.likesCount,
          isLiked: !!remoteLike,
          checkedHandle: checkHandle,
          checkedDomain: checkDomain,
        });
      }

      // No domain = local user
      const localUser = await db.query.users.findFirst({
        where: { handle: checkHandle },
      });

      if (localUser) {
        const liked = await db.query.likes.findFirst({
          where: { AND: [{ postId: postId }, { userId: localUser.id }] },
        });

        return NextResponse.json({
          postId,
          likesCount: post.likesCount,
          isLiked: !!liked,
          checkedHandle: checkHandle,
        });
      }

      return NextResponse.json({
        postId,
        likesCount: post.likesCount,
        isLiked: false,
        checkedHandle: checkHandle,
      });
    }

    // Return general like info
    return NextResponse.json({
      postId,
      likesCount: post.likesCount,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid input', details: error.issues }, { status: 400 });
    }
    console.error('[Swarm] Post likes error:', error);
    return NextResponse.json({ error: 'Failed to get likes' }, { status: 500 });
  }
}
