import { db } from '@/db';

export async function getLocalNode() {
    const domain = process.env.NEXT_PUBLIC_NODE_DOMAIN || process.env.NODE_DOMAIN || 'localhost:43821';
    let node = await db.query.nodes.findFirst({ where: { domain } });

    if (!node) {
        const localNodes = await db.query.nodes.findMany({ limit: 2 });
        if (localNodes.length === 1) node = localNodes[0];
    }

    return node ?? null;
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
