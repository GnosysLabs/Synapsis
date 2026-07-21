import { NextResponse } from 'next/server';
import { db } from '@/db';
import { users } from '@/db';
import { inArray } from 'drizzle-orm';
import { getNodePublicKey } from '@/lib/swarm/node-keys';
import { getVersionedNodeAssetUrl } from '@/lib/node/assets';
import { getSensitiveContentViewerAccess } from '@/lib/nsfw/viewer-access';
import { redactSensitiveUserSummary } from '@/lib/nsfw/content-visibility';
import { requireCanonicalAccountHomeDomain } from '@/lib/identity/account-address';
import { stuffboxBadgeFromStoredUser } from '@/lib/stuffbox/badge';
import type { StuffboxBadge } from '@/lib/types';

export async function GET() {
    try {
        if (!db) return NextResponse.json({});

        const domain = requireCanonicalAccountHomeDomain(
            process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost:43821',
        );
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

        let admins: { handle: string; displayName: string | null; avatarUrl: string | null; isNsfw: boolean; stuffboxBadge?: StuffboxBadge | null }[] = [];
        if (adminEmails.length > 0) {
            const adminUsers = await db
                .select({
                    handle: users.handle,
                    displayName: users.displayName,
                    avatarUrl: users.avatarUrl,
                    isNsfw: users.isNsfw,
                    stuffboxBadgeProof: users.stuffboxBadgeProof,
                    stuffboxBadgeLevel: users.stuffboxBadgeLevel,
                    stuffboxBadgePlan: users.stuffboxBadgePlan,
                    stuffboxBadgeIssuer: users.stuffboxBadgeIssuer,
                    stuffboxBadgeExpiresAt: users.stuffboxBadgeExpiresAt,
                })
                .from(users)
                .where(inArray(users.email, adminEmails));
            admins = adminUsers.map((admin) => redactSensitiveUserSummary({
                ...admin,
                isRemote: false,
                nodeIsNsfw: localNodeIsNsfw,
                stuffboxBadge: stuffboxBadgeFromStoredUser(admin),
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

        // Keep this response as an explicit public DTO. Spreading the database row here
        // would expose raw image data and any future private columns by default.
        return NextResponse.json({
            domain: node.domain,
            name: node.name,
            description: node.description,
            longDescription: node.longDescription,
            rules: node.rules,
            // The node-owned banner remains public so signed-out clients can render
            // the deliberately blurred NSFW-node preview. User profile media still
            // follows the stricter sensitive-content redaction path.
            bannerUrl: node.bannerUrl,
            logoUrl,
            faviconUrl,
            accentColor: node.accentColor,
            publicKey,
            isNsfw: node.isNsfw,
            // A partial configuration is not usable and must not make clients
            // load a widget that the server cannot validate.
            turnstileSiteKey: node.turnstileSiteKey && node.turnstileSecretKey
                ? node.turnstileSiteKey
                : null,
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
