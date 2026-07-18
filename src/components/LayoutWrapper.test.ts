import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    showUnlockPrompt: false,
    setShowUnlockPrompt: vi.fn(),
}));

vi.mock('next/navigation', () => ({
    usePathname: () => '/',
}));

vi.mock('@/lib/contexts/AuthContext', () => ({
    useAuth: () => ({
        loading: false,
        user: { id: 'viewer', nsfwEnabled: false, ageVerifiedAt: null },
        activeAccountId: 'viewer',
        showUnlockPrompt: mocks.showUnlockPrompt,
        setShowUnlockPrompt: mocks.setShowUnlockPrompt,
    }),
}));

vi.mock('@/lib/contexts/ConfigContext', () => ({
    useRuntimeConfig: () => ({
        config: { classificationKnown: true, isNsfw: false },
        isLoading: false,
    }),
}));

vi.mock('@/lib/bootstrap/readiness', () => ({
    isAppBootstrapReady: () => true,
}));

vi.mock('./Sidebar', () => ({ Sidebar: () => createElement('div', null, 'Sidebar') }));
vi.mock('./RightSidebar', () => ({ RightSidebar: () => createElement('div', null, 'Right sidebar') }));
vi.mock('./GlobalPostComposer', () => ({ GlobalPostComposer: () => null }));
vi.mock('./BrowserNotificationBridge', () => ({ BrowserNotificationBridge: () => null }));
vi.mock('./IdentityUnlockPrompt', () => ({
    IdentityUnlockPrompt: () => createElement('div', { 'data-testid': 'identity-unlock' }, 'Unlock identity'),
}));

import { LayoutWrapper } from './LayoutWrapper';

describe('LayoutWrapper identity unlock prompt', () => {
    beforeEach(() => {
        mocks.showUnlockPrompt = false;
        mocks.setShowUnlockPrompt.mockReset();
    });

    it('mounts the global prompt when a signed action requests identity unlock', () => {
        mocks.showUnlockPrompt = true;

        const html = renderToStaticMarkup(createElement(
            LayoutWrapper,
            null,
            createElement('div', null, 'Feed'),
        ));

        expect(html).toContain('data-testid="identity-unlock"');
        expect(html).toContain('Unlock identity');
    });

    it('does not mount the prompt when no unlock is requested', () => {
        const html = renderToStaticMarkup(createElement(
            LayoutWrapper,
            null,
            createElement('div', null, 'Feed'),
        ));

        expect(html).not.toContain('data-testid="identity-unlock"');
    });
});
