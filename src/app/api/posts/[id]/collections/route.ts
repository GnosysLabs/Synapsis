import { NextResponse } from 'next/server';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';

import { collectionPosts, db } from '@/db';
import { requireAuth } from '@/lib/auth';
import { requireSignedAction, SignedActionError } from '@/lib/auth/verify-signature';
import { getLocalCollectionSummaries } from '@/lib/collections/data';
import { updatePostCollectionsActionDataSchema } from '@/lib/collections/schemas';
import { signedUserActionSchema } from '@/lib/e2ee/protocol';

type RouteContext = { params: Promise<{ id: string }> };

async function ownedPost(userId: string, postId: string) {
  return db.query.posts.findFirst({
    where: { AND: [{ id: postId }, { userId }, { isRemoved: false }] },
  });
}

export async function GET(_request: Request, context: RouteContext) {
  try {
    const currentUser = await requireAuth();
    const { id: postId } = await context.params;
    if (!await ownedPost(currentUser.id, postId)) {
      return NextResponse.json({ error: 'Post not found' }, { status: 404 });
    }

    const [summaries, memberships] = await Promise.all([
      getLocalCollectionSummaries(currentUser.id),
      db.query.collectionPosts.findMany({ where: { postId } }),
    ]);
    const selectedIds = new Set(memberships.map((membership) => membership.collectionId));
    return NextResponse.json({
      collections: summaries.map((collection) => ({
        ...collection,
        containsPost: selectedIds.has(collection.id),
      })),
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'Authentication required') {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }
    console.error('Get post collections error:', error);
    return NextResponse.json({ error: 'Failed to get post collections' }, { status: 500 });
  }
}

export async function PUT(request: Request, context: RouteContext) {
  try {
    const signedAction = signedUserActionSchema.parse(await request.json());
    const currentUser = await requireSignedAction(signedAction, 'post_collections_update');
    const data = updatePostCollectionsActionDataSchema.parse(signedAction.data);
    const { id: postId } = await context.params;
    if (data.postId !== postId || !await ownedPost(currentUser.id, postId)) {
      return NextResponse.json({ error: 'Post not found' }, { status: 404 });
    }

    const collectionIds = [...new Set(data.collectionIds)];
    if (collectionIds.length > 0) {
      const ownedCollections = await db.query.collections.findMany({
        where: { AND: [{ userId: currentUser.id }, { id: { in: collectionIds } }] },
      });
      if (ownedCollections.length !== collectionIds.length) {
        return NextResponse.json({ error: 'A selected collection is not available' }, { status: 400 });
      }
    }

    await db.transaction(async (tx) => {
      const ownerCollections = await tx.query.collections.findMany({
        where: { userId: currentUser.id },
        columns: { id: true },
      });
      const ownerCollectionIds = ownerCollections.map((collection) => collection.id);
      if (ownerCollectionIds.length > 0) {
        await tx.delete(collectionPosts).where(and(
          eq(collectionPosts.postId, postId),
          inArray(collectionPosts.collectionId, ownerCollectionIds),
        ));
      }
      if (collectionIds.length > 0) {
        await tx.insert(collectionPosts).values(collectionIds.map((collectionId) => ({
          collectionId,
          postId,
        })));
      }
    });

    return NextResponse.json({ collectionIds });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid collection selection', details: error.issues }, { status: 400 });
    }
    if (error instanceof SignedActionError) {
      return NextResponse.json({ error: 'Signed action rejected', code: error.code }, { status: 403 });
    }
    console.error('Update post collections error:', error);
    return NextResponse.json({ error: 'Failed to update post collections' }, { status: 500 });
  }
}
