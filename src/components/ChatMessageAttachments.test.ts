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
  });
});
