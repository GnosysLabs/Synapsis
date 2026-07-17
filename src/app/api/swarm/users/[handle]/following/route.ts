/**
 * Swarm User Following Endpoint
 * 
 * GET: Returns a user's following list for swarm requests
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, follows, users } from '@/db';
import { and, eq, isNull, notLike } from 'drizzle-orm';
import { hydrateSwarmUsers } from '@/lib/swarm/user-hydration';
import { requireLocalNodeNsfwClassification } from '@/lib/node/local-node';
import { redactSensitiveUserSummary } from '@/lib/nsfw/content-visibility';
import { hasStrictLocalUserOrigin } from '@/lib/swarm/local-user-origin';
import { isTrustedFederationRead } from '@/lib/swarm/signed-read';

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
    const { handle } = await context.params;
    const cleanHandle = handle.toLowerCase().replace(/^@/, '');
    if (!/^[a-z0-9_]{1,64}$/.test(cleanHandle)) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }
    const { searchParams } = new URL(request.url);
    const limit = Math.min(parseInt(searchParams.get('limit') || '50'), 100);

    if (!db) {
      return NextResponse.json({ error: 'Database not available' }, { status: 503 });
    }

    const nodeDomain = process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost';
    const nodeIsNsfw = await requireLocalNodeNsfwClassification();
    const trustedRead = await isTrustedFederationRead(request);

    // Find the user
    const user = await db.query.users.findFirst({
      where: {
        AND: [
          { handle: cleanHandle },
          { nodeId: { isNull: true } },
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
        isNull(users.nodeId),
        notLike(users.handle, '%@%'),
      ))
      .limit(limit);

    const localFollowing: SwarmFollowingUser[] = userFollowing
      .filter((entry) => hasStrictLocalUserOrigin(entry.following))
      .map(f => ({
        handle: f.following.handle, // Local handle without domain
        displayName: f.following.displayName || f.following.handle,
        avatarUrl: f.following.avatarUrl || undefined,
        bio: f.following.bio || undefined,
        isRemote: false,
        isNsfw: f.following.isNsfw,
        nodeIsNsfw,
        nodeDomain,
      }));

    // Get remote following
    const userRemoteFollowing = await db.query.remoteFollows.findMany({
      where: { followerId: user.id },
      limit,
    });

    const remoteFollowing: SwarmFollowingUser[] = userRemoteFollowing.map(f => ({
      handle: f.targetHandle, // Already includes @domain
      displayName: f.displayName || f.targetHandle.split('@')[0],
      avatarUrl: f.avatarUrl || undefined,
      bio: f.bio || undefined,
      isRemote: true,
      nodeDomain: f.targetHandle.split('@').pop(),
    }));

    // Merge all following
    const allFollowing = [...localFollowing, ...remoteFollowing].slice(0, limit);
    const hydrated = await hydrateSwarmUsers(allFollowing.map((entry) => ({
      id: entry.handle,
      ...entry,
      isRemote: entry.isRemote === true,
    })));

    const finalFollowing = hydrated.map((entry) => ({
        handle: entry.handle,
        displayName: entry.displayName || entry.handle.split('@')[0],
        avatarUrl: entry.avatarUrl || undefined,
        bio: entry.bio || undefined,
        isRemote: entry.isRemote,
        isNsfw: entry.isNsfw,
        nodeIsNsfw: entry.nodeIsNsfw,
        nodeDomain: entry.nodeDomain,
      }));
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
