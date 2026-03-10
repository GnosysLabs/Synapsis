import { NextResponse } from 'next/server';
import { db, likes, posts, users } from '@/db';
import { and, desc, eq, inArray, lt, not, or, isNotNull } from 'drizzle-orm';
import { discoverNode } from '@/lib/swarm/discovery';
import { getRemoteBaseUrl, mapRemoteProfilePost, parseRemoteHandle } from '@/lib/swarm/remote-profile-posts';
import { isSwarmNode } from '@/lib/swarm/interactions';
import { getViewerSwarmRepostedPostIds } from '@/lib/swarm/reposts';

const embeddedPostRelations = {
  author: true,
  bot: true,
  media: true,
  replyTo: {
    with: {
      author: true,
      bot: true,
      media: true,
    },
  },
} as const;

const replyRelations = {
  ...embeddedPostRelations,
  repostOf: {
    with: embeddedPostRelations,
  },
} as const;

type RouteContext = { params: Promise<{ handle: string }> };

export async function GET(request: Request, context: RouteContext) {
  try {
    const { handle } = await context.params;
    const cleanHandle = handle.toLowerCase().replace(/^@/, '');
    const { searchParams } = new URL(request.url);
    const limit = Math.min(parseInt(searchParams.get('limit') || '25'), 50);
    const cursor = searchParams.get('cursor');
    const remote = parseRemoteHandle(handle);

    const fetchRemoteReplies = async () => {
      if (!remote) {
        return NextResponse.json({ posts: [], nextCursor: null });
      }

      const baseUrl = getRemoteBaseUrl(remote.domain);
      const res = await fetch(`${baseUrl}/api/users/${remote.handle}/replies?limit=${limit}`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(10000),
      });

      if (!res.ok) {
        return NextResponse.json({ posts: [], nextCursor: null });
      }

      const data = await res.json();
      const { getSession } = await import('@/lib/auth');
      const session = await getSession();
      const viewer = session?.user;
      const mappedPosts = (data.posts || []).map((post: any) => mapRemoteProfilePost(post, remote.domain));
      const repostedIds = viewer
        ? await getViewerSwarmRepostedPostIds(
            mappedPosts.map((post: any) => ({
              id: post.id,
              nodeDomain: remote.domain,
              originalPostId: post.originalPostId || post.id.split(':').pop(),
            })),
            viewer.id
          )
        : new Set<string>();
      return NextResponse.json({
        posts: mappedPosts.map((post: any) => ({
          ...post,
          isReposted: repostedIds.has(post.id),
        })),
        nextCursor: null,
      });
    };

    if (!db) {
      if (!remote) {
        return NextResponse.json({ posts: [], nextCursor: null });
      }

      let swarm = await isSwarmNode(remote.domain);
      if (!swarm) {
        const discovery = await discoverNode(remote.domain);
        swarm = discovery.success;
      }

      if (!swarm) {
        return NextResponse.json({ posts: [], nextCursor: null });
      }

      return await fetchRemoteReplies();
    }

    const user = await db.query.users.findFirst({
      where: eq(users.handle, cleanHandle),
    });
    const isRemotePlaceholder = user && cleanHandle.includes('@');

    if (!user || isRemotePlaceholder) {
      if (!remote) {
        return NextResponse.json({ error: 'User not found' }, { status: 404 });
      }

      let swarm = await isSwarmNode(remote.domain);
      if (!swarm) {
        const discovery = await discoverNode(remote.domain);
        swarm = discovery.success;
      }

      if (!swarm) {
        return NextResponse.json({ posts: [], nextCursor: null });
      }

      return await fetchRemoteReplies();
    }

    if (user.isSuspended) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    let whereConditions = and(
      eq(posts.userId, user.id),
      eq(posts.isRemoved, false),
      or(isNotNull(posts.replyToId), isNotNull(posts.swarmReplyToId)),
    );

    if (cursor) {
      const cursorPost = await db.query.posts.findFirst({
        where: eq(posts.id, cursor),
      });
      if (cursorPost) {
        whereConditions = and(
          eq(posts.userId, user.id),
          eq(posts.isRemoved, false),
          or(isNotNull(posts.replyToId), isNotNull(posts.swarmReplyToId)),
          lt(posts.createdAt, cursorPost.createdAt),
        );
      }
    }

    let replyPosts: any[] = await db.query.posts.findMany({
      where: whereConditions,
      with: replyRelations,
      orderBy: [desc(posts.createdAt)],
      limit,
    });

    try {
      const { getSession } = await import('@/lib/auth');
      const session = await getSession();

      if (session?.user && replyPosts.length > 0) {
        const viewer = session.user;
        const postIds = replyPosts.map((post) => post.id).filter(Boolean);

        const viewerLikes = postIds.length > 0
          ? await db.query.likes.findMany({
              where: and(
                eq(likes.userId, viewer.id),
                inArray(likes.postId, postIds),
              ),
            })
          : [];
        const likedPostIds = new Set(viewerLikes.map((like) => like.postId));

        const viewerReposts = postIds.length > 0
          ? await db.query.posts.findMany({
              where: and(
                eq(posts.userId, viewer.id),
                inArray(posts.repostOfId, postIds),
                eq(posts.isRemoved, false),
              ),
            })
          : [];
        const repostedPostIds = new Set(viewerReposts.map((post) => post.repostOfId));

        replyPosts = replyPosts.map((post) => ({
          ...post,
          isLiked: likedPostIds.has(post.id),
          isReposted: repostedPostIds.has(post.id),
        }));
      }
    } catch {
    }

    return NextResponse.json({
      posts: replyPosts,
      nextCursor: replyPosts.length === limit ? replyPosts[replyPosts.length - 1]?.id : null,
    });
  } catch (error) {
    console.error('Get user replies error:', error);
    return NextResponse.json({ error: 'Failed to get replies' }, { status: 500 });
  }
}
