/**
 * Swarm User Followers Endpoint
 * 
 * GET: Returns a user's followers list for swarm requests
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, follows, users } from '@/db';
import { and, eq, isNull, notLike } from 'drizzle-orm';
import { hydrateSwarmUsers } from '@/lib/swarm/user-hydration';
import { requireLocalNodeNsfwClassification } from '@/lib/node/local-node';
import { redactSensitiveUserSummary } from '@/lib/nsfw/content-visibility';
import { hasStrictLocalUserOrigin } from '@/lib/swarm/local-user-origin';
import { isTrustedFederationRead } from '@/lib/swarm/signed-read';
import { parseBoundedInteger } from '@/lib/http/query';

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
        isNull(users.nodeId),
        notLike(users.handle, '%@%'),
      ))
      .limit(limit);

    const localFollowers: SwarmFollowerUser[] = userFollowers
      .filter((entry) => hasStrictLocalUserOrigin(entry.follower))
      .map(f => ({
        handle: f.follower.handle, // Local handle without domain
        displayName: f.follower.displayName || f.follower.handle,
        avatarUrl: f.follower.avatarUrl || undefined,
        bio: f.follower.bio || undefined,
        isRemote: false,
        isNsfw: f.follower.isNsfw,
        nodeIsNsfw,
        nodeDomain,
      }));

    // Get remote followers
    const userRemoteFollowers = await db.query.remoteFollowers.findMany({
      where: { userId: user.id },
      limit,
    });

    const remoteFollowersList: SwarmFollowerUser[] = userRemoteFollowers.map(f => ({
      handle: f.handle || 'unknown', // Remote handle with @domain
      displayName: f.handle?.split('@')[0] || 'Unknown',
      avatarUrl: undefined,
      bio: undefined,
      isRemote: true,
      nodeDomain: f.handle?.split('@').pop(),
    }));

    // Merge all followers
    const allFollowers = [...localFollowers, ...remoteFollowersList].slice(0, limit);

    // Hydrate remote users (from 3rd party nodes)
    // We need to map to the HydratedUser interface temporarily for the helper
    const toHydrate = allFollowers.map(f => ({
      id: f.handle,
      handle: f.handle,
      displayName: f.displayName,
      avatarUrl: f.avatarUrl,
      bio: f.bio,
      isRemote: f.isRemote || false,
      nodeDomain: undefined,
      isNsfw: f.isNsfw,
      nodeIsNsfw: f.nodeIsNsfw,
    }));

    const hydrated = await hydrateSwarmUsers(toHydrate);

    // Map back to SwarmFollowerUser
    const finalFollowers: SwarmFollowerUser[] = hydrated.map(u => ({
      handle: u.handle,
      displayName: u.displayName || u.handle.split('@')[0], // Ensure non-null
      avatarUrl: u.avatarUrl || undefined, // Map null to undefined
      bio: u.bio || undefined,
      isRemote: u.isRemote,
      isNsfw: u.isNsfw,
      nodeIsNsfw: u.nodeIsNsfw,
      nodeDomain: u.nodeDomain,
    }));
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
