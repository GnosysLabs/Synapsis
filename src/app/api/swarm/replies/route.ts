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
import { isPostSensitive, redactSensitivePostForViewer } from '@/lib/nsfw/content-visibility';
import { isTrustedFederationRead } from '@/lib/swarm/signed-read';
import { upsertRemoteUser } from '@/lib/swarm/user-cache';
import { normalizeNodeDomain } from '@/lib/swarm/node-domain';
import { parseSwarmPostId } from '@/lib/swarm/post-id';

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
      isNsfw: z.boolean().optional(),
    }),
    nodeDomain: z.string(),
    nodeIsNsfw: z.boolean().optional(),
    isNsfw: z.boolean().optional(),
    mediaUrls: z.array(z.string()).optional(),
  }),
});

const swarmReplyDeletionSchema = z.object({
  replyId: z.string().uuid(),
  nodeDomain: z.string().min(1).max(253),
  authorHandle: z.string().min(1).max(64),
}).strict();

const swarmReplyPostIdSchema = z.string().uuid();

async function syncParentReplyCount(postId: string) {
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)` })
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
      where: { AND: [{ id: data.postId }, { isRemoved: false }] },
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
      isNsfw: data.reply.author.isNsfw,
    });

    const remoteUser = await db.query.users.findFirst({
      where: { handle: remoteHandle },
    });

    if (!remoteUser) {
      return NextResponse.json({ error: 'Failed to resolve remote author' }, { status: 500 });
    }

    const replyApId = `swarm:${sourceDomain}:${data.reply.id}`;
    const existingReply = await db.query.posts.findFirst({
      where: { apId: replyApId },
    });

    if (existingReply) {
      return NextResponse.json({ success: true, message: 'Reply already received' });
    }

    const classifierMissing = typeof data.reply.isNsfw !== 'boolean'
      || typeof data.reply.author.isNsfw !== 'boolean'
      || typeof data.reply.nodeIsNsfw !== 'boolean';
    const [createdReply] = await db.insert(posts).values({
      userId: remoteUser.id,
      content: data.reply.content,
      replyToId: data.postId,
      apId: replyApId,
      apUrl: `https://${sourceDomain}/posts/${data.reply.id}`,
      createdAt: new Date(data.reply.createdAt),
      updatedAt: new Date(data.reply.createdAt),
      isNsfw: classifierMissing
        || data.reply.isNsfw === true
        || data.reply.author.isNsfw === true
        || data.reply.nodeIsNsfw === true,
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

    if (parentPost.userId !== remoteUser.id) {
      await db.insert(notifications).values({
        userId: parentPost.userId,
        actorHandle: data.reply.author.handle,
        actorDisplayName: data.reply.author.displayName || data.reply.author.handle,
        actorAvatarUrl: data.reply.author.avatarUrl || null,
        actorNodeDomain: sourceDomain,
        postId: data.postId,
        postContent: data.reply.content.slice(0, 200),
        type: 'reply',
      });
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

    const validation = swarmReplyDeletionSchema.safeParse(await request.json());
    if (!validation.success) {
      return NextResponse.json(
        { error: 'Invalid request', details: validation.error.issues },
        { status: 400 },
      );
    }
    const signature = request.headers.get('X-Swarm-Signature');
    const sourceDomainHeader = request.headers.get('X-Swarm-Source-Domain');
    if (!signature || !sourceDomainHeader) {
      return NextResponse.json({ error: 'Missing swarm signature headers' }, { status: 401 });
    }

    const sourceDomain = normalizeNodeDomain(sourceDomainHeader);
    const { replyId, nodeDomain } = validation.data;
    if (nodeDomain !== sourceDomain) {
      return NextResponse.json({ error: 'Source domain mismatch' }, { status: 400 });
    }
    if (!await verifySwarmRequest(validation.data, signature, sourceDomain)) {
      return NextResponse.json({ error: 'Invalid node signature' }, { status: 403 });
    }

    // Find the reply by its swarm ID
    const swarmReplyId = `swarm:${nodeDomain}:${replyId}`;
    const existingReply = await db.query.posts.findFirst({
      where: { apId: swarmReplyId },
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
    const postIdValidation = swarmReplyPostIdSchema.safeParse(searchParams.get('postId'));
    if (!postIdValidation.success) {
      return NextResponse.json({ error: 'Valid postId required' }, { status: 400 });
    }
    const postId = postIdValidation.data;

    const nodeDomain = process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost';
    const localNodeIsNsfw = await (await import('@/lib/node/local-node'))
      .requireLocalNodeNsfwClassification();
    const trustedRead = await isTrustedFederationRead(request);
    const parentPost = await db.query.posts.findFirst({
      where: { AND: [{ id: postId }, { isRemoved: false }] },
      with: { author: true },
    });
    if (!parentPost) {
      return NextResponse.json({ error: 'Post not found' }, { status: 404 });
    }
    const parentIsRemote = parentPost.author.handle.includes('@')
      || (parentPost.author.nodeId !== null && parentPost.author.nodeId !== undefined);
    const parentIsSensitive = isPostSensitive({
      postIsNsfw: parentPost.isNsfw,
      authorIsNsfw: parentPost.author.isNsfw,
      nodeIsNsfw: parentIsRemote ? undefined : localNodeIsNsfw,
      isRemote: parentIsRemote,
    });
    if (parentIsSensitive && !trustedRead) {
      return NextResponse.json(
        { error: 'Sensitive thread requires a trusted federation read' },
        { status: 403, headers: { 'Cache-Control': 'private, no-store' } },
      );
    }

    // Get replies to this post
    const replies = await db
      .select({
        id: posts.id,
        apId: posts.apId,
        content: posts.content,
        createdAt: posts.createdAt,
        likesCount: posts.likesCount,
        repostsCount: posts.repostsCount,
        repliesCount: posts.repliesCount,
        authorHandle: users.handle,
        authorDisplayName: users.displayName,
        authorAvatarUrl: users.avatarUrl,
        authorIsNsfw: users.isNsfw,
        authorNodeId: users.nodeId,
        postIsNsfw: posts.isNsfw,
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
    const formattedReplies = replies.map((reply) => {
      const authorIsRemote = reply.authorHandle.includes('@')
        || (reply.authorNodeId !== null && reply.authorNodeId !== undefined);
      const handleParts = reply.authorHandle.split('@');
      const parsedRemotePostId = reply.apId?.startsWith('swarm:')
        ? parseSwarmPostId(reply.apId)
        : null;
      const remoteDomain = parsedRemotePostId?.domain
        || (authorIsRemote && handleParts.length > 1
          ? handleParts[handleParts.length - 1]
          : null);

      return {
        id: parsedRemotePostId?.originalPostId || reply.id,
        content: reply.content,
        createdAt: reply.createdAt.toISOString(),
        author: {
          handle: remoteDomain ? handleParts.slice(0, -1).join('@') : reply.authorHandle,
          displayName: reply.authorDisplayName || reply.authorHandle,
          avatarUrl: reply.authorAvatarUrl || undefined,
          isNsfw: reply.authorIsNsfw,
          isRemote: authorIsRemote,
          nodeId: reply.authorNodeId,
          nodeIsNsfw: authorIsRemote ? undefined : localNodeIsNsfw,
        },
        nodeDomain: remoteDomain || (authorIsRemote ? null : nodeDomain),
        likeCount: reply.likesCount,
        repostCount: reply.repostsCount,
        replyCount: reply.repliesCount,
        isNsfw: reply.postIsNsfw,
        nodeIsNsfw: authorIsRemote ? undefined : localNodeIsNsfw,
        isRemote: authorIsRemote,
      };
    });
    const responseReplies = trustedRead
      ? formattedReplies
      : formattedReplies
          .map((reply) => redactSensitivePostForViewer(
            reply as unknown as Record<string, unknown>,
            {
              canViewSensitive: false,
              localNodeDomain: nodeDomain,
              localNodeIsNsfw,
            },
          ))
          .filter((reply) => reply.sensitiveContentRestricted !== true);

    return NextResponse.json({
      postId,
      replies: responseReplies,
      nodeDomain,
    }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    console.error('[Swarm] Fetch replies error:', error);
    return NextResponse.json({ error: 'Failed to fetch replies' }, { status: 500 });
  }
}
