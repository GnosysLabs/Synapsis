import { and, asc, eq, inArray, like } from 'drizzle-orm';

import { db, handleRegistry, swarmNodes } from '@/db';
import { normalizeNodeDomain } from '@/lib/swarm/node-domain';
import {
    fetchSwarmUserDirectory,
    type SwarmDirectoryUser,
} from '@/lib/swarm/user-directory';

const MAX_DIRECTORY_CANDIDATES = 100;

export async function searchKnownSwarmUsers(
    query: string,
    options: {
        limit: number;
        localDomain?: string;
        excludedDomains?: ReadonlySet<string>;
        timeoutMs?: number;
    },
): Promise<SwarmDirectoryUser[]> {
    const normalizedQuery = query.toLowerCase().replace(/^@/, '').trim();
    if (!normalizedQuery || !/^[a-z0-9_]{1,30}$/i.test(normalizedQuery)) return [];

    const registryRows = await db.select({
        handle: handleRegistry.handle,
        nodeDomain: handleRegistry.nodeDomain,
    })
        .from(handleRegistry)
        .where(like(handleRegistry.handle, `${normalizedQuery}%`))
        .orderBy(asc(handleRegistry.handle))
        .limit(Math.min(MAX_DIRECTORY_CANDIDATES, Math.max(options.limit * 4, options.limit)));
    const candidateDomains = [...new Set(
        registryRows.map((row) => normalizeNodeDomain(row.nodeDomain)).filter(Boolean),
    )];
    if (candidateDomains.length === 0) return [];

    // Resolve only matching directory domains locally; swarm size never changes this query's fan-out.
    const activeNodes = await db.select({
        domain: swarmNodes.domain,
        isNsfw: swarmNodes.isNsfw,
        nsfwClassificationKnown: swarmNodes.nsfwClassificationKnown,
    })
        .from(swarmNodes)
        .where(and(
            inArray(swarmNodes.domain, candidateDomains),
            eq(swarmNodes.isActive, true),
            eq(swarmNodes.isBlocked, false),
        ));

    const localDomain = normalizeNodeDomain(options.localDomain || '');
    const activeNodeByDomain = new Map(
        activeNodes.map((node) => [normalizeNodeDomain(node.domain), {
            ...node,
            isNsfw: node.isNsfw
                ? true
                : node.nsfwClassificationKnown ? false : undefined,
        }]),
    );
    const seen = new Set<string>();
    const candidates = registryRows.flatMap<SwarmDirectoryUser>((row) => {
        const domain = normalizeNodeDomain(row.nodeDomain);
        const node = activeNodeByDomain.get(domain);
        const canonicalHandle = `${row.handle.toLowerCase()}@${domain}`;
        if (
            !domain
            || domain === localDomain
            || !node
            || options.excludedDomains?.has(domain)
            || seen.has(canonicalHandle)
        ) return [];
        seen.add(canonicalHandle);
        return [{
            handle: canonicalHandle,
            displayName: row.handle,
            avatarUrl: null,
            isRemote: true,
            nodeDomain: domain,
            nodeIsNsfw: node.isNsfw,
        }];
    }).sort((left, right) => {
        const leftExact = left.handle.split('@')[0] === normalizedQuery ? 0 : 1;
        const rightExact = right.handle.split('@')[0] === normalizedQuery ? 0 : 1;
        return leftExact - rightExact || left.handle.localeCompare(right.handle);
    }).slice(0, options.limit);

    // Enrichment is bounded by the result set, not by the size of the swarm.
    const domains = [...new Set(candidates.map((candidate) => candidate.nodeDomain))];
    const enriched = (await Promise.all(domains.map((domain) => {
        const node = activeNodeByDomain.get(domain);
        return fetchSwarmUserDirectory(normalizedQuery, domain, options.limit, {
            knownNode: true,
            nodeIsNsfw: node?.isNsfw,
            timeoutMs: options.timeoutMs ?? 1_500,
        }).catch(() => []);
    }))).flat();
    const enrichedByHandle = new Map(
        enriched.map((user) => [user.handle.toLowerCase(), user]),
    );

    return candidates.map((candidate) => (
        enrichedByHandle.get(candidate.handle.toLowerCase()) ?? candidate
    ));
}
