'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ArrowUpRight, Download, Smartphone } from 'lucide-react';
import { useAuth } from '@/lib/contexts/AuthContext';
import { getSafeIosPublicUrl } from '@/lib/platform/ios-web-funnel';

type NodeInfo = {
    name: string;
    domain: string;
    logoUrl: string | null;
};

const fallbackNodeName = process.env.NEXT_PUBLIC_NODE_NAME || 'This node';
const fallbackNodeDomain = process.env.NEXT_PUBLIC_NODE_DOMAIN || '';

export function IosAppHandoff() {
    const { user, loading } = useAuth();
    const [nodeInfo, setNodeInfo] = useState<NodeInfo | null>(null);
    const openAppUrl = getSafeIosPublicUrl(process.env.NEXT_PUBLIC_IOS_APP_URL, true);
    const appStoreUrl = getSafeIosPublicUrl(process.env.NEXT_PUBLIC_IOS_APP_STORE_URL);

    useEffect(() => {
        let cancelled = false;
        const localDomain = fallbackNodeDomain || window.location.host;

        fetch('/api/node', { cache: 'no-store' })
            .then((response) => {
                if (!response.ok) throw new Error('Node details unavailable');
                return response.json();
            })
            .then((data) => {
                if (cancelled) return;
                setNodeInfo({
                    name: data.name || fallbackNodeName,
                    domain: data.domain || localDomain,
                    logoUrl: data.logoUrl || null,
                });
            })
            .catch(() => {
                if (cancelled) return;
                setNodeInfo({
                    name: fallbackNodeName,
                    domain: localDomain,
                    logoUrl: null,
                });
            });

        return () => {
            cancelled = true;
        };
    }, []);

    if (loading || !nodeInfo) {
        return (
            <main className="ios-handoff-page app-handoff-loading" role="status" aria-label="Checking your account">
                <div className="app-handoff-loading-spinner" />
            </main>
        );
    }

    const nodeIdentity = nodeInfo.logoUrl ? (
        <Image
            src={nodeInfo.logoUrl}
            alt={`${nodeInfo.name} logo`}
            width={200}
            height={80}
            className="ios-handoff-node-logo"
            priority
            unoptimized
        />
    ) : (
        <div className="ios-handoff-node-name">{nodeInfo.name}</div>
    );

    if (!user) {
        return (
            <main className="ios-handoff-page">
                <section className="ios-handoff-content">
                    {nodeIdentity}
                    <p className="ios-handoff-eyebrow">iPhone account setup</p>
                    <h1>Set up your account first</h1>
                    <p className="ios-handoff-lede">
                        Create your account on {nodeInfo.name}, then continue in the Synapsis app. Existing users sign in directly inside Synapsis.
                    </p>
                    <Link className="btn btn-primary ios-handoff-primary" href="/login?app=ios">
                        Create an account
                    </Link>
                    <p className="ios-handoff-text-link">Already have an account? Sign in inside the app.</p>
                </section>
            </main>
        );
    }

    return (
        <main className="ios-handoff-page">
            <section className="ios-handoff-content">
                {nodeIdentity}
                <p className="ios-handoff-eyebrow">Account ready</p>
                <h1>Continue in Synapsis</h1>
                <p className="ios-handoff-lede">
                    <strong>{user.handle}</strong> is ready.
                </p>

                <div className="ios-handoff-steps" aria-label="Next steps">
                    <div><span>1</span><p>Return to or download the Synapsis app.</p></div>
                    <div><span>2</span><p>Enter <strong>{nodeInfo.domain}</strong> in the Synapsis app and sign in.</p></div>
                </div>

                <div className="ios-handoff-actions">
                    {openAppUrl && (
                        <a className="btn btn-primary ios-handoff-primary" href={openAppUrl}>
                            <Smartphone size={18} /> Open Synapsis
                        </a>
                    )}
                    {appStoreUrl && (
                        <a
                            className={`btn ${openAppUrl ? 'btn-secondary' : 'btn-primary'} ios-handoff-primary`}
                            href={appStoreUrl}
                            target="_blank"
                            rel="noreferrer"
                        >
                            <Download size={18} /> Download on the App Store <ArrowUpRight size={15} />
                        </a>
                    )}
                </div>

                <p className="ios-handoff-boundary">
                    {nodeInfo.name} is best experienced in the Synapsis iOS app or a desktop web browser.
                </p>
            </section>
        </main>
    );
}
