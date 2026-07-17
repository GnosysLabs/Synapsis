import { NextResponse } from 'next/server';
import { db } from '@/db';
import { users } from '@/db';
import { inArray } from 'drizzle-orm';
import { getNodePublicKey } from '@/lib/swarm/node-keys';
import { getVersionedNodeAssetUrl } from '@/lib/node/assets';
import { getSensitiveContentViewerAccess } from '@/lib/nsfw/viewer-access';
import { redactSensitiveUserSummary } from '@/lib/nsfw/content-visibility';

export async function GET() {
    try {
        if (!db) return NextResponse.json({});

        const domain = process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost:43821';
        const { localNodeIsNsfw, canViewSensitive } = await getSensitiveContentViewerAccess();

        // 1. Try exact match
        let node = await db.query.nodes.findFirst({
            where: { domain: domain },
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

        let admins: { handle: string; displayName: string | null; avatarUrl: string | null; isNsfw: boolean }[] = [];
        if (adminEmails.length > 0) {
            const adminUsers = await db
                .select({
                    handle: users.handle,
                    displayName: users.displayName,
                    avatarUrl: users.avatarUrl,
                    isNsfw: users.isNsfw,
                })
                .from(users)
                .where(inArray(users.email, adminEmails));
            admins = adminUsers.map((admin) => redactSensitiveUserSummary({
                ...admin,
                isRemote: false,
                nodeIsNsfw: localNodeIsNsfw,
            }, canViewSensitive));
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
                isNsfw: localNodeIsNsfw,
            });
        }

        const logoUrl = node.logoData
            ? getVersionedNodeAssetUrl('/api/node/logo', node.updatedAt)
            : node.logoUrl;
        const faviconUrl = node.faviconData
            ? getVersionedNodeAssetUrl('/api/node/favicon', node.updatedAt)
            : node.faviconUrl;

        const hideSensitiveBranding = node.isNsfw && !canViewSensitive;

        // Keep this response as an explicit public DTO. Spreading the database row here
        // would expose raw image data and any future private columns by default.
        return NextResponse.json({
            domain: node.domain,
            name: node.name,
            description: node.description,
            longDescription: node.longDescription,
            rules: node.rules,
            bannerUrl: hideSensitiveBranding ? null : node.bannerUrl,
            logoUrl: hideSensitiveBranding ? null : logoUrl,
            faviconUrl: hideSensitiveBranding ? null : faviconUrl,
            accentColor: node.accentColor,
            publicKey,
            isNsfw: node.isNsfw,
            turnstileSiteKey: node.turnstileSiteKey,
            createdAt: node.createdAt,
            updatedAt: node.updatedAt,
            admins,
        });
    } catch (error) {
        console.error('Node info error:', error);
        return NextResponse.json({
            name: 'Synapsis Node',
            description: null,
            bannerUrl: null,
            logoUrl: null,
            faviconUrl: null,
            isNsfw: true,
            classificationKnown: false,
            admins: [],
        }, { status: 503 });
    }
}
