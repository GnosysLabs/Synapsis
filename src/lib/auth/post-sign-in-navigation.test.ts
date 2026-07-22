import { describe, expect, it, vi } from 'vitest';
import { completePostSignInNavigation } from './post-sign-in-navigation';

describe('post-sign-in navigation', () => {
    it('uses app navigation so the unlocked signing key remains in memory', () => {
        const router = { replace: vi.fn() };

        completePostSignInNavigation(router);

        expect(router.replace).toHaveBeenCalledWith('/');
    });

    it('lets an auth modal close without forcing a page reload', () => {
        const router = { replace: vi.fn() };
        const onSuccess = vi.fn();

        completePostSignInNavigation(router, onSuccess);

        expect(onSuccess).toHaveBeenCalledOnce();
        expect(router.replace).not.toHaveBeenCalled();
    });

    it('can finish an iPhone account flow at the native-app handoff', () => {
        const router = { replace: vi.fn() };

        completePostSignInNavigation(router, undefined, '/continue-in-app');

        expect(router.replace).toHaveBeenCalledWith('/continue-in-app');
    });
});
