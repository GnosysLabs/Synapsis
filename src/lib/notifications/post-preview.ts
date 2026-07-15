interface NotificationPostMedia {
    url: string;
    mimeType: string | null;
    altText: string | null;
}

interface NotificationPostPreviewInput {
    content: string | null;
    media: NotificationPostMedia[];
    linkPreviewImage: string | null;
}

export interface NotificationPostPreview {
    label: string;
    imageUrl: string | null;
    imageAlt: string;
}

function mediaTypeLabel(mimeType: string | null): string {
    if (mimeType?.startsWith('image/')) return 'Photo';
    if (mimeType?.startsWith('video/')) return 'Video';
    if (mimeType?.startsWith('audio/')) return 'Audio';
    return 'Media';
}

export function getNotificationPostPreview(
    post: NotificationPostPreviewInput,
): NotificationPostPreview {
    const content = post.content?.trim();
    const firstMedia = post.media[0];
    const mediaLabel = firstMedia ? mediaTypeLabel(firstMedia.mimeType) : null;
    const extraMediaCount = Math.max(0, post.media.length - 1);
    const attachmentSuffix = extraMediaCount > 0 ? ` + ${extraMediaCount} more` : '';

    return {
        label: content || (mediaLabel ? `${mediaLabel}${attachmentSuffix}` : 'View post'),
        imageUrl: firstMedia?.mimeType?.startsWith('image/')
            ? firstMedia.url
            : post.linkPreviewImage,
        imageAlt: firstMedia?.altText || (mediaLabel ? `${mediaLabel} preview` : 'Post preview'),
    };
}
