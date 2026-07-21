/**
 * Swarm User Following Endpoint
 * 
 * GET: Returns a user's following list for swarm requests
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, follows, remoteFollows, users } from '@/db';
import { and, eq, isNull, notInArray } from 'drizzle-orm';
import { requireLocalNodeNsfwClassification } from '@/lib/node/local-node';
import { redactSensitiveUserSummary } from '@/lib/nsfw/content-visibility';
import { hasStrictLocalUserOrigin } from '@/lib/swarm/local-user-origin';
import { authorizeFederationRead, federationReadFailureResponse } from '@/lib/swarm/signed-read';
import { parseBoundedInteger } from '@/lib/http/query';
import { getBlockedNodeDomains } from '@/lib/swarm/node-blocklist';
import {
  requireCanonicalAccountHomeDomain,
  resolveAccountAddress,
} from '@/lib/identity/account-address';

export interface SwarmFollowingUser {
  handle: string;
  displayName: string;
  avatarUrl?: string;
  bio?: string;
  isRemote?: boolean;
  isNsfw?: boolean;
  nodeIsNsfw?: boolean;
  nodeDomain?: string;
}

type RouteContext = { params: Promise<{ handle: string }> };

/**
 * GET /api/swarm/users/[handle]/following
 * 
 * Returns a user's following list.
 * Used by other nodes to display who a remote user follows.
 */
export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const readAuthorization = await authorizeFederationRead(request);
    if (!readAuthorization.ok) return federationReadFailureResponse(readAuthorization);
    const { handle } = await context.params;
    const cleanHandle = handle.toLowerCase().replace(/^@/, '');
    if (!/^[a-z0-9_]{1,64}$/.test(cleanHandle)) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }
    const { searchParams } = new URL(request.url);
    const limit = parseBoundedInteger(searchParams.get('limit'), {
      defaultValue: 50,
      min: 1,
      max: 100,
    });

    if (!db) {
      return NextResponse.json({ error: 'Database not available' }, { status: 503 });
    }

    const nodeDomain = requireCanonicalAccountHomeDomain(
      process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost:43821',
    );
    const localAddress = resolveAccountAddress(cleanHandle, nodeDomain);
    if (!localAddress || localAddress.homeDomain !== nodeDomain) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }
    const nodeIsNsfw = await requireLocalNodeNsfwClassification();
    const trustedRead = true;

    // Find the user
    const user = await db.query.users.findFirst({
      where: {
        AND: [
          { username: localAddress.username },
          { homeDomain: nodeDomain },
          { isLocalAccount: true },
        ],
      },
    });

    if (!user || !hasStrictLocalUserOrigin(user)) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    if (user.isSuspended) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    // Get local following
    const userFollowing = await db
      .select({
        id: follows.id,
        following: users,
      })
      .from(follows)
      .innerJoin(users, eq(follows.followingId, users.id))
      .where(and(
        eq(follows.followerId, user.id),
        eq(users.isLocalAccount, true),
      ))
      .limit(limit);

    const localFollowing: SwarmFollowingUser[] = userFollowing
      .filter((entry) => hasStrictLocalUserOrigin(entry.following))
      .map(f => ({
        handle: f.following.handle,
        displayName: f.following.displayName || f.following.handle,
        avatarUrl: f.following.avatarUrl || undefined,
        bio: f.following.bio || undefined,
        isRemote: false,
        isNsfw: f.following.isNsfw,
        nodeIsNsfw,
        nodeDomain,
      }));

    // Get remote following
    const blockedNodeDomains = Array.from(await getBlockedNodeDomains());
    const userRemoteFollowing = await db.select().from(remoteFollows).where(and(
      eq(remoteFollows.followerId, user.id),
      isNull(remoteFollows.suspendedAt),
      ...(blockedNodeDomains.length > 0
        ? [notInArray(remoteFollows.targetNodeDomain, blockedNodeDomains)]
        : []),
    )).limit(limit);

    const remoteFollowing: SwarmFollowingUser[] = userRemoteFollowing.flatMap((f) => {
      const address = resolveAccountAddress(f.targetHandle);
      if (!address) return [];
      return [{
        handle: address.canonical,
        displayName: f.displayName || address.username,
        avatarUrl: f.avatarUrl || undefined,
        bio: f.bio || undefined,
        isRemote: true,
        nodeDomain: address.homeDomain,
      }];
    });

    // Federation ingress must remain local-data-only. Hydrating these entries here
    // would let an unauthenticated caller fan one request out to many remote nodes.
    const finalFollowing = [...localFollowing, ...remoteFollowing].slice(0, limit);
    const profileRestricted = !trustedRead && (user.isNsfw || nodeIsNsfw);
    const responseFollowing = profileRestricted
      ? []
      : trustedRead
        ? finalFollowing
        : finalFollowing.map((entry) => redactSensitiveUserSummary(entry, false));

    return NextResponse.json({
      following: responseFollowing,
      restricted: profileRestricted || undefined,
      nodeDomain,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Swarm user following error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch following list' },
      { status: 500 }
    );
  }
}
