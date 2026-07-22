'use client';

import { Fragment, useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Sidebar } from './Sidebar';
import { RightSidebar } from './RightSidebar';
import { useAuth } from '@/lib/contexts/AuthContext';
import { useRuntimeConfig } from '@/lib/contexts/ConfigContext';
import { isAppBootstrapReady } from '@/lib/bootstrap/readiness';
import { GlobalPostComposer } from './GlobalPostComposer';
import { BrowserNotificationBridge } from './BrowserNotificationBridge';
import { getIPhoneWebDestination } from '@/lib/platform/ios-web-funnel';

export function LayoutWrapper({ children, isIPhone }: { children: React.ReactNode; isIPhone: boolean }) {
    const { loading, user, activeAccountId } = useAuth();
    const { config, isLoading: configLoading } = useRuntimeConfig();
    const pathname = usePathname();
    const router = useRouter();

    // Paths that should NOT have the app layout
    const isAccountSetup = pathname === '/login' || pathname === '/register';
    const isAppHandoff = pathname === '/continue-in-app';
    const isStandalone = isAccountSetup || isAppHandoff;

    useEffect(() => {
        if (!isIPhone || isAppHandoff || loading) return;
        if (isAccountSetup && !user) return;
        router.replace(getIPhoneWebDestination(Boolean(user)));
    }, [isAccountSetup, isAppHandoff, isIPhone, loading, router, user]);

    // Hide right sidebar on chat page for more space
    const hideRightSidebar = false;
    // Sensitive payloads can exist in client component state after a deliberate
    // per-post reveal. Remount every account-scoped surface whenever identity
    // or sensitive-content permission changes so stale data cannot cross that
    // boundary (including preference changes that do not navigate).
    const viewerStateKey = `${activeAccountId ?? user?.id ?? 'anonymous'}:${user?.nsfwEnabled === true ? 'enabled' : 'disabled'}:${user?.ageVerifiedAt ?? 'unverified'}:${config?.classificationKnown === true ? 'classified' : 'unknown'}:${config?.isNsfw === true ? 'adult' : 'general'}`;

    if (!isAppBootstrapReady({ authLoading: loading, configLoading })) {
        return (
            <div style={{
                height: '100vh',
                width: '100vw',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'var(--background)'
            }}>
                <div style={{
                    width: '24px',
                    height: '24px',
                    borderRadius: '50%',
                    border: '2px solid var(--border)',
                    borderTopColor: 'var(--accent)',
                    animation: 'spin 0.8s linear infinite'
                }} />
                <style jsx>{`
                    @keyframes spin {
                        to { transform: rotate(360deg); }
                    }
                `}</style>
            </div>
        );
    }

    if (isStandalone && !(isIPhone && isAccountSetup && user)) {
        return <>{children}</>;
    }

    // Do not paint a frame of the desktop-style web client while the iPhone
    // gate is navigating. The native app is the product surface on iPhone;
    // the website exists there only for account setup and recovery.
    if (isIPhone) {
        return (
            <div className="app-handoff-loading" role="status" aria-label="Opening iPhone account setup">
                <div className="app-handoff-loading-spinner" />
            </div>
        );
    }

    return (
        <div className="layout" style={{ position: 'relative', minHeight: '100vh' }}>
            <Sidebar />
            <Fragment key={viewerStateKey}>
                <main className="main">
                    {children}
                </main>
                {!hideRightSidebar && <RightSidebar />}
                <GlobalPostComposer />
                <BrowserNotificationBridge />
            </Fragment>
        </div>
    );
}
