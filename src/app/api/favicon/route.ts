import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { getSensitiveContentViewerAccess } from '@/lib/nsfw/viewer-access';

function getRequestBaseUrl(req: NextRequest, fallbackDomain: string): string {
    const forwardedHost = req.headers.get('x-forwarded-host');
    const forwardedProto = req.headers.get('x-forwarded-proto');
    const host = forwardedHost?.split(',')[0]?.trim() || req.headers.get('host');
    const protocol =
        forwardedProto?.split(',')[0]?.trim() ||
        (host && host.includes('localhost') ? 'http' : 'https');

    if (host) {
        return `${protocol}://${host}`;
    }

    return `https://${fallbackDomain}`;
}

export async function GET(req: NextRequest) {
    try {
        if (!db) {
            // Redirect to default favicon
            const domain = process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost:43821';
            const baseUrl = getRequestBaseUrl(req, domain);
            return NextResponse.redirect(new URL('/favicon.png', baseUrl));
        }

        const domain = process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost:43821';
        const node = await db.query.nodes.findFirst({
            where: { domain: domain },
            columns: { faviconUrl: true, isNsfw: true },
        });

        const { canViewSensitive } = await getSensitiveContentViewerAccess();
        if (node?.faviconUrl && (!node.isNsfw || canViewSensitive)) {
            // Redirect to custom favicon
            const baseUrl = getRequestBaseUrl(req, domain);
            const target = node.faviconUrl.startsWith('/')
                ? new URL(node.faviconUrl, baseUrl)
                : node.faviconUrl;
            return NextResponse.redirect(target);
        }

        // Redirect to default favicon
        const baseUrl = getRequestBaseUrl(req, domain);
        return NextResponse.redirect(new URL('/favicon.png', baseUrl));
    } catch (error) {
        console.error('Favicon error:', error);
        const domain = process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost:43821';
        const baseUrl = getRequestBaseUrl(req, domain);
        return NextResponse.redirect(new URL('/favicon.png', baseUrl));
    }
}
