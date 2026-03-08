'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';

interface Admin {
    handle: string;
    displayName: string | null;
    avatarUrl: string | null;
}

export function RightSidebar() {
    const fallbackDescription = process.env.NEXT_PUBLIC_NODE_DESCRIPTION || 'A swarm social network node.';
    const [nodeInfo, setNodeInfo] = useState({
        name: process.env.NEXT_PUBLIC_NODE_NAME || 'Synapsis Node',
        description: fallbackDescription,
        longDescription: '',
        rules: '',
        bannerUrl: '',
        admins: [] as Admin[],
    });
    const [version, setVersion] = useState<{
        version: string;
        commit: string | null;
        buildDate: string | null;
        githubUrl: string | null;
    } | null>(null);

    const [loading, setLoading] = useState(true);

    useEffect(() => {
        fetch('/api/node', { cache: 'no-store' })
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

        // Fetch version info
        fetch('/api/version')
            .then(res => res.json())
            .then(data => setVersion(data))
            .catch(() => setVersion({ version: 'unknown', commit: null, buildDate: null, githubUrl: null }));
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
                    <div
                        style={{
                            height: '140px',
                            background: `url(${nodeInfo.bannerUrl}) center/cover no-repeat`,
                            borderBottom: '1px solid var(--border)',
                        }}
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
                </div>
            </div>

            <div className="card" style={{ marginTop: '16px' }}>
                <h3 style={{ fontWeight: 600, marginBottom: '12px' }}>Network Info</h3>
                <p style={{ color: 'var(--foreground-secondary)', fontSize: '13px' }}>
                    Running{' '}
                    <a href="https://synapsis.social" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>Synapsis</a>
                    {version?.version ? ` ${version.version}` : ''}
                    {version?.githubUrl && version?.commit && (
                        <>
                            {' • '}
                            <a
                                href={version.githubUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                title={version.commit}
                                style={{ color: 'var(--accent)' }}
                            >
                                {version.commit.slice(0, 7)}
                            </a>
                        </>
                    )}
                </p>

                {nodeInfo.admins.length > 0 && (
                    <div style={{ marginTop: '16px', paddingTop: '16px', borderTop: '1px solid var(--border-hover)' }}>
                        <h4 style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', color: 'var(--foreground-tertiary)', marginBottom: '12px', letterSpacing: '0.05em' }}>
                            Admins
                        </h4>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                            {nodeInfo.admins.map((admin) => (
                                <Link
                                    key={admin.handle}
                                    href={`/u/${admin.handle}`}
                                    style={{ display: 'flex', alignItems: 'center', gap: '10px', textDecoration: 'none', color: 'inherit' }}
                                >
                                    <img
                                        src={admin.avatarUrl || `https://api.dicebear.com/7.x/identicon/svg?seed=${admin.handle}`}
                                        alt={admin.displayName || admin.handle}
                                        width={32}
                                        height={32}
                                        style={{ borderRadius: '50%', objectFit: 'cover' }}
                                    />
                                    <div>
                                        <div style={{ fontWeight: 500, fontSize: '14px' }}>
                                            {admin.displayName || admin.handle}
                                        </div>
                                        <div style={{ color: 'var(--foreground-tertiary)', fontSize: '12px' }}>
                                            @{admin.handle}
                                        </div>
                                    </div>
                                </Link>
                            ))}
                        </div>
                    </div>
                )}
            </div>
        </aside>
    );
}
