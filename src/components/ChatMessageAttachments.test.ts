import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ChatMessageAttachments } from './ChatMessageAttachments';

describe('ChatMessageAttachments', () => {
  it('uses explicit controls and preview metadata without autoplay for video attachments', () => {
    const markup = renderToStaticMarkup(
      createElement(ChatMessageAttachments, {
        attachments: [{
          url: 'https://stuffbox.example/video.mp4',
          filename: 'video.mp4',
          mimeType: 'video/mp4',
          size: 1_024,
        }],
      })
    );

    expect(markup).not.toContain('autoPlay=""');
    expect(markup).not.toContain('muted=""');
    expect(markup).not.toContain('loop=""');
    expect(markup).toContain('playsInline=""');
    expect(markup).toContain('controls=""');
    expect(markup).toContain('preload="metadata"');
    expect(markup).toContain('Legacy attachment');
  });

  it('does not expose an encrypted asset URL to a media element before local decryption', () => {
    const markup = renderToStaticMarkup(
      createElement(ChatMessageAttachments, {
        attachments: [{
          url: 'https://stuffbox.example/f/ciphertext',
          filename: 'private.png',
          mimeType: 'image/png',
          size: 1_024,
          encryption: {
            version: 1,
            algorithm: 'xchacha20-poly1305-ietf-chunked',
            key: 'A'.repeat(43),
            noncePrefix: 'B'.repeat(22),
            mediaId: 'C'.repeat(22),
            chunkSize: 1024 * 1024,
            ciphertextSize: 1_040,
          },
        }],
      }),
    );

    expect(markup).toContain('Decrypting on this device');
    expect(markup).not.toContain('href="https://stuffbox.example/f/ciphertext"');
    expect(markup).not.toContain('src="https://stuffbox.example/f/ciphertext"');
  });
});
