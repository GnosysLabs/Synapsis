import { NextRequest, NextResponse } from 'next/server';
import { and, eq, isNull, like, or } from 'drizzle-orm';
import { z } from 'zod';

import { db, blocks, mutedNodes, mutes, remoteFollows, users } from '@/db';
import { requireAuth } from '@/lib/auth';
import { resolveUserHandle } from '@/lib/swarm/user-handle';
import { fetchSwarmUserDirectory } from '@/lib/swarm/user-directory';
import { searchKnownSwarmUsers } from '@/lib/swarm/user-directory-search';
import { isValidNodeDomain } from '@/lib/utils/federation';
import { requireLocalNodeNsfwClassification } from '@/lib/node/local-node';
import { shouldIncludeNsfwFeed } from '@/lib/nsfw/feed-access';
import { redactSensitiveUserSummary } from '@/lib/nsfw/content-visibility';
import {
  mergeMentionSuggestions,
  type MentionSuggestion,
} from '@/lib/mentions/suggestions';
import {
  canonicalAccountHomeDomain,
  parseAccountAddress,
  requireCanonicalAccountHomeDomain,
} from '@/lib/identity/account-address';
import { getBlockedNodeDomains } from '@/lib/swarm/node-blocklist';

const querySchema = z.object({
  q: z.string().max(280),
  limit: z.coerce.number().int().min(1).max(12).default(8),
});

const MENTION_SWARM_TIMEOUT_MS = 1_500;

async function excludedLocalUserIds(viewerId: string): Promise<Set<string>> {
  const [blockRows, muteRows] = await Promise.all([
    db.select({ userId: blocks.userId, blockedUserId: blocks.blockedUserId })
      .from(blocks)
      .where(or(eq(blocks.userId, viewerId), eq(blocks.blockedUserId, viewerId))),
    db.select({ mutedUserId: mutes.mutedUserId })
      .from(mutes)
      .where(eq(mutes.userId, viewerId)),
  ]);

  const ids = new Set<string>(muteRows.map((row) => row.mutedUserId));
  for (const row of blockRows) {
    ids.add(row.userId === viewerId ? row.blockedUserId : row.userId);
  }
  return ids;
}

async function localSuggestions(
  query: string,
  limit: number,
  excludedIds: ReadonlySet<string>,
  nodeIsNsfw: boolean,
): Promise<MentionSuggestion[]> {
  const pattern = `${query.toLowerCase()}%`;
  const rows = await db.select({
    id: users.id,
    handle: users.handle,
    displayName: users.displayName,
    avatarUrl: users.avatarUrl,
    isNsfw: users.isNsfw,
  })
    .from(users)
    .where(and(
      or(like(users.username, pattern), like(users.displayName, pattern)),
      eq(users.isLocalAccount, true),
      eq(users.isSuspended, false),
      eq(users.isSilenced, false),
    ))
    .limit(Math.min(30, limit + excludedIds.size + 4));

  return rows
    .filter((row) => !excludedIds.has(row.id))
    .sort((left, right) => {
      const leftExact = left.handle.toLowerCase() === query.toLowerCase() ? 0 : 1;
      const rightExact = right.handle.toLowerCase() === query.toLowerCase() ? 0 : 1;
      return leftExact - rightExact || left.handle.localeCompare(right.handle);
    })
    .slice(0, limit)
    .map((row) => ({
      handle: row.handle,
      displayName: row.displayName,
      avatarUrl: row.avatarUrl,
      isRemote: false,
      nodeDomain: null,
      isNsfw: row.isNsfw,
      nodeIsNsfw,
    }));
}

async function mutedNodeDomains(viewerId: string): Promise<Set<string>> {
  const rows = await db.select({ nodeDomain: mutedNodes.nodeDomain })
    .from(mutedNodes)
    .where(eq(mutedNodes.userId, viewerId));
  return new Set(rows.flatMap((row) => {
    const domain = canonicalAccountHomeDomain(row.nodeDomain);
    return domain ? [domain] : [];
  }));
}

async function excludeBlockedRemoteSuggestions(
  suggestions: MentionSuggestion[],
  excludedIds: ReadonlySet<string>,
): Promise<MentionSuggestion[]> {
  if (suggestions.length === 0 || excludedIds.size === 0) return suggestions;

  const uniqueHandles = [...new Set(suggestions.map((suggestion) => suggestion.handle.toLowerCase()))];
  const cachedRemoteUsers = await db.select({ id: users.id, handle: users.handle })
    .from(users)
    .where(or(...uniqueHandles.map((handle) => eq(users.handle, handle))));
  const excludedHandles = new Set(
    cachedRemoteUsers
      .filter((user) => excludedIds.has(user.id))
      .map((user) => user.handle.toLowerCase()),
  );
  return suggestions.filter((suggestion) => !excludedHandles.has(suggestion.handle.toLowerCase()));
}

