import { db, nodes } from '@/db';
import { requireCanonicalAccountHomeDomain } from '@/lib/identity/account-address';

function getConfiguredLocalDomain(): string {
    return requireCanonicalAccountHomeDomain(
        process.env.NEXT_PUBLIC_NODE_DOMAIN || process.env.NODE_DOMAIN || 'localhost:43821',
    );
}

export async function getLocalNode() {
    const domain = getConfiguredLocalDomain();
    let node = await db.query.nodes.findFirst({ where: { domain } });

    if (!node) {
        const localNodes = await db.query.nodes.findMany({ limit: 2 });
        if (localNodes.length === 1) node = localNodes[0];
    }

    return node ?? null;
}

/**
 * Create the general-audience local node record during installation/startup.
 * Runtime authorization still uses getLocalNode() and fails closed when a
 * previously initialized node disappears.
 */
export async function ensureLocalNodeRecord() {
    const existing = await getLocalNode();
    if (existing) return existing;

    const domain = getConfiguredLocalDomain();
    await db.insert(nodes).values({
        domain,
        name: process.env.NEXT_PUBLIC_NODE_NAME || 'Synapsis Node',
        description: process.env.NEXT_PUBLIC_NODE_DESCRIPTION || 'A swarm social network node',
        isNsfw: false,
    }).onConflictDoNothing({ target: nodes.domain });

    const initialized = await getLocalNode();
    if (!initialized) {
        throw new Error('Local node initialization did not produce a readable node record');
    }
    return initialized;
}

export async function isLocalNodeNsfw(): Promise<boolean> {
    try {
        const node = await getLocalNode();
        return node?.isNsfw === true;
    } catch (error) {
        console.error('Local node NSFW lookup failed:', error);
        return false;
    }
}

/**
 * Authorization decisions must not silently classify an unknown node as safe.
 * Unlike the best-effort display helper above, this throws when the node cannot
 * be resolved so callers can deny the request.
 */
export async function requireLocalNodeNsfwClassification(): Promise<boolean> {
    const node = await getLocalNode();
    if (!node) {
        throw new Error('Local node NSFW classification is unavailable');
    }
    return node.isNsfw === true;
}
