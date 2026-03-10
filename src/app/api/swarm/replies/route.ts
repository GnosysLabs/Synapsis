/**
 * Swarm Replies Endpoint
 * 
 * POST: Receive a reply from another node
 * GET: Fetch replies to a post on this node
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, posts, users, media, notifications } from '@/db';
import { eq, desc, and, sql } from 'drizzle-orm';
import { z } from 'zod';
import { verifySwarmRequest } from '@/lib/swarm/signature';
import { upsertRemoteUser } from '@/lib/swarm/user-cache';
import { buildNotificationTarget } from '@/lib/notifications';

// Schema for incoming swarm reply
const swarmReplySchema = z.object({
  postId: z.string().uuid(), // The local post being replied to
  reply: z.object({
    id: z.string(), // Original reply ID on the sender's node
    content: z.string(),
    createdAt: z.string(),
    author: z.object({
      handle: z.string(),
      displayName: z.string().optional().nullable(),
      avatarUrl: z.string().optional(),
      did: z.string().optional(),
      publicKey: z.string().optional(),
    }),
    nodeDomain: z.string(),
    mediaUrls: z.array(z.string()).optional(),
  }),
});

async function syncParentReplyCount(postId: string) {
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(posts)
    .where(and(
      eq(posts.replyToId, postId),
      eq(posts.isRemoved, false)
    ));

  await db.update(posts)
    .set({ repliesCount: Number(count || 0) })
    .where(eq(posts.id, postId));
}

/**
 * POST /api/swarm/replies
 * 
 * Receives a signed reply from another swarm node and stores it locally
 * against the target post so reply counts, thread views, and notifications work.
 */
export async function POST(request: NextRequest) {
  try {
    if (!db) {
      return NextResponse.json({ error: 'Database not available' }, { status: 503 });
    }

    const body = await request.json();
    const validation = swarmReplySchema.safeParse(body);
    if (!validation.success) {
      return NextResponse.json({ error: 'Invalid request', details: validation.error.issues }, { status: 400 });
    }

    const signature = request.headers.get('X-Swarm-Signature');
    const sourceDomain = request.headers.get('X-Swarm-Source-Domain');

    if (!signature || !sourceDomain) {
      return NextResponse.json({ error: 'Missing swarm signature headers' }, { status: 401 });
    }

    const isValid = await verifySwarmRequest(validation.data, signature, sourceDomain);
    if (!isValid) {
      return NextResponse.json({ error: 'Invalid node signature' }, { status: 403 });
    }

    const data = validation.data;
    if (data.reply.nodeDomain !== sourceDomain) {
      return NextResponse.json({ error: 'Source domain mismatch' }, { status: 400 });
    }

    const parentPost = await db.query.posts.findFirst({
      where: and(
        eq(posts.id, data.postId),
        eq(posts.isRemoved, false)
      ),
      with: {
        author: true,
      },
    });

    if (!parentPost) {
      return NextResponse.json({ error: 'Post not found' }, { status: 404 });
    }

    const remoteHandle = `${data.reply.author.handle}@${sourceDomain}`;
    const remoteDid = data.reply.author.did || `did:swarm:${sourceDomain}:${data.reply.author.handle}`;

    await upsertRemoteUser({
      handle: remoteHandle,
      displayName: data.reply.author.displayName || data.reply.author.handle,
      avatarUrl: data.reply.author.avatarUrl || null,
      did: remoteDid,
      publicKey: data.reply.author.publicKey,
    });

    const remoteUser = await db.query.users.findFirst({
      where: eq(users.handle, remoteHandle),
    });

    if (!remoteUser) {
      return NextResponse.json({ error: 'Failed to resolve remote author' }, { status: 500 });
    }

    const replyApId = `swarm:${sourceDomain}:${data.reply.id}`;
    const existingReply = await db.query.posts.findFirst({
      where: eq(posts.apId, replyApId),
    });

    if (existingReply) {
      return NextResponse.json({ success: true, message: 'Reply already received' });
    }

    const [createdReply] = await db.insert(posts).values({
      userId: remoteUser.id,
      content: data.reply.content,
      replyToId: data.postId,
      apId: replyApId,
      apUrl: `https://${sourceDomain}/posts/${data.reply.id}`,
      createdAt: new Date(data.reply.createdAt),
      updatedAt: new Date(data.reply.createdAt),
    }).returning();

    if (data.reply.mediaUrls?.length) {
      await db.insert(media).values(
        data.reply.mediaUrls.map((url, index) => ({
          userId: remoteUser.id,
          postId: createdReply.id,
          url,
          altText: `Remote reply attachment ${index + 1}`,
        }))
      );
    }

    await syncParentReplyCount(data.postId);

    const parentAuthor = parentPost.author as { isBot?: boolean; botOwnerId?: string; handle?: string; displayName?: string | null; avatarUrl?: string | null } | null;

    if (parentPost.userId !== remoteUser.id) {
      await db.insert(notifications).values({
        userId: parentPost.userId,
        actorHandle: data.reply.author.handle,
        actorDisplayName: data.reply.author.displayName || data.reply.author.handle,
        actorAvatarUrl: data.reply.author.avatarUrl || null,
        actorNodeDomain: sourceDomain,
        postId: data.postId,
        postContent: data.reply.content.slice(0, 200),
        ...(parentAuthor?.isBot ? buildNotificationTarget(parentAuthor as any) : {}),
        type: 'reply',
      });

      if (parentAuthor?.isBot && parentAuthor.botOwnerId) {
        await db.insert(notifications).values({
          userId: parentAuthor.botOwnerId,
          actorHandle: data.reply.author.handle,
          actorDisplayName: data.reply.author.displayName || data.reply.author.handle,
          actorAvatarUrl: data.reply.author.avatarUrl || null,
          actorNodeDomain: sourceDomain,
          postId: data.postId,
          postContent: data.reply.content.slice(0, 200),
          ...buildNotificationTarget(parentAuthor as any),
          type: 'reply',
        });
      }
    }

    return NextResponse.json({ success: true, message: 'Reply received' });
  } catch (error) {
    console.error('[Swarm] Receive reply error:', error);
    return NextResponse.json({ error: 'Failed to receive reply' }, { status: 500 });
  }
}

