import { describe, expect, it } from 'vitest';
import { getNotificationPostPreview } from './post-preview';

describe('getNotificationPostPreview', () => {
    it('uses the post text when a caption is present', () => {
        expect(getNotificationPostPreview({
            content: 'The post that was liked',
            media: [],
            linkPreviewImage: null,
        })).toMatchObject({
            label: 'The post that was liked',
            imageUrl: null,
        });
    });

    it('identifies and previews a media-only image post', () => {
        expect(getNotificationPostPreview({
            content: '',
            media: [{ url: 'https://media.example/photo.jpg', mimeType: 'image/jpeg', altText: 'Sunset' }],
            linkPreviewImage: null,
        })).toEqual({
            label: 'Photo',
            imageUrl: 'https://media.example/photo.jpg',
            imageAlt: 'Sunset',
        });
    });

    it('labels non-image media and counts additional attachments', () => {
        expect(getNotificationPostPreview({
            content: null,
            media: [
                { url: 'https://media.example/song.mp3', mimeType: 'audio/mpeg', altText: null },
                { url: 'https://media.example/cover.jpg', mimeType: 'image/jpeg', altText: null },
            ],
            linkPreviewImage: null,
        }).label).toBe('Audio + 1 more');
    });

    it('never renders an empty preview', () => {
        expect(getNotificationPostPreview({
            content: '   ',
            media: [],
            linkPreviewImage: null,
        }).label).toBe('View post');
    });
});