export async function GET(request: NextRequest) {
  try {
    const viewer = await requireAuth();
    const localNodeIsNsfw = await requireLocalNodeNsfwClassification();
    const canViewSensitive = shouldIncludeNsfwFeed({
      viewer,
      localNodeIsNsfw,
    });
    const redactSuggestions = (suggestions: MentionSuggestion[]) => (
      suggestions.map((suggestion) => redactSensitiveUserSummary(suggestion, canViewSensitive))
    );
    const parsed = querySchema.safeParse({
      q: (request.nextUrl.searchParams.get('q') || '').replace(/^@/, '').trim(),
      limit: request.nextUrl.searchParams.get('limit') || undefined,
    });
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid query' }, { status: 400 });
    }

    const query = parsed.data.q.toLowerCase();
    const excludedIds = await excludedLocalUserIds(viewer.id);
    const separator = query.indexOf('@');

    if (separator >= 0) {
      const handleQuery = query.slice(0, separator);
      const requestedDomain = query.slice(separator + 1);
      if (!/^[a-zA-Z0-9_]{0,30}$/.test(handleQuery)
        || !isValidNodeDomain(requestedDomain)) {
        return NextResponse.json({ suggestions: [] });
      }

      const resolution = resolveUserHandle(`user@${requestedDomain}`);
      if (resolution.isLocal) {
        return NextResponse.json({
          suggestions: redactSuggestions(await localSuggestions(
            handleQuery,
            parsed.data.limit,
            excludedIds,
            localNodeIsNsfw,
          )),
        });
      }

      const domain = canonicalAccountHomeDomain(requestedDomain);
      if (!domain) return NextResponse.json({ suggestions: [] });
      const [mutedDomains, blockedNodeDomains] = await Promise.all([
        mutedNodeDomains(viewer.id),
        getBlockedNodeDomains(),
      ]);
      if (mutedDomains.has(domain) || blockedNodeDomains.has(domain)) {
        return NextResponse.json({ suggestions: [] });
      }

      const suggestions = await fetchSwarmUserDirectory(handleQuery, domain, parsed.data.limit);
      return NextResponse.json({
        suggestions: redactSuggestions(
          await excludeBlockedRemoteSuggestions(suggestions, excludedIds),
        ),
      });
    }

    const local = await localSuggestions(query, parsed.data.limit, excludedIds, localNodeIsNsfw);
    const [mutedDomains, blockedNodeDomains, knownRemote] = await Promise.all([
      mutedNodeDomains(viewer.id),
      getBlockedNodeDomains(),
      db.select({
      handle: remoteFollows.targetHandle,
      displayName: remoteFollows.displayName,
      avatarUrl: remoteFollows.avatarUrl,
      })
        .from(remoteFollows)
        .where(and(
          eq(remoteFollows.followerId, viewer.id),
          isNull(remoteFollows.suspendedAt),
          or(
            like(remoteFollows.targetHandle, `${query}%`),
            like(remoteFollows.displayName, `${query}%`),
          ),
        ))
        .limit(parsed.data.limit),
    ]);
    const excludedNodeDomains = new Set([...mutedDomains, ...blockedNodeDomains]);

    const seen = new Set(local.map((item) => item.handle.toLowerCase()));
    const followedRemote = knownRemote.flatMap<MentionSuggestion>((row) => {
      const address = parseAccountAddress(row.handle);
      if (!address || excludedNodeDomains.has(address.homeDomain)) return [];
      if (seen.has(address.canonical)) return [];
      seen.add(address.canonical);
      return [{
        handle: address.canonical,
        displayName: row.displayName,
        avatarUrl: row.avatarUrl,
        isRemote: true,
        nodeDomain: address.homeDomain,
      }];
    });

    const localDomain = requireCanonicalAccountHomeDomain(
      process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost:43821',
    );
    const discoveredRemote = await searchKnownSwarmUsers(query, {
      limit: parsed.data.limit,
      localDomain,
      excludedDomains: excludedNodeDomains,
      timeoutMs: MENTION_SWARM_TIMEOUT_MS,
    });
    const remote = await excludeBlockedRemoteSuggestions(
      [...followedRemote, ...discoveredRemote],
      excludedIds,
    );

    return NextResponse.json({
      suggestions: redactSuggestions(
        mergeMentionSuggestions(local, remote, parsed.data.limit),
      ),
    });
  } catch (error) {
    if (error instanceof Error && ['Unauthorized', 'Authentication required'].includes(error.message)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('[Mentions] Suggestion lookup failed:', error);
    return NextResponse.json({ error: 'Failed to load mention suggestions' }, { status: 500 });
  }
}
