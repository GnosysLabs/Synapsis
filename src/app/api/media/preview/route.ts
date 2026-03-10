import { NextRequest, NextResponse } from 'next/server';
import type { LinkPreviewData } from '@/lib/media/linkPreview';
import { fetchRedditRichPreview } from '@/lib/media/redditPreview';
import { fetchGenericLinkPreview } from '@/lib/media/genericPreview';

function isRedditUrl(url: string): boolean {
    try {
        const parsed = new URL(url);
        return parsed.hostname.endsWith('reddit.com') || parsed.hostname === 'redd.it';
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
        let url = searchParams.get('url');

        if (!url) {
            return NextResponse.json({ error: 'No URL provided' }, { status: 400 });
        }

        if (!url.startsWith('http://') && !url.startsWith('https://')) {
            url = 'https://' + url;
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
        console.error('Link preview error:', error);
        return NextResponse.json({ error: 'Failed to fetch preview' }, { status: 500 });
    }
}
