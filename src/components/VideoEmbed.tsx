'use client';

import { useState } from 'react';
import { Play } from 'lucide-react';

interface VideoEmbedProps {
    url: string;
}

export interface ParsedVideoEmbed {
    provider: 'YouTube' | 'Vimeo';
    embedUrl: string;
}

export function parseVideoEmbedUrl(value: string): ParsedVideoEmbed | null {
    try {
        const parsed = new URL(value);
        if (parsed.protocol !== 'https:') return null;
        const hostname = parsed.hostname.toLowerCase();

        if (hostname === 'youtu.be'
            || hostname === 'youtube.com'
            || hostname.endsWith('.youtube.com')
            || hostname === 'youtube-nocookie.com'
            || hostname.endsWith('.youtube-nocookie.com')) {
            const pathParts = parsed.pathname.split('/').filter(Boolean);
            const candidate = hostname === 'youtu.be'
                ? pathParts[0]
                : parsed.searchParams.get('v')
                    || (['embed', 'shorts', 'live'].includes(pathParts[0] || '') ? pathParts[1] : null);
            if (candidate && /^[a-zA-Z0-9_-]{11}$/.test(candidate)) {
                return {
                    provider: 'YouTube',
                    embedUrl: `https://www.youtube-nocookie.com/embed/${candidate}`,
                };
            }
        }

        if (hostname === 'vimeo.com'
            || hostname === 'www.vimeo.com'
            || hostname === 'player.vimeo.com') {
            const videoId = parsed.pathname.split('/').filter(Boolean).reverse()
                .find((part) => /^\d{1,20}$/.test(part));
            if (videoId) {
                return {
                    provider: 'Vimeo',
                    embedUrl: `https://player.vimeo.com/video/${videoId}`,
                };
            }
        }
    } catch {
        return null;
    }

    return null;
}

export function VideoEmbed({ url }: VideoEmbedProps) {
    const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
    const embed = parseVideoEmbedUrl(url);
    const loaded = loadedUrl === url;

    if (!embed) return null;

    if (!loaded) {
        return (
            <div className="video-embed-container video-embed-consent" onClick={(event) => event.stopPropagation()}>
                <button
                    type="button"
                    onClick={() => setLoadedUrl(url)}
                    aria-label={`Load ${embed.provider} video`}
                >
                    <Play size={22} fill="currentColor" aria-hidden="true" />
                    <span>Load {embed.provider} video</span>
                    <small>This connects to {embed.provider}.</small>
                </button>
            </div>
        );
    }

    return (
        <div className="video-embed-container" onClick={(event) => event.stopPropagation()}>
            <iframe
                src={embed.embedUrl}
                title={`${embed.provider} video player`}
                frameBorder="0"
                allow="accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture; web-share; fullscreen"
                allowFullScreen
                loading="lazy"
                referrerPolicy="no-referrer"
                sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"
            />
        </div>
    );
}
