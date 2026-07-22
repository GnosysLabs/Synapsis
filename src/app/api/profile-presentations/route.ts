import { NextResponse } from 'next/server';
import { inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db, users } from '@/db';
import { getSession } from '@/lib/auth';
import {
  requireCanonicalAccountHomeDomain,
  resolveAccountAddress,
} from '@/lib/identity/account-address';
import { requireLocalNodeNsfwClassification } from '@/lib/node/local-node';
import { shouldIncludeNsfwFeed } from '@/lib/nsfw/feed-access';
import { storedProfilePresentation } from '@/lib/profile/stored-presentation';
import { getKnownSwarmNodeNsfwByDomain } from '@/lib/swarm/registry';

const requestSchema = z.object({
  handles: z.array(z.string().min(1).max(320)).min(1).max(100),
});

export async function POST(request: Request) {
  try {
    if (!db) return NextResponse.json({ presentations: [] });
    const parsed = requestSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid presentation request' }, { status: 400 });
    }

    const localNodeDomain = requireCanonicalAccountHomeDomain(
      process.env.NEXT_PUBLIC_NODE_DOMAIN || process.env.NODE_DOMAIN || 'localhost:43821',
    );
    const handles = [...new Set(parsed.data.handles.flatMap((handle) => {
      const address = resolveAccountAddress(handle, localNodeDomain);
      return address ? [address.canonical] : [];
    }))];
    if (handles.length === 0) return NextResponse.json({ presentations: [] });

    const [session, localNodeIsNsfw] = await Promise.all([
      getSession(),
      requireLocalNodeNsfwClassification(),
    ]);
    const canViewSensitive = shouldIncludeNsfwFeed({
      viewer: session?.user ?? null,
      localNodeIsNsfw,
    });
    const storedUsers = await db
      .select({
        handle: users.handle,
        displayName: users.displayName,
        avatarUrl: users.avatarUrl,
        did: users.did,
        isNsfw: users.isNsfw,
        isLocalAccount: users.isLocalAccount,
        homeDomain: users.homeDomain,
        profileVersion: users.profileVersion,
        profileDocumentJson: users.profileDocumentJson,
        stuffboxBadgeProof: users.stuffboxBadgeProof,
        stuffboxBadgeLevel: users.stuffboxBadgeLevel,
        stuffboxBadgePlan: users.stuffboxBadgePlan,
        stuffboxBadgeIssuer: users.stuffboxBadgeIssuer,
        stuffboxBadgeExpiresAt: users.stuffboxBadgeExpiresAt,
      })
      .from(users)
      .where(inArray(users.handle, handles));
    const remoteDomains = new Set(storedUsers.flatMap((user) => {
      const address = resolveAccountAddress(user.handle, user.homeDomain || localNodeDomain);
      return address && address.homeDomain !== localNodeDomain ? [address.homeDomain] : [];
    }));
    const nodeNsfwByDomain = await getKnownSwarmNodeNsfwByDomain(remoteDomains);
    const presentations = storedUsers.flatMap((user) => {
      const address = resolveAccountAddress(user.handle, user.homeDomain || localNodeDomain);
      const presentation = storedProfilePresentation(user, {
        localNodeDomain,
        localNodeIsNsfw,
        canViewSensitive,
        remoteNodeIsNsfw: address
          ? nodeNsfwByDomain.get(address.homeDomain)
          : undefined,
      });
      return presentation ? [presentation] : [];
    });

    return NextResponse.json({ presentations }, {
      headers: { 'Cache-Control': 'private, no-store' },
    });
  } catch (error) {
    console.error('Profile presentation lookup failed:', error);
    return NextResponse.json({ error: 'Profile presentations could not be loaded' }, { status: 500 });
  }
}
