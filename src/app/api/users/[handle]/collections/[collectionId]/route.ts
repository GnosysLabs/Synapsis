import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import { collections, db } from '@/db';
import { getSession } from '@/lib/auth';
import { requireSignedAction, SignedActionError } from '@/lib/auth/verify-signature';
import { getLocalCollectionDetail, getLocalCollectionSummaries } from '@/lib/collections/data';
import { fetchRemoteCollectionDetail } from '@/lib/collections/federation';
import {
  deleteCollectionActionDataSchema,
  updateCollectionActionDataSchema,
} from '@/lib/collections/schemas';
import { signedUserActionSchema } from '@/lib/e2ee/protocol';
import { redactSensitivePostForViewer } from '@/lib/nsfw/content-visibility';
import {
  canCurrentViewerAccessSensitiveRemoteProfile,
  getCurrentViewerSensitiveProfileAccess,
  SENSITIVE_REMOTE_PROFILE_MESSAGE,
  SENSITIVE_PROFILE_MESSAGE,
} from '@/lib/nsfw/remote-profile-access';
import { getSensitiveContentViewerAccess } from '@/lib/nsfw/viewer-access';
import { getViewerSwarmLikedPostIds } from '@/lib/swarm/likes';
import { resolveUserHandle } from '@/lib/swarm/user-handle';

type RouteContext = { params: Promise<{ handle: string; collectionId: string }> };

