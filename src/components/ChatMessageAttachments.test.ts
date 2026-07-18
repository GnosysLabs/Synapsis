import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ChatMessageAttachments } from './ChatMessageAttachments';

describe('ChatMessageAttachments', () => {
  it('loads video metadata so the browser can render a preview frame', () => {
    const markup = renderToStaticMarkup(createElement(ChatMessageAttachments, {
      attachments: [{
        url: 'https://stuffbox.xyz/video.mp4',
        filename: 'video.mp4',
        mimeType: 'video/mp4',
        size: 1_024,
      }],
    }));

    expect(markup).toContain('preload="metadata"');
    expect(markup).not.toContain('preload="none"');
  });
});
