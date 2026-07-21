'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { AvatarImage } from './AvatarImage';
import { ProfileBanner } from './ProfileBanner';
import { useRuntimeConfig } from '@/lib/contexts/ConfigContext';
import { canonicalAccountAddress, displayAccountAddress } from '@/lib/identity/account-address';
import { getProfilePath } from '@/lib/utils/handle';
import { StuffboxBadge } from '@/components/StuffboxBadge';
import type { StuffboxBadge as StuffboxBadgeValue } from '@/lib/types';

interface Admin {
    handle: string;
    displayName: string | null;
    avatarUrl: string | null;
    isNsfw: boolean;
    stuffboxBadge?: StuffboxBadgeValue | null;
}

interface NodeInfo {
    domain: string;
    name: string;
    description: string;
    longDescription: string;
    rules: string;
    bannerUrl: string;
    admins: Admin[];
    isNsfw: boolean;
}

interface NetworkStats {
    totalNodes: number;
    totalUsers: number;
    totalMedia: number;
    totalPosts: number;
}

function formatNetworkTotal(value: number | undefined): string {
    return typeof value === 'number' ? value.toLocaleString() : '—';
}

export function RightSidebar() {
    const { config } = useRuntimeConfig();
    const localNodeIsNsfw = config?.isNsfw ?? false;
    const fallbackDescription = process.env.NEXT_PUBLIC_NODE_DESCRIPTION || 'A swarm social network node.';
    const [nodeInfo, setNodeInfo] = useState<NodeInfo>({
        domain: process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost:43821',
        name: process.env.NEXT_PUBLIC_NODE_NAME || 'Synapsis Node',
        description: fallbackDescription,
        longDescription: '',
        rules: '',
        bannerUrl: '',
        admins: [] as Admin[],
        isNsfw: false,
    });
    const [version, setVersion] = useState<{
        version: string;
        commit: string | null;
        commitCount: number | null;
        buildDate: string | null;
    } | null>(null);
    const [networkStats, setNetworkStats] = useState<NetworkStats | null>(null);

    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const loadNodeInfo = () => fetch('/api/node', { cache: 'no-store' })
            .then(res => res.json())
            .then(data => {
                setNodeInfo(prev => ({
                    ...prev,
                    ...data,
                    name: data?.name ?? prev.name,
                    description: data?.description ?? prev.description,
                    longDescription: data?.longDescription ?? prev.longDescription,
                    rules: data?.rules ?? prev.rules,
                    bannerUrl: data?.bannerUrl ?? prev.bannerUrl,
                    admins: data?.admins ?? [],
                }));
            })
            .catch(() => { })
            .finally(() => setLoading(false));

        const handleNodeUpdated = (event: Event) => {
            const updatedNode = (event as CustomEvent<Partial<NodeInfo>>).detail;
            if (!updatedNode) {
                void loadNodeInfo();
                return;
            }
            setNodeInfo(prev => ({
                ...prev,
                ...updatedNode,
                name: updatedNode.name ?? prev.name,
                description: updatedNode.description ?? prev.description,
                longDescription: updatedNode.longDescription ?? prev.longDescription,
                rules: updatedNode.rules ?? prev.rules,
                bannerUrl: updatedNode.bannerUrl ?? prev.bannerUrl,
                admins: updatedNode.admins ?? prev.admins,
            }));
        };

        void loadNodeInfo();
        window.addEventListener('synapsis:node-updated', handleNodeUpdated);

        // Fetch version info
        fetch('/api/version')
            .then(res => res.json())
            .then(data => setVersion(data))
            .catch(() => setVersion({ version: 'unknown', commit: null, commitCount: null, buildDate: null }));

        const loadNetworkStats = () => fetch('/api/swarm/nodes?stats=true&limit=1', { cache: 'no-store' })
            .then(res => res.ok ? res.json() : Promise.reject(new Error('Failed to load network stats')))
            .then(data => setNetworkStats(data?.stats ?? null))
            .catch(() => setNetworkStats(null));

        void loadNetworkStats();
        const networkStatsInterval = window.setInterval(loadNetworkStats, 60_000);

        return () => {
            window.removeEventListener('synapsis:node-updated', handleNodeUpdated);
            window.clearInterval(networkStatsInterval);
        };
    }, []);

    if (loading) {
        return (
            <aside className="aside">
                <div className="card" style={{ overflow: 'hidden', padding: 0, height: '300px' }}>
                    <div style={{
                        height: '140px',
                        background: 'var(--background-tertiary)',
                        borderBottom: '1px solid var(--border)',
                    }} />
                    <div style={{ padding: '16px' }}>
                        <div style={{ height: '24px', width: '60%', background: 'var(--background-tertiary)', borderRadius: '4px', marginBottom: '12px' }} />
                        <div style={{ height: '16px', width: '90%', background: 'var(--background-tertiary)', borderRadius: '4px', marginBottom: '8px' }} />
                        <div style={{ height: '16px', width: '75%', background: 'var(--background-tertiary)', borderRadius: '4px' }} />
                    </div>
                </div>
            </aside>
        );
    }

    return (
        <aside className="aside">
            <div className="card" style={{ overflow: 'hidden', padding: 0 }}>
                {nodeInfo.bannerUrl && (
                    <ProfileBanner
                        url={nodeInfo.bannerUrl}
                        nodeIsNsfw={nodeInfo.isNsfw || localNodeIsNsfw}
                        showBlurredSourceToSignedOutViewers
                        height={140}
                        borderBottom="1px solid var(--border)"
                    />
                )}

                <div style={{ padding: '16px' }}>
                    <h3 style={{ fontWeight: 600, marginBottom: '12px' }}>Welcome to {nodeInfo.name}</h3>
                    <p style={{ color: 'var(--foreground-secondary)', fontSize: '14px', lineHeight: 1.6 }}>
                        {nodeInfo.description}
                    </p>

                    {nodeInfo.longDescription && (
                        <div style={{ marginTop: '16px', fontSize: '13px', color: 'var(--foreground-secondary)', lineHeight: 1.5 }}>
                            {nodeInfo.longDescription.split('\n').map((line, i) => (
                                <p key={i} style={{ marginBottom: '8px' }}>{line}</p>
                            ))}
                        </div>
                    )}

                    {nodeInfo.rules && (
                        <div style={{ marginTop: '16px', paddingTop: '16px', borderTop: '1px solid var(--border-hover)' }}>
                            <h4 style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', color: 'var(--foreground-tertiary)', marginBottom: '8px', letterSpacing: '0.05em' }}>
                                Node Rules
                            </h4>
                            <div style={{ color: 'var(--foreground-secondary)', fontSize: '13px', lineHeight: 1.5 }}>
                                {nodeInfo.rules.split('\n').map((rule, i) => (
                                    <div key={i} style={{ marginBottom: '4px', display: 'flex', gap: '8px' }}>
                                        <span>•</span>
                                        <span>{rule}</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {nodeInfo.admins.length > 0 && (
                        <div style={{ marginTop: '16px', paddingTop: '16px', borderTop: '1px solid var(--border-hover)' }}>
                            <h4 style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', color: 'var(--foreground-tertiary)', marginBottom: '12px', letterSpacing: '0.05em' }}>
                                Admins
                            </h4>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                                {nodeInfo.admins.map((admin) => {
                                    const handle = canonicalAccountAddress(admin.handle, nodeInfo.domain) || admin.handle;
                                    return (
                                    <Link
                                        key={handle}
                                        href={getProfilePath(handle, nodeInfo.domain)}
                                        style={{ display: 'flex', alignItems: 'center', gap: '10px', textDecoration: 'none', color: 'inherit' }}
                                    >
                                        <div className="avatar avatar-sm" style={{ flexShrink: 0 }}>
                                            <AvatarImage avatarUrl={admin.avatarUrl} seed={handle} nodeDomain={nodeInfo.domain} isNsfw={admin.isNsfw} nodeIsNsfw={localNodeIsNsfw} alt={admin.displayName || handle} />
                                        </div>
                                        <div>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 500, fontSize: '14px' }}>
                                                {admin.displayName || admin.handle}
                                                <StuffboxBadge badge={admin.stuffboxBadge} />
                                            </div>
                                            <div style={{ color: 'var(--foreground-tertiary)', fontSize: '12px' }}>
                                                {displayAccountAddress(handle)}
                                            </div>
                                        </div>
                                    </Link>
                                    );
                                })}
                            </div>
                        </div>
                    )}
                </div>
            </div>

            <div className="card" style={{ marginTop: '16px' }}>
                <h3 style={{ fontWeight: 600, marginBottom: '12px' }}>Network Info</h3>
                <p style={{ color: 'var(--foreground-secondary)', fontSize: '13px' }}>
                    Running{' '}
                    <a href="https://synapsis.gnosyslabs.xyz" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>Synapsis</a>
                    {version?.commitCount !== null && version?.commitCount !== undefined
                        ? ` ${version.commitCount}`
                        : version?.version
                            ? ` ${version.version}`
                            : ''}
                </p>

                <div style={{ marginTop: '16px', paddingTop: '16px', borderTop: '1px solid var(--border-hover)', display: 'grid', gap: '9px' }}>
                    {[
                        ['Total nodes', networkStats?.totalNodes],
                        ['Total users', networkStats?.totalUsers],
                        ['Total media', networkStats?.totalMedia],
                        ['Total posts', networkStats?.totalPosts],
                    ].map(([label, value]) => (
                        <div key={label} style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '16px', fontSize: '13px' }}>
                            <span style={{ color: 'var(--foreground-secondary)' }}>{label}</span>
                            <strong style={{ color: 'var(--foreground)', fontVariantNumeric: 'tabular-nums' }}>
                                {formatNetworkTotal(value as number | undefined)}
                            </strong>
                        </div>
                    ))}
                </div>

            </div>
        </aside>
    );
}
