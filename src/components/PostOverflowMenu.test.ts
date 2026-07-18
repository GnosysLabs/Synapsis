import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { PostOverflowMenu } from './PostOverflowMenu';

function renderMenu(showMuteNode = false, reporting = false) {
    return renderToStaticMarkup(createElement(PostOverflowMenu, {
        onMuteUser: vi.fn(),
        onBlockUser: vi.fn(),
        onMuteNode: vi.fn(),
        onReport: vi.fn(),
        showMuteNode,
        reporting,
    }));
}

describe('PostOverflowMenu', () => {
    it('offers post reporting from the three-dot menu', () => {
        const html = renderMenu();

        expect(html).toContain('role="menu"');
        expect(html).toContain('Report post');
        expect(html).not.toContain('Mute node');
    });

    it('disables the report item while a report is being submitted', () => {
        const html = renderMenu(true, true);

        expect(html).toContain('Mute node');
        expect(html).toContain('Reporting…');
        expect(html).toContain('disabled=""');
    });
});
