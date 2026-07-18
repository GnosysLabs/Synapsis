import { z } from 'zod';

import { discoverNode } from '@/lib/swarm/discovery';
import { isSwarmNode } from '@/lib/swarm/interactions';
import { getPublicSwarmDomain } from '@/lib/swarm/node-domain';
import { getKnownSwarmNodeNsfw } from '@/lib/swarm/registry';
import { signedFederationRead } from '@/lib/swarm/signed-read';
import { federationMediaUrlSchema } from '@/lib/utils/federation';

const remoteDirectorySchema = z.object({
    users: z.array(z.object({
        handle: z.string().min(1).max(30).regex(/^[a-zA-Z0-9_]+$/),
        displayName: z.string().max(100).nullable(),
        avatarUrl: federationMediaUrlSchema.nullable(),
        isNsfw: z.boolean().optional(),
        nodeIsNsfw: z.boolean().optional(),
    })).max(12),
});

export interface SwarmDirectoryUser {
    handle: string;
    displayName: string | null;
    avatarUrl: string | null;
    isRemote: true;
    nodeDomain: string;
    isNsfw?: boolean;
    nodeIsNsfw?: boolean;
}

export async function fetchSwarmUserDirectory(
    query: string,
    domain: string,
    limit: number,
    options: {
        knownNode?: boolean;
        nodeIsNsfw?: boolean;
        timeoutMs?: number;
    } = {},
): Promise<SwarmDirectoryUser[]> {
    let known = options.knownNode === true || await isSwarmNode(domain);
    if (!known) known = (await discoverNode(domain)).success;
    if (!known) return [];

    const publicDomain = getPublicSwarmDomain(domain);
    const isDevelopmentLoopback = process.env.NODE_ENV === 'development'
        && /^(?:localhost|127\.0\.0\.1)(?::\d{1,5})?$/.test(domain);
    if (!publicDomain && !isDevelopmentLoopback) return [];

    const protocol = isDevelopmentLoopback ? 'http' : 'https';
    const url = new URL('/api/swarm/users', `${protocol}://${publicDomain || domain}`);
    url.searchParams.set('q', query);
    url.searchParams.set('limit', String(limit));
    const response = await signedFederationRead(url.toString(), {
        headers: { Accept: 'application/json' },
        maxResponseBytes: 64 * 1024,
        timeoutMs: options.timeoutMs ?? 4_000,
    });
    if (response.status < 200 || response.status >= 300) return [];

    const parsed = remoteDirectorySchema.safeParse(response.json());
    if (!parsed.success) return [];
    const registryNodeIsNsfw = typeof options.nodeIsNsfw === 'boolean'
        ? options.nodeIsNsfw
        : await getKnownSwarmNodeNsfw(domain);
    return parsed.data.users.map((user) => ({
        ...user,
        handle: `${user.handle.toLowerCase()}@${domain}`,
        isRemote: true,
        nodeDomain: domain,
        nodeIsNsfw: registryNodeIsNsfw === true ? true : user.nodeIsNsfw,
    }));
}
