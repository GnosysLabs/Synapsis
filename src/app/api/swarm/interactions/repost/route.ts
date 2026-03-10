/**
 * Swarm Repost Endpoint
 * 
 * POST: Receive a repost from another swarm node
 * 
 * SECURITY: All requests must be cryptographically signed by the sender.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, posts, users, notifications, remoteReposts } from '@/db';
import { eq, sql, and } from 'drizzle-orm';
import { z } from 'zod';
import { verifySwarmRequest } from '@/lib/swarm/signature';
import { localHandleSchema, nodeDomainSchema } from '@/lib/utils/federation';
import { buildNotificationTarget } from '@/lib/notifications';

const swarmRepostSchema = z.object({
  postId: z.string().uuid(),
  repost: z.object({
    actorHandle: localHandleSchema,
    actorDisplayName: z.string().min(1).max(50),
    actorAvatarUrl: z.string().url().optional(),
    actorNodeDomain: nodeDomainSchema,
    repostId: z.string().uuid(),
    interactionId: z.string().uuid(),
    timestamp: z.string().datetime(),
  }),
  signature: z.string().min(1),
});

/**
 * POST /api/swarm/interactions/repost
 * 
 * Receives a repost notification from another swarm node.
 */
export async function POST(request: NextRequest) {
  try {
    if (!db) {
      return NextResponse.json({ error: 'Database not available' }, { status: 503 });
    }

    const body = await request.json();
    const data = swarmRepostSchema.parse(body);

    // SECURITY: Verify the signature
    const { signature, ...payload } = data;
    const isValid = await verifySwarmRequest(payload, signature, data.repost.actorNodeDomain);

    if (!isValid) {
      console.warn(`[Swarm] Invalid signature for repost from ${data.repost.actorHandle}@${data.repost.actorNodeDomain}`);
      return NextResponse.json({ error: 'Invalid signature' }, { status: 403 });
    }

    // Find the target post
    const post = await db.query.posts.findFirst({
      where: eq(posts.id, data.postId),
      with: { author: true },
    });

    if (!post) {
      return NextResponse.json({ error: 'Post not found' }, { status: 404 });
    }

    if (post.isRemoved) {
      return NextResponse.json({ error: 'Post not found' }, { status: 404 });
    }

    const existingRepost = await db.query.remoteReposts.findFirst({
      where: and(
        eq(remoteReposts.postId, data.postId),
        eq(remoteReposts.actorHandle, data.repost.actorHandle),
        eq(remoteReposts.actorNodeDomain, data.repost.actorNodeDomain),
      ),
    });

    if (existingRepost) {
      return NextResponse.json({
        success: true,
        message: 'Repost already recorded',
      });
    }

    // Increment repost count
    await db.update(posts)
      .set({ repostsCount: sql`${posts.repostsCount} + 1` })
      .where(eq(posts.id, data.postId));

    await db.insert(remoteReposts).values({
      postId: data.postId,
      actorHandle: data.repost.actorHandle,
      actorNodeDomain: data.repost.actorNodeDomain,
    });

    const author = post.author as { isBot?: boolean; botOwnerId?: string; handle?: string; displayName?: string | null; avatarUrl?: string | null } | null;

    // Create notification with actor info stored directly
    try {
      await db.insert(notifications).values({
        userId: post.userId,
        actorHandle: data.repost.actorHandle,
        actorDisplayName: data.repost.actorDisplayName,
        actorAvatarUrl: data.repost.actorAvatarUrl || null,
        actorNodeDomain: data.repost.actorNodeDomain,
        postId: data.postId,
        postContent: post.content?.slice(0, 200) || null,
        ...(author?.isBot ? buildNotificationTarget(author as any) : {}),
        type: 'repost',
      });
      console.log(`[Swarm] Created repost notification for post ${data.postId} from ${data.repost.actorHandle}@${data.repost.actorNodeDomain}`);
    } catch (notifError) {
      console.error(`[Swarm] Failed to create repost notification:`, notifError);
    }

    // Also notify bot owner if this is a bot's post
    if (author?.isBot && author.botOwnerId) {
      try {
        await db.insert(notifications).values({
          userId: author.botOwnerId,
          actorHandle: data.repost.actorHandle,
          actorDisplayName: data.repost.actorDisplayName,
          actorAvatarUrl: data.repost.actorAvatarUrl || null,
          actorNodeDomain: data.repost.actorNodeDomain,
          postId: data.postId,
          postContent: post.content?.slice(0, 200) || null,
          ...buildNotificationTarget(author as any),
          type: 'repost',
        });
      } catch (err) {
        console.error('[Swarm] Failed to notify bot owner:', err);
      }
    }

    console.log(`[Swarm] Received repost from ${data.repost.actorHandle}@${data.repost.actorNodeDomain} on post ${data.postId}`);

    return NextResponse.json({
      success: true,
      message: 'Repost received',
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid request', details: error.issues }, { status: 400 });
    }
    console.error('[Swarm] Repost error:', error);
    return NextResponse.json({ error: 'Failed to process repost' }, { status: 500 });
  }
}
