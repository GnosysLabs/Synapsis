import { NextResponse } from 'next/server';

import { db } from '@/db';
import { getLocalCollectionSummaries } from '@/lib/collections/data';
import { requireLocalNodeNsfwClassification } from '@/lib/node/local-node';
import { hasStrictLocalUserOrigin } from '@/lib/swarm/local-user-origin';
import { authorizeFederationRead, federationReadFailureResponse } from '@/lib/swarm/signed-read';
import { isTrustedFederationMediaUrl } from '@/lib/utils/federation';

type RouteContext = { params: Promise<{ handle: string }> };

export async function GET(request: Request, context: RouteContext) {
  try {
    const readAuthorization = await authorizeFederationRead(request);
    if (!readAuthorization.ok) return federationReadFailureResponse(readAuthorization);
    const { handle } = await context.params;
    const cleanHandle = handle.toLowerCase().replace(/^@/, '');
    if (!/^[a-z0-9_]{1,64}$/.test(cleanHandle)) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }
    const user = await db.query.users.findFirst({
      where: { AND: [{ handle: cleanHandle }, { nodeId: { isNull: true } }] },
    });
    if (!user || !hasStrictLocalUserOrigin(user) || user.isSuspended) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    const nodeDomain = process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost';
    const nodeIsNsfw = await requireLocalNodeNsfwClassification();
    const collections = (await getLocalCollectionSummaries(user.id)).map((collection) => ({
      ...collection,
      coverUrl: collection.coverUrl && isTrustedFederationMediaUrl(collection.coverUrl)
        ? collection.coverUrl
        : null,
      previewImages: collection.previewImages.filter((url) => isTrustedFederationMediaUrl(url)),
    }));
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
      posts: [],
      collections,
      nodeDomain,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Swarm collections error:', error);
    return NextResponse.json({ error: 'Failed to get collections' }, { status: 500 });
  }
}
