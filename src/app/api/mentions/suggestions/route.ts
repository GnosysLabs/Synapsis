import { NextRequest, NextResponse } from 'next/server';
import { and, eq, like, notLike, or } from 'drizzle-orm';
import { z } from 'zod';

import { db, blocks, mutedNodes, mutes, remoteFollows, users } from '@/db';
import { requireAuth } from '@/lib/auth';
import { discoverNode } from '@/lib/swarm/discovery';
import { isSwarmNode } from '@/lib/swarm/interactions';
import { getPublicSwarmDomain, normalizeNodeDomain } from '@/lib/swarm/node-domain';
import { safeFederationRequest } from '@/lib/swarm/safe-federation-http';
import { resolveUserHandle } from '@/lib/swarm/user-handle';
import { isValidNodeDomain } from '@/lib/utils/federation';

const querySchema = z.object({
  q: z.string().max(280),
  limit: z.coerce.number().int().min(1).max(12).default(8),
});

const remoteDirectorySchema = z.object({
  users: z.array(z.object({
    handle: z.string().min(3).max(30).regex(/^[a-zA-Z0-9_]+$/),
    displayName: z.string().max(100).nullable(),
    avatarUrl: z.string().url().nullable(),
  })).max(12),
});

export interface MentionSuggestion {
  handle: string;
  displayName: string | null;
  avatarUrl: string | null;
  isRemote: boolean;
  nodeDomain: string | null;
}

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
): Promise<MentionSuggestion[]> {
  const pattern = `${query.toLowerCase()}%`;
  const rows = await db.select({
    id: users.id,
    handle: users.handle,
    displayName: users.displayName,
    avatarUrl: users.avatarUrl,
  })
    .from(users)
    .where(and(
      or(like(users.handle, pattern), like(users.displayName, pattern)),
      notLike(users.handle, '%@%'),
      eq(users.isSuspended, false),
      eq(users.isSilenced, false),
    ))
    .limit(Math.min(30, limit + excludedIds.size + 4));

  return rows
    .filter((row) => !row.handle.includes('@') && !excludedIds.has(row.id))
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
    }));
}

async function mutedNodeDomains(viewerId: string): Promise<Set<string>> {
  const rows = await db.select({ nodeDomain: mutedNodes.nodeDomain })
    .from(mutedNodes)
    .where(eq(mutedNodes.userId, viewerId));
  return new Set(rows.map((row) => normalizeNodeDomain(row.nodeDomain)));
}

async function fetchRemoteSuggestions(
  handleQuery: string,
  domain: string,
  limit: number,
): Promise<MentionSuggestion[]> {
  let known = await isSwarmNode(domain);
  if (!known) known = (await discoverNode(domain)).success;
  if (!known) return [];

  const publicDomain = getPublicSwarmDomain(domain);
  const isDevelopmentLoopback = process.env.NODE_ENV === 'development'
    && /^(?:localhost|127\.0\.0\.1)(?::\d{1,5})?$/.test(domain);
  if (!publicDomain && !isDevelopmentLoopback) return [];

  const protocol = isDevelopmentLoopback ? 'http' : 'https';
  const url = new URL('/api/swarm/users', `${protocol}://${publicDomain || domain}`);
  url.searchParams.set('q', handleQuery);
  url.searchParams.set('limit', String(limit));
  const response = await safeFederationRequest(url.toString(), {
    headers: { Accept: 'application/json' },
    maxResponseBytes: 64 * 1024,
    timeoutMs: 4_000,
  });
  if (response.status < 200 || response.status >= 300) return [];

  const parsed = remoteDirectorySchema.safeParse(response.json());
  if (!parsed.success) return [];
  return parsed.data.users.map((user) => ({
    ...user,
    handle: `${user.handle.toLowerCase()}@${domain}`,
    isRemote: true,
    nodeDomain: domain,
  }));
}

export async function GET(request: NextRequest) {
  try {
    const viewer = await requireAuth();
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
          suggestions: await localSuggestions(handleQuery, parsed.data.limit, excludedIds),
        });
      }

      const domain = normalizeNodeDomain(requestedDomain);
      const mutedDomains = await mutedNodeDomains(viewer.id);
      if (mutedDomains.has(domain)) {
        return NextResponse.json({ suggestions: [] });
      }

      const suggestions = await fetchRemoteSuggestions(handleQuery, domain, parsed.data.limit);
      const cachedRemoteUsers = suggestions.length
        ? await db.select({ id: users.id, handle: users.handle })
          .from(users)
          .where(or(...suggestions.map((suggestion) => eq(users.handle, suggestion.handle))))
        : [];
      const excludedHandles = new Set(
        cachedRemoteUsers.filter((user) => excludedIds.has(user.id)).map((user) => user.handle.toLowerCase()),
      );
      return NextResponse.json({
        suggestions: suggestions.filter((suggestion) => !excludedHandles.has(suggestion.handle.toLowerCase())),
      });
    }

    const local = await localSuggestions(query, parsed.data.limit, excludedIds);
    if (local.length >= parsed.data.limit) {
      return NextResponse.json({ suggestions: local });
    }

    const mutedDomains = await mutedNodeDomains(viewer.id);
    const knownRemote = await db.select({
      handle: remoteFollows.targetHandle,
      displayName: remoteFollows.displayName,
      avatarUrl: remoteFollows.avatarUrl,
    })
      .from(remoteFollows)
      .where(and(
        eq(remoteFollows.followerId, viewer.id),
        or(
          like(remoteFollows.targetHandle, `${query}%`),
          like(remoteFollows.displayName, `${query}%`),
        ),
      ))
      .limit(parsed.data.limit);

    const seen = new Set(local.map((item) => item.handle.toLowerCase()));
    const remote = knownRemote.flatMap<MentionSuggestion>((row) => {
      const parts = row.handle.toLowerCase().split('@');
      if (parts.length !== 2 || !parts[0] || !parts[1] || mutedDomains.has(normalizeNodeDomain(parts[1]))) return [];
      if (seen.has(row.handle.toLowerCase())) return [];
      seen.add(row.handle.toLowerCase());
      return [{
        handle: row.handle.toLowerCase(),
        displayName: row.displayName,
        avatarUrl: row.avatarUrl,
        isRemote: true,
        nodeDomain: parts[1],
      }];
    });

    return NextResponse.json({ suggestions: [...local, ...remote].slice(0, parsed.data.limit) });
  } catch (error) {
    if (error instanceof Error && ['Unauthorized', 'Authentication required'].includes(error.message)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('[Mentions] Suggestion lookup failed:', error);
    return NextResponse.json({ error: 'Failed to load mention suggestions' }, { status: 500 });
  }
}
