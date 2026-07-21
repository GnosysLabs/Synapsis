/**
 * Swarm Post Detail Endpoint
 * 
 * GET: Get a post's details for other swarm nodes
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { z } from 'zod';
import { parseLinkPreviewMediaJson } from '@/lib/media/linkPreview';
import { ORIGIN_UNAVAILABLE_CONTENT } from '@/lib/swarm/remote-access-protocol';
import { attachRemoteRepostSummaries } from '@/lib/posts/remote-reposts';
import { requireLocalNodeNsfwClassification } from '@/lib/node/local-node';
import { redactSensitivePostForViewer } from '@/lib/nsfw/content-visibility';
import { hasStrictLocalUserOrigin } from '@/lib/swarm/local-user-origin';
import { authorizeFederationRead, federationReadFailureResponse } from '@/lib/swarm/signed-read';
import {
  requireCanonicalAccountHomeDomain,
  resolveAccountAddress,
} from '@/lib/identity/account-address';

type RouteContext = { params: Promise<{ id: string }> };

const uuidSchema = z.string().uuid();

/**
 * GET /api/swarm/posts/[id]
 * 
 * Returns post details including replies for swarm federation.
 */
export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const readAuthorization = await authorizeFederationRead(request);
    if (!readAuthorization.ok) return federationReadFailureResponse(readAuthorization);
    if (!db) {
      return NextResponse.json({ error: 'Database not available' }, { status: 503 });
    }

    const { id: postIdRaw } = await context.params;
    
    // Validate postId is a valid UUID
    const postIdValidation = uuidSchema.safeParse(postIdRaw);
    if (!postIdValidation.success) {
      return NextResponse.json({ error: 'Invalid post ID format' }, { status: 400 });
    }
    const postId = postIdValidation.data;
    const nodeIsNsfw = await requireLocalNodeNsfwClassification();
    const nodeDomain = requireCanonicalAccountHomeDomain(
      process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost:43821',
    );
    const trustedRead = true;
    const serializePost = (value: Record<string, unknown>) => redactSensitivePostForViewer(
      value,
      {
        canViewSensitive: trustedRead,
        localNodeDomain: nodeDomain,
        localNodeIsNsfw: nodeIsNsfw,
      },
    );

    // Find the post
    const post = await db.query.posts.findFirst({
      where: { id: postId },
      with: {
        author: true,
        media: true,
      },
    });

    if (!post || post.isRemoved) {
      const remoteRepost = await db.query.userSwarmReposts.findFirst({
        where: { id: postId },
      });

      if (!remoteRepost) {
        return NextResponse.json({ error: 'Post not found' }, { status: 404 });
      }

      const repostAuthor = await db.query.users.findFirst({
        where: { id: remoteRepost.userId },
      });

      if (!repostAuthor || !hasStrictLocalUserOrigin(repostAuthor)) {
        return NextResponse.json({ error: 'Post not found' }, { status: 404 });
      }

      const repostPayload = serializePost({
          id: remoteRepost.id,
          apId: null,
          content: '',
          createdAt: remoteRepost.repostedAt.toISOString(),
          likesCount: 0,
          repostsCount: 0,
          repliesCount: 0,
          isNsfw: repostAuthor?.isNsfw ?? nodeIsNsfw,
          nodeIsNsfw,
          author: {
            handle: repostAuthor.handle,
            displayName: repostAuthor.displayName,
            avatarUrl: repostAuthor.avatarUrl,
            isNsfw: repostAuthor.isNsfw,
            nodeIsNsfw,
          },
          media: [],
          repostOfId: remoteRepost.originalPostId,
          repostOf: {
            id: remoteRepost.originalPostId,
            originalPostId: remoteRepost.originalPostId,
            content: remoteRepost.originUnavailableAt
              ? ORIGIN_UNAVAILABLE_CONTENT
              : remoteRepost.content,
            originUnavailable: Boolean(remoteRepost.originUnavailableAt),
            createdAt: remoteRepost.postCreatedAt.toISOString(),
            likesCount: remoteRepost.likesCount,
            repostsCount: remoteRepost.repostsCount,
            repliesCount: remoteRepost.repliesCount,
            nodeDomain: remoteRepost.nodeDomain,
            isNsfw: true,
            nodeIsNsfw: true,
            author: {
              handle: resolveAccountAddress(
                remoteRepost.authorHandle,
                remoteRepost.nodeDomain,
              )?.canonical || remoteRepost.authorHandle,
              displayName: remoteRepost.authorDisplayName,
              avatarUrl: remoteRepost.authorAvatarUrl,
              isNsfw: true,
              nodeIsNsfw: true,
            },
            media: remoteRepost.originUnavailableAt || !remoteRepost.mediaJson
              ? []
              : JSON.parse(remoteRepost.mediaJson),
            linkPreviewUrl: remoteRepost.originUnavailableAt ? null : remoteRepost.linkPreviewUrl,
            linkPreviewTitle: remoteRepost.originUnavailableAt ? null : remoteRepost.linkPreviewTitle,
            linkPreviewDescription: remoteRepost.originUnavailableAt ? null : remoteRepost.linkPreviewDescription,
            linkPreviewImage: remoteRepost.originUnavailableAt ? null : remoteRepost.linkPreviewImage,
            linkPreviewType: remoteRepost.originUnavailableAt ? null : remoteRepost.linkPreviewType,
            linkPreviewVideoUrl: remoteRepost.originUnavailableAt ? null : remoteRepost.linkPreviewVideoUrl,
            linkPreviewMedia: remoteRepost.originUnavailableAt
              ? []
              : parseLinkPreviewMediaJson(remoteRepost.linkPreviewMediaJson) || [],
          },
      });
      if (!trustedRead && repostPayload.sensitiveContentRestricted === true) {
        return NextResponse.json({ error: 'Sensitive post requires an authenticated node request' }, { status: 403 });
      }
      return NextResponse.json({ post: repostPayload, replies: [] });
    }

    // Get replies
    const replies = await db.query.posts.findMany({
      where: { AND: [{ replyToId: postId }, { isRemoved: false }] },
      with: {
        author: true,
        media: true,
      },
      orderBy: (posts, { desc }) => [desc(posts.createdAt)],
      limit: 50,
    });
    const remoteRepostRows = await db.query.remoteReposts.findMany({
      where: { postId: { in: [post.id, ...replies.map((reply) => reply.id)] } },
      orderBy: (remoteReposts, { desc }) => [desc(remoteReposts.createdAt)],
    });
    const [postSummary, ...replySummaries] = attachRemoteRepostSummaries(
      [post, ...replies],
      remoteRepostRows,
    );
    const replySummariesById = new Map(replySummaries.map((reply) => [reply.id, reply]));

    const author = post.author;
    const remoteMainAuthor = !hasStrictLocalUserOrigin(author);
    if (remoteMainAuthor) {
      return NextResponse.json({ error: 'Post not found' }, { status: 404 });
    }
    const localReplies = replies.filter((reply) => hasStrictLocalUserOrigin(reply.author));

    const responsePayload = {
      post: {
        id: post.id,
        apId: post.apId, // Expose apId for swarm coordination (e.g. deletion recovery)
        content: post.content,
        createdAt: post.createdAt.toISOString(),
        likesCount: post.likesCount,
        repostsCount: post.repostsCount,
        repostedBy: postSummary.repostedBy,
        repostedByCount: postSummary.repostedByCount,
        repliesCount: localReplies.length,
        isNsfw: remoteMainAuthor ? true : post.isNsfw,
        nodeIsNsfw: remoteMainAuthor ? true : nodeIsNsfw,
        author: {
          handle: author.handle,
          displayName: author.displayName,
          avatarUrl: author.avatarUrl,
          isNsfw: remoteMainAuthor ? true : author.isNsfw,
          nodeIsNsfw: remoteMainAuthor ? true : nodeIsNsfw,
        },
        media: post.media?.map(m => ({
          url: m.url,
          altText: m.altText,
        })) || [],
        linkPreviewUrl: post.linkPreviewUrl,
        linkPreviewTitle: post.linkPreviewTitle,
        linkPreviewDescription: post.linkPreviewDescription,
        linkPreviewImage: post.linkPreviewImage,
        linkPreviewType: post.linkPreviewType,
        linkPreviewVideoUrl: post.linkPreviewVideoUrl,
        linkPreviewMedia: parseLinkPreviewMediaJson(post.linkPreviewMediaJson) || [],
      },
      replies: localReplies.map(r => {
        const replyAuthor = r.author;
        const replySummary = replySummariesById.get(r.id);
        const remoteReply = !hasStrictLocalUserOrigin(replyAuthor);
        return {
          id: r.id,
          content: r.content,
          createdAt: r.createdAt.toISOString(),
          likesCount: r.likesCount,
          repostsCount: r.repostsCount,
          repostedBy: replySummary?.repostedBy,
          repostedByCount: replySummary?.repostedByCount,
          repliesCount: r.repliesCount,
          isNsfw: remoteReply ? true : r.isNsfw,
          nodeIsNsfw: remoteReply ? true : nodeIsNsfw,
          author: {
            handle: replyAuthor.handle,
            displayName: replyAuthor.displayName,
            avatarUrl: replyAuthor.avatarUrl,
            isNsfw: remoteReply ? true : replyAuthor.isNsfw,
            nodeIsNsfw: remoteReply ? true : nodeIsNsfw,
          },
          media: r.media?.map(m => ({
            url: m.url,
            altText: m.altText,
          })) || [],
          linkPreviewUrl: r.linkPreviewUrl,
          linkPreviewTitle: r.linkPreviewTitle,
          linkPreviewDescription: r.linkPreviewDescription,
          linkPreviewImage: r.linkPreviewImage,
          linkPreviewType: r.linkPreviewType,
          linkPreviewVideoUrl: r.linkPreviewVideoUrl,
          linkPreviewMedia: parseLinkPreviewMediaJson(r.linkPreviewMediaJson) || [],
        };
      }),
    };
    if (trustedRead) {
      return NextResponse.json(responsePayload);
    }

    const publicPost = serializePost(responsePayload.post);
    if (publicPost.sensitiveContentRestricted === true) {
      return NextResponse.json({ error: 'Sensitive post requires an authenticated node request' }, { status: 403 });
    }
    const publicReplies = responsePayload.replies
      .map((reply) => serializePost(reply))
      .filter((reply) => reply.sensitiveContentRestricted !== true);
    return NextResponse.json({ post: publicPost, replies: publicReplies });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Invalid input', details: error.issues },
        { status: 400 }
      );
    }
    console.error('[Swarm] Post detail error:', error);
    return NextResponse.json({ error: 'Failed to get post' }, { status: 500 });
  }
}
