/**
 * Swarm User Followers Endpoint
 * 
 * GET: Returns a user's followers list for swarm requests
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, follows, remoteFollowers, users } from '@/db';
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

export interface SwarmFollowerUser {
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
 * GET /api/swarm/users/[handle]/followers
 * 
 * Returns a user's followers list.
 * Used by other nodes to display who follows a remote user.
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

    // Get local followers
    const userFollowers = await db
      .select({
        id: follows.id,
        follower: users,
      })
      .from(follows)
      .innerJoin(users, eq(follows.followerId, users.id))
      .where(and(
        eq(follows.followingId, user.id),
        eq(users.isLocalAccount, true),
      ))
      .limit(limit);

    const localFollowers: SwarmFollowerUser[] = userFollowers
      .filter((entry) => hasStrictLocalUserOrigin(entry.follower))
      .map(f => ({
        handle: f.follower.handle,
        displayName: f.follower.displayName || f.follower.handle,
        avatarUrl: f.follower.avatarUrl || undefined,
        bio: f.follower.bio || undefined,
        isRemote: false,
        isNsfw: f.follower.isNsfw,
        nodeIsNsfw,
        nodeDomain,
      }));

    // Get remote followers
    const blockedNodeDomains = Array.from(await getBlockedNodeDomains());
    const userRemoteFollowers = await db.select().from(remoteFollowers).where(and(
      eq(remoteFollowers.userId, user.id),
      isNull(remoteFollowers.suspendedAt),
      ...(blockedNodeDomains.length > 0
        ? [notInArray(remoteFollowers.actorNodeDomain, blockedNodeDomains)]
        : []),
    )).limit(limit);

    const remoteFollowersList: SwarmFollowerUser[] = userRemoteFollowers.flatMap((f) => {
      const address = f.handle ? resolveAccountAddress(f.handle) : null;
      if (!address) return [];
      return [{
        handle: address.canonical,
        displayName: address.username,
        avatarUrl: undefined,
        bio: undefined,
        isRemote: true,
        nodeDomain: address.homeDomain,
      }];
    });

    // Federation ingress must remain local-data-only. Hydrating these entries here
    // would let an unauthenticated caller fan one request out to many remote nodes.
    const finalFollowers = [...localFollowers, ...remoteFollowersList].slice(0, limit);
    const profileRestricted = !trustedRead && (user.isNsfw || nodeIsNsfw);
    const responseFollowers = profileRestricted
      ? []
      : trustedRead
        ? finalFollowers
        : finalFollowers.map((follower) => redactSensitiveUserSummary(follower, false));

    return NextResponse.json({
      followers: responseFollowers,
      restricted: profileRestricted || undefined,
      nodeDomain,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Swarm user followers error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch followers list' },
      { status: 500 }
    );
  }
}