/**
 * DELETE /api/swarm/replies
 * 
 * Receives a deletion request from another node.
 * Removes a reply that was previously delivered.
 */
export async function DELETE(request: NextRequest) {
  try {
    if (!db) {
      return NextResponse.json({ error: 'Database not available' }, { status: 503 });
    }

    const body = await request.json();
    const { replyId, nodeDomain, authorHandle } = body;

    if (!replyId || !nodeDomain) {
      return NextResponse.json({ error: 'replyId and nodeDomain required' }, { status: 400 });
    }

    // Find the reply by its swarm ID
    const swarmReplyId = `swarm:${nodeDomain}:${replyId}`;
    const existingReply = await db.query.posts.findFirst({
      where: eq(posts.apId, swarmReplyId),
    });

    if (!existingReply) {
      // Already deleted or never existed
      return NextResponse.json({ success: true, message: 'Reply not found or already deleted' });
    }

    const parentReplyToId = existingReply.replyToId;

    // Delete the reply
    await db.delete(posts).where(eq(posts.id, existingReply.id));

    if (parentReplyToId) {
      await syncParentReplyCount(parentReplyToId);
    }

    console.log(`[Swarm] Deleted reply ${swarmReplyId} from ${nodeDomain}`);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[Swarm] Delete reply error:', error);
    return NextResponse.json({ error: 'Failed to delete reply' }, { status: 500 });
  }
}

/**
 * GET /api/swarm/replies?postId=xxx
 * 
 * Returns replies to a specific post on this node.
 * Used by other nodes to fetch reply threads.
 */
export async function GET(request: NextRequest) {
  try {
    if (!db) {
      return NextResponse.json({ replies: [] });
    }

    const { searchParams } = new URL(request.url);
    const postId = searchParams.get('postId');

    if (!postId) {
      return NextResponse.json({ error: 'postId required' }, { status: 400 });
    }

    const nodeDomain = process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost';

    // Get replies to this post
    const replies = await db
      .select({
        id: posts.id,
        content: posts.content,
        createdAt: posts.createdAt,
        likesCount: posts.likesCount,
        repostsCount: posts.repostsCount,
        repliesCount: posts.repliesCount,
        authorHandle: users.handle,
        authorDisplayName: users.displayName,
        authorAvatarUrl: users.avatarUrl,
      })
      .from(posts)
      .innerJoin(users, eq(posts.userId, users.id))
      .where(
        and(
          eq(posts.replyToId, postId),
          eq(posts.isRemoved, false)
        )
      )
      .orderBy(desc(posts.createdAt))
      .limit(50);

    // Format replies for swarm consumption
    const formattedReplies = replies.map(reply => ({
      id: reply.id,
      content: reply.content,
      createdAt: reply.createdAt.toISOString(),
      author: {
        handle: reply.authorHandle.includes('@') 
          ? reply.authorHandle.split('@')[0] 
          : reply.authorHandle,
        displayName: reply.authorDisplayName || reply.authorHandle,
        avatarUrl: reply.authorAvatarUrl || undefined,
      },
      nodeDomain: reply.authorHandle.includes('@')
        ? reply.authorHandle.split('@')[1]
        : nodeDomain,
      likeCount: reply.likesCount,
      repostCount: reply.repostsCount,
      replyCount: reply.repliesCount,
    }));

    return NextResponse.json({
      postId,
      replies: formattedReplies,
      nodeDomain,
    });
  } catch (error) {
    console.error('[Swarm] Fetch replies error:', error);
    return NextResponse.json({ error: 'Failed to fetch replies' }, { status: 500 });
  }
}
