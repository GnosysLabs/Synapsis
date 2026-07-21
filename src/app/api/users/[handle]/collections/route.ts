import { NextResponse } from 'next/server';
import { z } from 'zod';

import { collectionPosts, collections, db } from '@/db';
import { getSession } from '@/lib/auth';
import { requireSignedAction, SignedActionError } from '@/lib/auth/verify-signature';
import { getLocalCollectionSummaries } from '@/lib/collections/data';
import { fetchRemoteCollectionList } from '@/lib/collections/federation';
import { createCollectionActionDataSchema } from '@/lib/collections/schemas';
import { signedUserActionSchema } from '@/lib/e2ee/protocol';
import {
  canCurrentViewerAccessSensitiveRemoteProfile,
  getCurrentViewerSensitiveProfileAccess,
  SENSITIVE_REMOTE_PROFILE_MESSAGE,
  SENSITIVE_PROFILE_MESSAGE,
} from '@/lib/nsfw/remote-profile-access';
import { resolveUserHandle } from '@/lib/swarm/user-handle';

type RouteContext = { params: Promise<{ handle: string }> };

export async function GET(request: Request, context: RouteContext) {
  try {
    const { handle } = await context.params;
    const resolvedHandle = resolveUserHandle(handle);
    if (resolvedHandle.remote) {
      const result = await fetchRemoteCollectionList(
        resolvedHandle.remote.handle,
        resolvedHandle.remote.domain,
      );
      if (!result) {
        return NextResponse.json({ error: 'Collections could not be loaded' }, { status: 502 });
      }
      if (!await canCurrentViewerAccessSensitiveRemoteProfile({
        accountIsNsfw: result.profile.isNsfw,
        nodeIsNsfw: result.profile.nodeIsNsfw,
      })) {
        return NextResponse.json(
          { collections: [], restricted: true, error: SENSITIVE_REMOTE_PROFILE_MESSAGE },
          { status: 403 },
        );
      }
      return NextResponse.json({ collections: result.collections });
    }

    const user = await db.query.users.findFirst({
      where: {
        AND: [
          { handle: resolvedHandle.canonicalHandle },
          { isLocalAccount: true },
        ],
      },
    });
    if (!user || user.isSuspended) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    const profileAccess = await getCurrentViewerSensitiveProfileAccess({
      accountIsNsfw: user.isNsfw,
    });
    if (!profileAccess.allowed) {
      return NextResponse.json(
        { collections: [], restricted: true, error: SENSITIVE_PROFILE_MESSAGE },
        { status: 403 },
      );
    }

    const summaries = await getLocalCollectionSummaries(user.id);
    const postId = new URL(request.url).searchParams.get('postId');
    const session = postId ? await getSession() : null;
    if (!postId || session?.user.id !== user.id || !z.string().uuid().safeParse(postId).success) {
      return NextResponse.json({ collections: summaries });
    }

    const selectedMemberships = await db.query.collectionPosts.findMany({
      where: { postId },
    });
    const selectedIds = new Set(selectedMemberships.map((membership) => membership.collectionId));
    return NextResponse.json({
      collections: summaries.map((collection) => ({
        ...collection,
        containsPost: selectedIds.has(collection.id),
      })),
    });
  } catch (error) {
    console.error('Get collections error:', error);
    return NextResponse.json({ error: 'Failed to get collections' }, { status: 500 });
  }
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const signedAction = signedUserActionSchema.parse(await request.json());
    const currentUser = await requireSignedAction(signedAction, 'collection_create');
    const data = createCollectionActionDataSchema.parse(signedAction.data);
    const { handle } = await context.params;
    const resolvedHandle = resolveUserHandle(handle);

    if (
      resolvedHandle.remote
      || resolvedHandle.canonicalHandle !== currentUser.handle
      || data.handle !== currentUser.handle
    ) {
      return NextResponse.json({ error: 'Collection owner mismatch' }, { status: 403 });
    }
    if (currentUser.isSuspended || currentUser.isSilenced) {
      return NextResponse.json({ error: 'Account restricted' }, { status: 403 });
    }

    const existingCollections = await db.query.collections.findMany({
      where: { userId: currentUser.id },
      columns: { id: true },
      limit: 200,
    });
    if (existingCollections.length >= 200) {
      return NextResponse.json({ error: 'Collection limit reached' }, { status: 400 });
    }

    const postIds = [...new Set(data.postIds)];
    if (postIds.length > 0) {
      const ownedPosts = await db.query.posts.findMany({
        where: {
          AND: [
            { id: { in: postIds } },
            { userId: currentUser.id },
            { isRemoved: false },
          ],
        },
      });
      if (ownedPosts.length !== postIds.length) {
        return NextResponse.json({ error: 'A selected post is not available' }, { status: 400 });
      }
    }

    const created = await db.transaction(async (tx) => {
      const [collection] = await tx.insert(collections).values({
        userId: currentUser.id,
        title: data.title,
        description: data.description,
        coverUrl: data.coverUrl,
      }).returning();
      if (postIds.length > 0) {
        await tx.insert(collectionPosts).values(postIds.map((postId) => ({
          collectionId: collection.id,
          postId,
        })));
      }
      return collection;
    });

    return NextResponse.json({
      collection: {
        id: created.id,
        title: created.title,
        description: created.description,
        coverUrl: created.coverUrl,
        previewImages: [],
        postCount: postIds.length,
        createdAt: created.createdAt.toISOString(),
        updatedAt: created.updatedAt.toISOString(),
      },
    }, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid collection', details: error.issues }, { status: 400 });
    }
    if (error instanceof SignedActionError) {
      return NextResponse.json({ error: 'Signed action rejected', code: error.code }, { status: 403 });
    }
    console.error('Create collection error:', error);
    return NextResponse.json({ error: 'Failed to create collection' }, { status: 500 });
  }
}