export async function GET(request: Request, context: RouteContext) {
  try {
    const { handle, collectionId } = await context.params;
    if (!z.string().uuid().safeParse(collectionId).success) {
      return NextResponse.json({ error: 'Collection not found' }, { status: 404 });
    }
    const resolvedHandle = resolveUserHandle(handle);
    const cursor = new URL(request.url).searchParams.get('cursor');
    if (cursor && !z.string().uuid().safeParse(cursor).success) {
      return NextResponse.json({ error: 'Invalid cursor' }, { status: 400 });
    }
    if (resolvedHandle.remote) {
      const result = await fetchRemoteCollectionDetail(
        resolvedHandle.remote.handle,
        resolvedHandle.remote.domain,
        collectionId,
        cursor,
      );
      if (!result) {
        return NextResponse.json({ error: 'Collection not found' }, { status: 404 });
      }
      if (!await canCurrentViewerAccessSensitiveRemoteProfile({
        accountIsNsfw: result.profile.isNsfw,
        nodeIsNsfw: result.profile.nodeIsNsfw,
      })) {
        return NextResponse.json({ error: SENSITIVE_REMOTE_PROFILE_MESSAGE }, { status: 403 });
      }
      let remotePosts = result.collection.posts;
      const session = await getSession();
      if (session?.user && remotePosts.length > 0) {
        const targets = remotePosts.flatMap((post) => (
          post.nodeDomain && post.originalPostId
            ? [{ id: post.id, nodeDomain: post.nodeDomain, originalPostId: post.originalPostId }]
            : []
        ));
        if (targets.length > 0) {
          const { getViewerSwarmRepostedPostIds } = await import('@/lib/swarm/reposts');
          const [likedIds, repostedIds] = await Promise.all([
            getViewerSwarmLikedPostIds(
              targets,
              session.user.id,
            ),
            getViewerSwarmRepostedPostIds(targets, session.user.id),
          ]);
          remotePosts = remotePosts.map((post) => ({
            ...post,
            isLiked: likedIds.has(post.id),
            isReposted: repostedIds.has(post.id),
          }));
        }
      }
      const viewerAccess = await getSensitiveContentViewerAccess();
      return NextResponse.json({
        collection: {
          ...result.collection,
          posts: remotePosts.map((post) => redactSensitivePostForViewer(
            post as unknown as Record<string, unknown>,
            {
              canViewSensitive: viewerAccess.canViewSensitive,
              localNodeDomain: process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost:43821',
              localNodeIsNsfw: viewerAccess.localNodeIsNsfw,
            },
          )),
        },
        nextCursor: result.nextCursor,
      });
    }

    const user = await db.query.users.findFirst({
      where: { handle: resolvedHandle.canonicalHandle },
    });
    if (!user || user.isSuspended) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }
    const profileAccess = await getCurrentViewerSensitiveProfileAccess({
      accountIsNsfw: user.isNsfw,
    });
    if (!profileAccess.allowed) {
      return NextResponse.json({ error: SENSITIVE_PROFILE_MESSAGE }, { status: 403 });
    }

    const session = await getSession();
    const collection = await getLocalCollectionDetail(user.id, collectionId, session?.user.id, { cursor });
    if (!collection) {
      return NextResponse.json({ error: 'Collection not found' }, { status: 404 });
    }
    const viewerAccess = await getSensitiveContentViewerAccess();
    return NextResponse.json({
      collection: {
        ...collection,
        posts: collection.posts.map((post) => redactSensitivePostForViewer(
          post as unknown as Record<string, unknown>,
          {
            canViewSensitive: viewerAccess.canViewSensitive,
            localNodeDomain: process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost:43821',
            localNodeIsNsfw: viewerAccess.localNodeIsNsfw,
          },
        )),
      },
      nextCursor: collection.nextCursor,
    });
  } catch (error) {
    console.error('Get collection error:', error);
    return NextResponse.json({ error: 'Failed to get collection' }, { status: 500 });
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  try {
    const signedAction = signedUserActionSchema.parse(await request.json());
    const currentUser = await requireSignedAction(signedAction, 'collection_update');
    const data = updateCollectionActionDataSchema.parse(signedAction.data);
    const { handle, collectionId } = await context.params;
    const resolvedHandle = resolveUserHandle(handle);
    if (
      resolvedHandle.remote
      || resolvedHandle.canonicalHandle !== currentUser.handle
      || data.handle.toLowerCase().replace(/^@/, '') !== currentUser.handle
      || data.collectionId !== collectionId
    ) {
      return NextResponse.json({ error: 'Collection owner mismatch' }, { status: 403 });
    }

    const existing = await db.query.collections.findFirst({
      where: { AND: [{ id: collectionId }, { userId: currentUser.id }] },
    });
    if (!existing) {
      return NextResponse.json({ error: 'Collection not found' }, { status: 404 });
    }
    await db.update(collections).set({
      title: data.title,
      description: data.description,
      coverUrl: data.coverUrl,
      updatedAt: new Date(),
    }).where(eq(collections.id, collectionId));

    const summaries = await getLocalCollectionSummaries(currentUser.id);
    return NextResponse.json({
      collection: summaries.find((collection) => collection.id === collectionId),
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid collection', details: error.issues }, { status: 400 });
    }
    if (error instanceof SignedActionError) {
      return NextResponse.json({ error: 'Signed action rejected', code: error.code }, { status: 403 });
    }
    console.error('Update collection error:', error);
    return NextResponse.json({ error: 'Failed to update collection' }, { status: 500 });
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  try {
    const signedAction = signedUserActionSchema.parse(await request.json());
    const currentUser = await requireSignedAction(signedAction, 'collection_delete');
    const data = deleteCollectionActionDataSchema.parse(signedAction.data);
    const { handle, collectionId } = await context.params;
    const resolvedHandle = resolveUserHandle(handle);
    if (
      resolvedHandle.remote
      || resolvedHandle.canonicalHandle !== currentUser.handle
      || data.handle.toLowerCase().replace(/^@/, '') !== currentUser.handle
      || data.collectionId !== collectionId
    ) {
      return NextResponse.json({ error: 'Collection owner mismatch' }, { status: 403 });
    }

    const deleted = await db.delete(collections).where(and(
      eq(collections.id, collectionId),
      eq(collections.userId, currentUser.id),
    )).returning();
    if (deleted.length === 0) {
      return NextResponse.json({ error: 'Collection not found' }, { status: 404 });
    }
    return NextResponse.json({ deleted: true });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid collection', details: error.issues }, { status: 400 });
    }
    if (error instanceof SignedActionError) {
      return NextResponse.json({ error: 'Signed action rejected', code: error.code }, { status: 403 });
    }
    console.error('Delete collection error:', error);
    return NextResponse.json({ error: 'Failed to delete collection' }, { status: 500 });
  }
}
