import { NextResponse } from 'next/server';
import { z } from 'zod';

import { db } from '@/db';
import { getLocalCollectionDetail } from '@/lib/collections/data';
import { mapCollectionPostForSwarm } from '@/lib/collections/swarm';
import { requireLocalNodeNsfwClassification } from '@/lib/node/local-node';
import { hasStrictLocalUserOrigin } from '@/lib/swarm/local-user-origin';
import { isTrustedFederationRead } from '@/lib/swarm/signed-read';
import { isTrustedFederationMediaUrl } from '@/lib/utils/federation';

type RouteContext = { params: Promise<{ handle: string; collectionId: string }> };

export async function GET(request: Request, context: RouteContext) {
  try {
    if (!await isTrustedFederationRead(request)) {
      return NextResponse.json({ error: 'Signed federation read required' }, { status: 401 });
    }
    const { handle, collectionId } = await context.params;
    const cleanHandle = handle.toLowerCase().replace(/^@/, '');
    if (!/^[a-z0-9_]{1,64}$/.test(cleanHandle) || !z.string().uuid().safeParse(collectionId).success) {
      return NextResponse.json({ error: 'Collection not found' }, { status: 404 });
    }
    const user = await db.query.users.findFirst({
      where: { AND: [{ handle: cleanHandle }, { nodeId: { isNull: true } }] },
    });
    if (!user || !hasStrictLocalUserOrigin(user) || user.isSuspended) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }
    const cursor = new URL(request.url).searchParams.get('cursor');
    if (cursor && !z.string().uuid().safeParse(cursor).success) {
      return NextResponse.json({ error: 'Invalid cursor' }, { status: 400 });
    }
    const collection = await getLocalCollectionDetail(user.id, collectionId, null, { cursor });
    if (!collection) {
      return NextResponse.json({ error: 'Collection not found' }, { status: 404 });
    }

    const nodeDomain = process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost';
    const nodeIsNsfw = await requireLocalNodeNsfwClassification();
    return NextResponse.json({
      profile: {
        handle: user.handle,
        displayName: user.displayName || user.handle,
        bio: user.bio || undefined,
        avatarUrl: user.avatarUrl || undefined,
        headerUrl: user.headerUrl || undefined,
        website: user.website || undefined,
        followersCount: user.followersCount,
        followingCount: user.followingCount,
        postsCount: user.postsCount,
        createdAt: user.createdAt.toISOString(),
        isNsfw: user.isNsfw,
        nodeIsNsfw,
        nodeDomain,
        publicKey: user.publicKey,
        did: user.did,
      },
      collection: {
        id: collection.id,
        title: collection.title,
        description: collection.description,
        coverUrl: collection.coverUrl && isTrustedFederationMediaUrl(collection.coverUrl)
          ? collection.coverUrl
          : null,
        previewImages: collection.previewImages.filter((url) => isTrustedFederationMediaUrl(url)),
        postCount: collection.postCount,
        createdAt: collection.createdAt,
        updatedAt: collection.updatedAt,
      },
      posts: collection.posts.map((post) => (
        mapCollectionPostForSwarm(post, nodeDomain, nodeIsNsfw)
      )),
      nextCursor: collection.nextCursor,
      nodeDomain,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Swarm collection error:', error);
    return NextResponse.json({ error: 'Failed to get collection' }, { status: 500 });
  }
}
