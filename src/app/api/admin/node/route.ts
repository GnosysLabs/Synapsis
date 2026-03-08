import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { nodes } from '@/db';
import { eq } from 'drizzle-orm';
import { requireAdmin } from '@/lib/auth/admin';

export async function PATCH(req: NextRequest) {
    try {
        await requireAdmin();
        const data = await req.json();

        const domain = process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost:3000';

        let node = await db.query.nodes.findFirst({
            where: eq(nodes.domain, domain),
        });

        // 2. Fallback: If not found, check if there is exactly ONE node in the system.
        if (!node) {
            const allNodes = await db.query.nodes.findMany({ limit: 2 });
            if (allNodes.length === 1) {
                node = allNodes[0];
            }
        }

        if (!node) {
            [node] = await db.insert(nodes).values({
                domain,
                name: data.name || process.env.NEXT_PUBLIC_NODE_NAME || 'Synapsis Node',
                description: data.description,
                longDescription: data.longDescription,
                rules: data.rules,
                bannerUrl: data.bannerUrl,
                logoUrl: data.logoUrl,
                faviconUrl: data.faviconUrl,
                logoData: data.logoData,
                faviconData: data.faviconData,
                accentColor: data.accentColor,
                isNsfw: data.isNsfw ?? false,
                turnstileSiteKey: data.turnstileSiteKey,
                turnstileSecretKey: data.turnstileSecretKey,
            }).returning();
        } else {
            const updateData: Record<string, unknown> = {
                name: data.name,
                description: data.description,
                longDescription: data.longDescription,
                rules: data.rules,
                bannerUrl: data.bannerUrl,
                logoUrl: data.logoUrl,
                faviconUrl: data.faviconUrl,
                accentColor: data.accentColor,
                isNsfw: data.isNsfw ?? node.isNsfw,
                turnstileSiteKey: data.turnstileSiteKey !== undefined ? data.turnstileSiteKey : node.turnstileSiteKey,
                turnstileSecretKey: data.turnstileSecretKey !== undefined ? data.turnstileSecretKey : node.turnstileSecretKey,
                // Fix domain drift: ensure the DB matches the current environment
                domain: domain,
                updatedAt: new Date(),
            };

            // Only update logoData/faviconData if explicitly provided
            if (data.logoData !== undefined) {
                updateData.logoData = data.logoData;
            }
            if (data.faviconData !== undefined) {
                updateData.faviconData = data.faviconData;
            }
            if (data.logoUrl === '') {
                updateData.logoData = null;
            }
            if (data.faviconUrl === '') {
                updateData.faviconData = null;
            }

            [node] = await db.update(nodes)
                .set(updateData)
                .where(eq(nodes.id, node.id))
                .returning();
        }

        return NextResponse.json({ node });
    } catch (error) {
        console.error('Update node settings error:', error);
        return NextResponse.json({ error: 'Failed to update settings' }, { status: 500 });
    }
}
