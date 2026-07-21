import { and, asc, eq, inArray, isNull, like } from 'drizzle-orm';

import { db, handleRegistry, swarmNodes } from '@/db';
import { liveHandleRegistryEntryWhere } from '@/lib/federation/handles';
import { getSwarmSeedDomainAliases } from '@/lib/swarm/node-domain';
import {
    canonicalAccountHomeDomain,
    parseAccountAddress,
} from '@/lib/identity/account-address';
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
        .where(and(
            like(handleRegistry.handle, `${normalizedQuery}%`),
            liveHandleRegistryEntryWhere(),
        ))
        .orderBy(asc(handleRegistry.handle))
        .limit(Math.min(MAX_DIRECTORY_CANDIDATES, Math.max(options.limit * 4, options.limit)));
    const candidateDomains = [...new Set(
        registryRows.flatMap((row) => {
            const domain = canonicalAccountHomeDomain(row.nodeDomain);
            return domain ? [domain] : [];
        }),
    )];
    if (candidateDomains.length === 0) return [];
    const lookupDomains = [...new Set(
        candidateDomains.flatMap(getSwarmSeedDomainAliases),
    )];

    // Resolve only matching directory domains locally; swarm size never changes this query's fan-out.
    const activeNodes = await db.select({
        domain: swarmNodes.domain,
        isNsfw: swarmNodes.isNsfw,
        nsfwClassificationKnown: swarmNodes.nsfwClassificationKnown,
    })
        .from(swarmNodes)
        .where(and(
            inArray(swarmNodes.domain, lookupDomains),
            eq(swarmNodes.isActive, true),
            eq(swarmNodes.isBlocked, false),
            isNull(swarmNodes.remoteAccessDeniedAt),
        ));

    const localDomain = canonicalAccountHomeDomain(options.localDomain);
    const activeNodeByDomain = new Map(
        activeNodes.flatMap((node) => {
            const domain = canonicalAccountHomeDomain(node.domain);
            return domain ? [[domain, {
                ...node,
                isNsfw: node.isNsfw
                    ? true
                    : node.nsfwClassificationKnown ? false : undefined,
            }] as const] : [];
        }),
    );
    const seen = new Set<string>();
    const candidates = registryRows.flatMap<SwarmDirectoryUser>((row) => {
        const domain = canonicalAccountHomeDomain(row.nodeDomain);
        if (!domain) return [];
        const node = activeNodeByDomain.get(domain);
        const address = parseAccountAddress(row.handle);
        const bareHandle = address?.username || '';
        const canonicalHandle = address?.canonical || '';
        if (
            domain === localDomain
            || !address
            || address.homeDomain !== domain
            || !node
            || options.excludedDomains?.has(domain)
            || seen.has(canonicalHandle)
        ) return [];
        seen.add(canonicalHandle);
        return [{
            handle: canonicalHandle,
            displayName: bareHandle,
            avatarUrl: null,
            isRemote: true,
            nodeDomain: domain,
            nodeIsNsfw: node.isNsfw,
        }];
    }).sort((left, right) => {
        const leftExact = parseAccountAddress(left.handle)?.username === normalizedQuery ? 0 : 1;
        const rightExact = parseAccountAddress(right.handle)?.username === normalizedQuery ? 0 : 1;
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
