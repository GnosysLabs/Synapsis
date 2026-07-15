'use client';

import { usePathname } from 'next/navigation';
import { Sidebar } from './Sidebar';
import { RightSidebar } from './RightSidebar';
import { useAuth } from '@/lib/contexts/AuthContext';
import { useRuntimeConfig } from '@/lib/contexts/ConfigContext';
import { isAppBootstrapReady } from '@/lib/bootstrap/readiness';
import { GlobalPostComposer } from './GlobalPostComposer';
import { BrowserNotificationBridge } from './BrowserNotificationBridge';

export function LayoutWrapper({ children }: { children: React.ReactNode }) {
    const { loading } = useAuth();
    const { isLoading: configLoading } = useRuntimeConfig();
    const pathname = usePathname();

    // Paths that should NOT have the app layout
    const isStandalone =
        pathname === '/login' ||
        pathname === '/register';

    // Hide right sidebar on chat page for more space
    const hideRightSidebar = false;

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

    if (isStandalone) {
        return <>{children}</>;
    }

    return (
        <div className="layout" style={{ position: 'relative', minHeight: '100vh' }}>
            <Sidebar />
            <main className="main">
                {children}
            </main>
            {!hideRightSidebar && <RightSidebar />}
            <GlobalPostComposer />
            <BrowserNotificationBridge />

        </div>
    );
}
