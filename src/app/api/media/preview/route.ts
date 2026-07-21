import { NextRequest, NextResponse } from 'next/server';
import type { LinkPreviewData } from '@/lib/media/linkPreview';
import { fetchRedditRichPreview } from '@/lib/media/redditPreview';
import { fetchGenericLinkPreview } from '@/lib/media/genericPreview';
import { buildVideoLinkPreview } from '@/lib/media/video-embed';
import { isRateLimited } from '@/lib/rate-limit';
import { z } from 'zod';

const previewUrlSchema = z.string().trim().min(1).max(2_048);

function isRedditUrl(url: string): boolean {
    try {
        const parsed = new URL(url);
        const hostname = parsed.hostname.toLowerCase();
        return hostname === 'reddit.com'
            || hostname.endsWith('.reddit.com')
            || hostname === 'redd.it'
            || hostname.endsWith('.redd.it');
    } catch {
        return false;
    }
}

function buildBasicPreview(url: string, title?: string | null, description?: string | null, image?: string | null): LinkPreviewData {
    return {
        url,
        title: title || url,
        description: description || null,
        image: image || null,
        type: image ? 'image' : 'card',
        videoUrl: null,
        media: image ? [{ url: image }] : null,
    };
}

export async function GET(req: NextRequest) {
    try {
        const { searchParams } = new URL(req.url);
        const rawUrl = searchParams.get('url');

        if (!rawUrl) {
            return NextResponse.json({ error: 'No URL provided' }, { status: 400 });
        }

        let url = previewUrlSchema.parse(rawUrl);
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
            url = 'https://' + url;
        }

        const parsedUrl = new URL(url);
        const developmentLoopback = process.env.NODE_ENV === 'development'
            && parsedUrl.protocol === 'http:'
            && ['localhost', '127.0.0.1', '[::1]'].includes(parsedUrl.hostname);
        if (parsedUrl.protocol !== 'https:' && !developmentLoopback) {
            return NextResponse.json({ error: 'Preview URLs must use HTTPS' }, { status: 400 });
        }

        const clientAddress = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
            || req.headers.get('x-real-ip')?.trim()
            || 'unknown';
        if (isRateLimited(`link-preview-client:${clientAddress}`, 60, 60 * 1_000)
            || isRateLimited(`link-preview-target:${parsedUrl.hostname}`, 120, 60 * 1_000)
            || isRateLimited('link-preview-global', 600, 60 * 1_000)) {
            return NextResponse.json({ error: 'Too many preview requests' }, { status: 429 });
        }

        const videoPreview = buildVideoLinkPreview(url);
        if (videoPreview) {
            return NextResponse.json(videoPreview);
        }

        if (isRedditUrl(url)) {
            const preview = await fetchRedditRichPreview(url);
            if (preview) {
                return NextResponse.json(preview);
            }

            return NextResponse.json(buildBasicPreview(url, 'Reddit'));
        }

        const preview = await fetchGenericLinkPreview(url);
        if (!preview) {
            return NextResponse.json({ error: 'Could not reach the URL' }, { status: 404 });
        }

        return NextResponse.json(buildBasicPreview(
            preview.url,
            preview.title?.trim() || url,
            preview.description?.trim() || null,
            preview.image?.trim() || null,
        ));
    } catch (error) {
        if (error instanceof z.ZodError || error instanceof TypeError) {
            return NextResponse.json({ error: 'Invalid preview URL' }, { status: 400 });
        }
        console.error('Link preview error:', error);
        return NextResponse.json({ error: 'Failed to fetch preview' }, { status: 500 });
    }
}
