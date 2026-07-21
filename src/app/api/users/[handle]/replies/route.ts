import { NextResponse } from 'next/server';
import { db } from '@/db';
import { probeTransientNode } from '@/lib/swarm/transient-node-probe';
import { getRemoteBaseUrl, mapRemoteProfilePost } from '@/lib/swarm/remote-profile-posts';
import { fetchSwarmUserProfile, isSwarmNode } from '@/lib/swarm/interactions';
import { getViewerSwarmRepostedPostIds } from '@/lib/swarm/reposts';
import { resolveUserHandle } from '@/lib/swarm/user-handle';
import {
  canCurrentViewerAccessSensitiveRemoteProfile,
  getCurrentViewerSensitiveProfileAccess,
  SENSITIVE_PROFILE_MESSAGE,
  SENSITIVE_REMOTE_PROFILE_MESSAGE,
} from '@/lib/nsfw/remote-profile-access';
import { getSensitiveContentViewerAccess } from '@/lib/nsfw/viewer-access';
import { redactSensitivePostForViewer } from '@/lib/nsfw/content-visibility';
import { signedFederationRead } from '@/lib/swarm/signed-read';
import { parseBoundedInteger } from '@/lib/http/query';
import { parseRemotePostListResponse } from '@/lib/swarm/remote-post-payload';

const embeddedPostRelations = {
  author: true,
  media: true,
  replyTo: {
    with: {
      author: true,
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
type FeedPostWithChildren = {
  id: string;
  repostOf?: FeedPostWithChildren | null;
  replyTo?: FeedPostWithChildren | null;
  isLiked?: boolean;
  isReposted?: boolean;
};

export async function GET(request: Request, context: RouteContext) {
  try {
    const { handle } = await context.params;
    const resolvedHandle = resolveUserHandle(handle);
    const cleanHandle = resolvedHandle.canonicalHandle;
    const { searchParams } = new URL(request.url);
    const limit = parseBoundedInteger(searchParams.get('limit'), {
      defaultValue: 25,
      min: 1,
      max: 50,
    });
    const cursor = searchParams.get('cursor');
    const remote = resolvedHandle.remote;
    const viewerAccess = await getSensitiveContentViewerAccess();
    const serializePosts = (postsToSerialize: FeedPostWithChildren[]) => (
      postsToSerialize.map((post) => redactSensitivePostForViewer(
        post as unknown as Record<string, unknown>,
        {
          canViewSensitive: viewerAccess.canViewSensitive,
          localNodeDomain: process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost:43821',
          localNodeIsNsfw: viewerAccess.localNodeIsNsfw,
        },
      ))
    );

    const fetchRemoteReplies = async () => {
      if (!remote) {
        return NextResponse.json({ posts: [], nextCursor: null });
      }

      const profileData = await fetchSwarmUserProfile(remote.handle, remote.domain, 0);
      if (!profileData) {
        return NextResponse.json({ posts: [], nextCursor: null });
      }

      if (!await canCurrentViewerAccessSensitiveRemoteProfile({
        accountIsNsfw: profileData.profile.isNsfw,
        nodeIsNsfw: profileData.profile.nodeIsNsfw,
      })) {
        return NextResponse.json(
          { posts: [], nextCursor: null, restricted: true, error: SENSITIVE_REMOTE_PROFILE_MESSAGE },
          { status: 403 },
        );
      }

      const baseUrl = getRemoteBaseUrl(remote.domain);
      const res = await signedFederationRead(`${baseUrl}/api/users/${encodeURIComponent(remote.handle)}/replies?limit=${limit}`, {
        headers: { Accept: 'application/json' },
        timeoutMs: 8_000,
        maxResponseBytes: 1024 * 1024,
      });

      if (res.status < 200 || res.status >= 300) {
        return NextResponse.json({ posts: [], nextCursor: null });
      }

      const remotePosts = parseRemotePostListResponse(res.json(), remote.domain, limit);
      const { getSession } = await import('@/lib/auth');
      const session = await getSession();
      const viewer = session?.user;
      const mappedPosts = remotePosts.map((post) => mapRemoteProfilePost(post, remote.domain));
      const repostedIds = viewer
        ? await getViewerSwarmRepostedPostIds(
            mappedPosts.map((post) => ({
              id: post.id,
              nodeDomain: remote.domain,
              originalPostId: post.originalPostId || post.id.split(':').pop() || post.id,
            })),
            viewer.id
          )
        : new Set<string>();
      return NextResponse.json({
        posts: serializePosts(mappedPosts.map((post) => ({
          ...post,
          isReposted: repostedIds.has(post.id),
        })) as FeedPostWithChildren[]),
        nextCursor: null,
      });
    };

    if (!db) {
      if (!remote) {
        return NextResponse.json({ posts: [], nextCursor: null });
      }

      let swarm = await isSwarmNode(remote.domain);
      if (!swarm) {
        swarm = Boolean(await probeTransientNode(remote.domain));
      }

      if (!swarm) {
        return NextResponse.json({ posts: [], nextCursor: null });
      }

      return await fetchRemoteReplies();
    }

    const user = await db.query.users.findFirst({
      where: { AND: [{ handle: cleanHandle }, { isLocalAccount: true }] },
    });
    const isRemotePlaceholder = Boolean(user && remote);

    if (!user || isRemotePlaceholder) {
      if (!remote) {
        return NextResponse.json({ error: 'User not found' }, { status: 404 });
      }

      let swarm = await isSwarmNode(remote.domain);
      if (!swarm) {
        swarm = Boolean(await probeTransientNode(remote.domain));
      }

      if (!swarm) {
        return NextResponse.json({ posts: [], nextCursor: null });
      }

      return await fetchRemoteReplies();
    }

    if (user.isSuspended) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    const profileAccess = await getCurrentViewerSensitiveProfileAccess({
      accountIsNsfw: user.isNsfw,
    });
    if (!profileAccess.allowed) {
      return NextResponse.json(
        { posts: [], nextCursor: null, restricted: true, error: SENSITIVE_PROFILE_MESSAGE },
        { status: 403 },
      );
    }

    let cursorDate: Date | undefined;

    if (cursor) {
      const cursorPost = await db.query.posts.findFirst({
        where: { id: cursor },
      });
      if (cursorPost) {
        cursorDate = cursorPost.createdAt;
      }
    }

    let replyPosts: FeedPostWithChildren[] = await db.query.posts.findMany({
      where: {
        userId: user.id,
        isRemoved: false,
        OR: [
          { replyToId: { isNotNull: true } },
          { swarmReplyToId: { isNotNull: true } },
        ],
        ...(cursorDate ? { createdAt: { lt: cursorDate } } : {}),
      },
      with: replyRelations,
      orderBy: (posts, { desc }) => [desc(posts.createdAt)],
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
              where: { AND: [{ userId: viewer.id }, { postId: { in: postIds } }] },
            })
          : [];
        const likedPostIds = new Set(viewerLikes.map((like) => like.postId));

        const viewerReposts = postIds.length > 0
          ? await db.query.posts.findMany({
              where: { AND: [{ userId: viewer.id }, { repostOfId: { in: postIds } }, { isRemoved: false }] },
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
      posts: serializePosts(replyPosts),
      nextCursor: replyPosts.length === limit ? replyPosts[replyPosts.length - 1]?.id : null,
    });
  } catch (error) {
    console.error('Get user replies error:', error);
    return NextResponse.json({ error: 'Failed to get replies' }, { status: 500 });
  }
}
