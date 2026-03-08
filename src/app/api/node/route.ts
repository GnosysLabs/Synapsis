import { NextResponse } from 'next/server';
import { db } from '@/db';
import { nodes, users } from '@/db';
import { eq, inArray } from 'drizzle-orm';
import { getNodePublicKey } from '@/lib/swarm/node-keys';
import { getVersionedNodeAssetUrl } from '@/lib/node/assets';

export async function GET() {
    try {
        if (!db) return NextResponse.json({});

        const domain = process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost:3000';

        // 1. Try exact match
        let node = await db.query.nodes.findFirst({
            where: eq(nodes.domain, domain),
        });

        // 2. Fallback: If not found, check if there is exactly ONE node in the system.
        // This handles upgrades where the env var domain might differ from the DB domain (e.g. localhost vs production).
        if (!node) {
            const allNodes = await db.query.nodes.findMany({ limit: 2 });
            if (allNodes.length === 1) {
                node = allNodes[0];
            }
        }

        // Ensure we have a public key
        const publicKey = await getNodePublicKey();

        // Fetch admin users based on ADMIN_EMAILS env var
        const adminEmails = (process.env.ADMIN_EMAILS || '')
            .split(',')
            .map(e => e.trim().toLowerCase())
            .filter(Boolean);

        let admins: { handle: string; displayName: string | null; avatarUrl: string | null }[] = [];
        if (adminEmails.length > 0) {
            const adminUsers = await db
                .select({
                    handle: users.handle,
                    displayName: users.displayName,
                    avatarUrl: users.avatarUrl,
                })
                .from(users)
                .where(inArray(users.email, adminEmails));
            admins = adminUsers;
        }

        if (!node) {
            return NextResponse.json({
                name: process.env.NEXT_PUBLIC_NODE_NAME || 'Synapsis Node',
                description: process.env.NEXT_PUBLIC_NODE_DESCRIPTION || 'A swarm social network node.',
                accentColor: process.env.NEXT_PUBLIC_ACCENT_COLOR || '#FFFFFF',
                domain,
                publicKey,
                admins,
                turnstileSiteKey: null,
            });
        }

        const logoUrl = node.logoData
            ? getVersionedNodeAssetUrl('/api/node/logo', node.updatedAt)
            : node.logoUrl;
        const faviconUrl = node.faviconData
            ? getVersionedNodeAssetUrl('/api/node/favicon', node.updatedAt)
            : node.faviconUrl;

        return NextResponse.json({
            ...node,
            logoUrl,
            faviconUrl,
            publicKey, // Always include the public key
            admins,
            // Don't expose the secret keys
            turnstileSecretKey: undefined,
            privateKeyEncrypted: undefined,
        });
    } catch (error) {
        console.error('Node info error:', error);
        return NextResponse.json({
            name: process.env.NEXT_PUBLIC_NODE_NAME || 'Synapsis Node',
            description: process.env.NEXT_PUBLIC_NODE_DESCRIPTION || 'A swarm social network node.',
            admins: [],
        });
    }
}
