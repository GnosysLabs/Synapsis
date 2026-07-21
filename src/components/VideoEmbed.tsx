'use client';

import { parseVideoEmbedUrl } from '@/lib/media/video-embed';

export { parseVideoEmbedUrl } from '@/lib/media/video-embed';

interface VideoEmbedProps {
    url: string;
}

export function VideoEmbed({ url }: VideoEmbedProps) {
    const embed = parseVideoEmbedUrl(url);

    if (!embed) return null;

    return (
        <div className="video-embed-container" onClick={(event) => event.stopPropagation()}>
            <iframe
                src={embed.embedUrl}
                title={`${embed.provider} video player`}
                frameBorder="0"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share; fullscreen"
                allowFullScreen
                loading="lazy"
                referrerPolicy="strict-origin-when-cross-origin"
            />
        </div>
    );
}
