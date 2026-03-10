'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Bot } from 'lucide-react';
import { getProfilePath } from '@/lib/utils/handle';

type AdminUser = {
    id: string;
    handle: string;
    displayName?: string | null;
    email?: string | null;
    isSuspended: boolean;
    isSilenced: boolean;
    suspensionReason?: string | null;
    silenceReason?: string | null;
    createdAt: string;
    isBot?: boolean;
};

type AdminPost = {
    id: string;
    content: string;
    createdAt: string;
    isRemoved: boolean;
    removedReason?: string | null;
    author: {
        id: string;
        handle: string;
        displayName?: string | null;
    };
};

type Report = {
    id: string;
    targetType: 'post' | 'user';
    targetId: string;
    reason: string;
    status: 'open' | 'resolved';
    createdAt: string;
    reporter?: {
        id: string;
        handle: string;
    } | null;
    target?: AdminPost | AdminUser | null;
};

type AdminNode = {
    id: string;
    domain: string;
    name?: string | null;
    description?: string | null;
    isActive: boolean;
    isBlocked: boolean;
    blockReason?: string | null;
    blockedAt?: string | null;
    lastSeenAt?: string | null;
    trustScore?: number | null;
    isNsfw?: boolean;
};

const formatDate = (value: string) => {
    const date = new Date(value);
    return date.toLocaleString();
};

export default function ModerationPage() {
    const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
    const [tab, setTab] = useState<'reports' | 'posts' | 'users' | 'nodes'>('reports');
    const [reports, setReports] = useState<Report[]>([]);
    const [posts, setPosts] = useState<AdminPost[]>([]);
    const [users, setUsers] = useState<AdminUser[]>([]);
    const [nodes, setNodes] = useState<AdminNode[]>([]);
    const [loading, setLoading] = useState(false);
    const [reportStatus, setReportStatus] = useState<'open' | 'resolved' | 'all'>('open');
    const [nodeDomain, setNodeDomain] = useState('');
    const [nodeReason, setNodeReason] = useState('');

    useEffect(() => {
        fetch('/api/admin/me')
            .then((res) => res.json())
            .then((data) => setIsAdmin(!!data.isAdmin))
            .catch(() => setIsAdmin(false));
    }, []);

    const loadReports = async () => {
        setLoading(true);
        try {
            const res = await fetch(`/api/admin/reports?status=${reportStatus}`);
            const data = await res.json();
            setReports(data.reports || []);
        } catch {
            setReports([]);
        } finally {
            setLoading(false);
        }
    };

    const loadPosts = async () => {
        setLoading(true);
        try {
            const res = await fetch('/api/admin/posts?status=all');
            const data = await res.json();
            setPosts(data.posts || []);
        } catch {
            setPosts([]);
        } finally {
            setLoading(false);
        }
    };

    const loadUsers = async () => {
        setLoading(true);
        try {
            const res = await fetch('/api/admin/users');
            const data = await res.json();
            setUsers(data.users || []);
        } catch {
            setUsers([]);
        } finally {
            setLoading(false);
        }
    };

    const loadNodes = async () => {
        setLoading(true);
        try {
            const res = await fetch('/api/admin/nodes');
            const data = await res.json();
            setNodes(data.nodes || []);
        } catch {
            setNodes([]);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        if (!isAdmin) return;
        if (tab === 'reports') loadReports();
        if (tab === 'posts') loadPosts();
        if (tab === 'users') loadUsers();
        if (tab === 'nodes') loadNodes();
    }, [tab, isAdmin, reportStatus]);

    const handleReportResolve = async (id: string, status: 'open' | 'resolved') => {
        const note = status === 'resolved' ? window.prompt('Resolution note (optional):') || '' : '';
        await fetch(`/api/admin/reports/${id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status, note }),
        });
        loadReports();
    };

    const handlePostAction = async (id: string, action: 'remove' | 'restore') => {
        const reason = action === 'remove' ? window.prompt('Reason (optional):') || '' : '';
        await fetch(`/api/admin/posts/${id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action, reason }),
        });
        if (tab === 'reports') {
            loadReports();
        } else {
            loadPosts();
        }
    };

    const handleUserAction = async (id: string, action: 'suspend' | 'unsuspend' | 'silence' | 'unsilence') => {
        const needsReason = action === 'suspend' || action === 'silence';
        const reason = needsReason ? window.prompt('Reason (optional):') || '' : '';
        await fetch(`/api/admin/users/${id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action, reason }),
        });
        loadUsers();
    };

    const handleNodeAction = async (action: 'block' | 'unblock', domain: string, reason?: string) => {
        await fetch('/api/admin/nodes', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action, domain, reason }),
        });
        setNodeDomain('');
        setNodeReason('');
        loadNodes();
    };

    const reportCounts = useMemo(() => {
        return {
            open: reports.filter((r) => r.status === 'open').length,
            resolved: reports.filter((r) => r.status === 'resolved').length,
        };
    }, [reports]);

    if (isAdmin === null) {
        return (
            <div style={{ padding: '24px' }}>
                <div className="card" style={{ padding: '24px' }}>Checking permissions...</div>
            </div>
        );
    }

    if (!isAdmin) {
        return (
            <div style={{ padding: '24px' }}>
                <div className="card" style={{ padding: '24px' }}>
                    <h1 style={{ marginBottom: '12px' }}>Moderation</h1>
                    <p>You do not have access to this page.</p>
                    <Link href="/" className="btn btn-primary" style={{ marginTop: '12px' }}>
                        Back to home
                    </Link>
                </div>
            </div>
        );
    }

    return (
        <>
            <header style={{
                padding: '16px',
                borderBottom: '1px solid var(--border)',
                position: 'sticky',
                top: 0,
                background: 'var(--background)',
                zIndex: 10,
                backdropFilter: 'blur(12px)',
            }}>
                <h1 style={{ fontSize: '18px', fontWeight: 600 }}>Moderation</h1>
            </header>

            <div style={{ display: 'flex', gap: '8px', padding: '16px', borderBottom: '1px solid var(--border)' }}>
                <button 
                    className={`btn btn-sm ${tab === 'reports' ? 'btn-primary' : 'btn-ghost'}`}
                    onClick={() => setTab('reports')}
                >
                    Reports
                </button>
                <button 
                    className={`btn btn-sm ${tab === 'posts' ? 'btn-primary' : 'btn-ghost'}`}
                    onClick={() => setTab('posts')}
                >
                    Posts
                </button>
                <button 
                    className={`btn btn-sm ${tab === 'users' ? 'btn-primary' : 'btn-ghost'}`}
                    onClick={() => setTab('users')}
                >
                    Users
                </button>
                <button
                    className={`btn btn-sm ${tab === 'nodes' ? 'btn-primary' : 'btn-ghost'}`}
                    onClick={() => setTab('nodes')}
                >
                    Nodes
                </button>
            </div>

            {tab === 'reports' && (
                <div style={{ padding: '16px' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', flexWrap: 'wrap', gap: '12px' }}>
                            <div style={{ display: 'flex', gap: '8px' }}>
                                {(['open', 'resolved', 'all'] as const).map((status) => (
                                    <button
                                        key={status}
                                        className={`btn btn-sm ${reportStatus === status ? 'btn-primary' : 'btn-ghost'}`}
                                        onClick={() => setReportStatus(status)}
                                    >
                                        {status}
                                    </button>
                                ))}
                            </div>
                            <div style={{ fontSize: '13px', color: 'var(--foreground-secondary)' }}>
                                <span>Open: {reportCounts.open}</span>
                                <span style={{ margin: '0 8px' }}>•</span>
                                <span>Resolved: {reportCounts.resolved}</span>
                            </div>
                        </div>

                        {loading ? (
                            <div style={{ padding: '48px', textAlign: 'center', color: 'var(--foreground-tertiary)' }}>Loading reports...</div>
                        ) : reports.length === 0 ? (
                            <div style={{ padding: '48px', textAlign: 'center', color: 'var(--foreground-tertiary)' }}>No reports found.</div>
                        ) : (
                            <div style={{ display: 'grid', gap: '12px' }}>
                                {reports.map((report) => (
                                    <div key={report.id} className="card" style={{ padding: '16px' }}>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '16px' }}>
                                            <div style={{ flex: 1, minWidth: 0 }}>
                                                <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '8px' }}>
                                                    <span style={{
                                                        fontSize: '11px',
                                                        padding: '2px 8px',
                                                        borderRadius: '4px',
                                                        background: report.status === 'open' ? 'rgba(245, 158, 11, 0.1)' : 'rgba(34, 197, 94, 0.1)',
                                                        color: report.status === 'open' ? 'rgb(245, 158, 11)' : 'rgb(34, 197, 94)',
                                                        fontWeight: 600,
                                                        textTransform: 'uppercase',
                                                    }}>
                                                        {report.status}
                                                    </span>
                                                    <span style={{ fontSize: '12px', color: 'var(--foreground-tertiary)' }}>
                                                        {report.targetType.toUpperCase()} report
                                                    </span>
                                                </div>
                                                <div style={{ marginBottom: '8px' }}>{report.reason}</div>
                                                <div style={{ fontSize: '13px', color: 'var(--foreground-secondary)', marginBottom: '8px' }}>
                                                    Reported by {report.reporter?.handle || 'anonymous'} • {formatDate(report.createdAt)}
                                                </div>
                                                {report.targetType === 'post' && report.target && 'content' in report.target && (
                                                    <div style={{ 
                                                        padding: '12px', 
                                                        background: 'var(--background-secondary)', 
                                                        borderRadius: '8px',
                                                        fontSize: '14px',
                                                        wordBreak: 'break-word',
                                                        overflowWrap: 'break-word',
                                                    }}>
                                                        <strong>@{report.target.author.handle}:</strong> {report.target.content || '[repost]'}
                                                    </div>
                                                )}
                                                {report.targetType === 'user' && report.target && 'handle' in report.target && (
                                                    <div style={{ 
                                                        padding: '12px', 
                                                        background: 'var(--background-secondary)', 
                                                        borderRadius: '8px',
                                                        fontSize: '14px',
                                                    }}>
                                                        User: @{report.target.handle}
                                                    </div>
                                                )}
                                            </div>
                                            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                                                {report.targetType === 'post' && report.target && 'content' in report.target && (
                                                    <button
                                                        className="btn btn-ghost btn-sm"
                                                        onClick={() => {
                                                            const target = report.target as AdminPost;
                                                            handlePostAction(target.id, target.isRemoved ? 'restore' : 'remove');
                                                        }}
                                                    >
                                                        {(report.target as AdminPost).isRemoved ? 'Restore post' : 'Remove post'}
                                                    </button>
                                                )}
                                                {report.status === 'open' ? (
                                                    <button className="btn btn-primary btn-sm" onClick={() => handleReportResolve(report.id, 'resolved')}>
                                                        Resolve
                                                    </button>
                                                ) : (
                                                    <button className="btn btn-ghost btn-sm" onClick={() => handleReportResolve(report.id, 'open')}>
                                                        Reopen
                                                    </button>
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                )}

                {tab === 'posts' && (
                    <div style={{ padding: '16px' }}>
                        {loading ? (
                            <div style={{ padding: '48px', textAlign: 'center', color: 'var(--foreground-tertiary)' }}>Loading posts...</div>
                        ) : posts.length === 0 ? (
                            <div style={{ padding: '48px', textAlign: 'center', color: 'var(--foreground-tertiary)' }}>No posts found.</div>
                        ) : (
                            <div style={{ display: 'grid', gap: '12px' }}>
                                {posts.map((post) => (
                                    <div key={post.id} className="card" style={{ padding: '16px' }}>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '16px' }}>
                                            <div style={{ flex: 1, minWidth: 0 }}>
                                                <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '8px' }}>
                                                    <span style={{
                                                        fontSize: '11px',
                                                        padding: '2px 8px',
                                                        borderRadius: '4px',
                                                        background: post.isRemoved ? 'rgba(239, 68, 68, 0.1)' : 'rgba(34, 197, 94, 0.1)',
                                                        color: post.isRemoved ? 'rgb(239, 68, 68)' : 'rgb(34, 197, 94)',
                                                        fontWeight: 600,
                                                        textTransform: 'uppercase',
                                                    }}>
                                                        {post.isRemoved ? 'removed' : 'active'}
                                                    </span>
                                                    <span style={{ fontSize: '13px', color: 'var(--foreground-secondary)' }}>
                                                        @{post.author.handle} • {formatDate(post.createdAt)}
                                                    </span>
                                                </div>
                                                <div style={{ marginBottom: '8px', wordBreak: 'break-word', overflowWrap: 'break-word' }}>{post.content || '[repost]'}</div>
                                                {post.removedReason && (
                                                    <div style={{ fontSize: '13px', color: 'var(--foreground-secondary)' }}>
                                                        Reason: {post.removedReason}
                                                    </div>
                                                )}
                                            </div>
                                            <div>
                                                {post.isRemoved ? (
                                                    <button className="btn btn-ghost btn-sm" onClick={() => handlePostAction(post.id, 'restore')}>
                                                        Restore
                                                    </button>
                                                ) : (
                                                    <button className="btn btn-primary btn-sm" onClick={() => handlePostAction(post.id, 'remove')}>
                                                        Remove
                                                    </button>
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                )}

                {tab === 'users' && (
                    <div style={{ padding: '16px' }}>
                        {loading ? (
                            <div style={{ padding: '48px', textAlign: 'center', color: 'var(--foreground-tertiary)' }}>Loading users...</div>
                        ) : users.length === 0 ? (
                            <div style={{ padding: '48px', textAlign: 'center', color: 'var(--foreground-tertiary)' }}>No users found.</div>
                        ) : (
                            <div style={{ display: 'grid', gap: '12px' }}>
                                {users.map((user) => (
                                    <div key={user.id} className="card" style={{ padding: '16px' }}>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '16px', alignItems: 'flex-start' }}>
                                            <div style={{ flex: 1, minWidth: 0 }}>
                                                <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '8px', flexWrap: 'wrap' }}>
                                                    <span style={{
                                                        fontSize: '11px',
                                                        padding: '2px 8px',
                                                        borderRadius: '4px',
                                                        background: user.isSuspended ? 'rgba(239, 68, 68, 0.1)' : 'rgba(34, 197, 94, 0.1)',
                                                        color: user.isSuspended ? 'rgb(239, 68, 68)' : 'rgb(34, 197, 94)',
                                                        fontWeight: 600,
                                                        textTransform: 'uppercase',
                                                    }}>
                                                        {user.isSuspended ? 'suspended' : 'active'}
                                                    </span>
                                                    {user.isSilenced && (
                                                        <span style={{
                                                            fontSize: '11px',
                                                            padding: '2px 8px',
                                                            borderRadius: '4px',
                                                            background: 'rgba(245, 158, 11, 0.1)',
                                                            color: 'rgb(245, 158, 11)',
                                                            fontWeight: 600,
                                                            textTransform: 'uppercase',
                                                        }}>
                                                            silenced
                                                        </span>
                                                    )}
                                                    <span style={{ fontSize: '13px', color: 'var(--foreground-secondary)' }}>
                                                        @{user.handle} • {formatDate(user.createdAt)}
                                                    </span>
                                                </div>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '8px' }}>
                                                    <span style={{ fontWeight: 500 }}>{user.displayName || user.handle}</span>
                                                    {user.isBot && (
                                                        <span style={{ 
                                                            display: 'inline-flex',
                                                            alignItems: 'center',
                                                            gap: '3px',
                                                            fontSize: '10px', 
                                                            padding: '2px 6px', 
                                                            borderRadius: '4px', 
                                                            background: 'var(--accent-muted)', 
                                                            color: 'var(--accent)',
                                                            fontWeight: 500,
                                                        }}>
                                                            <Bot size={12} />
                                                            AI Account
                                                        </span>
                                                    )}
                                                </div>
                                                {user.suspensionReason && (
                                                    <div style={{ fontSize: '13px', color: 'var(--foreground-secondary)', marginBottom: '4px' }}>
                                                        Suspension: {user.suspensionReason}
                                                    </div>
                                                )}
                                                {user.silenceReason && (
                                                    <div style={{ fontSize: '13px', color: 'var(--foreground-secondary)' }}>
                                                        Silence: {user.silenceReason}
                                                    </div>
                                                )}
                                            </div>
                                            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                                                <Link href={getProfilePath(user.handle)} className="btn btn-ghost btn-sm">
                                                    View
                                                </Link>
                                                {user.isSuspended ? (
                                                    <button className="btn btn-ghost btn-sm" onClick={() => handleUserAction(user.id, 'unsuspend')}>
                                                        Unsuspend
                                                    </button>
                                                ) : (
                                                    <button className="btn btn-primary btn-sm" onClick={() => handleUserAction(user.id, 'suspend')}>
                                                        Suspend
                                                    </button>
                                                )}
                                                {user.isSilenced ? (
                                                    <button className="btn btn-ghost btn-sm" onClick={() => handleUserAction(user.id, 'unsilence')}>
                                                        Unsilence
                                                    </button>
                                                ) : (
                                                    <button className="btn btn-ghost btn-sm" onClick={() => handleUserAction(user.id, 'silence')}>
                                                        Silence
                                                    </button>
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                )}
                {tab === 'nodes' && (
                    <div style={{ padding: '16px' }}>
                        <div className="card" style={{ padding: '16px', marginBottom: '16px' }}>
                            <h2 style={{ fontSize: '16px', fontWeight: 600, marginBottom: '8px' }}>Block node</h2>
                            <p style={{ color: 'var(--foreground-secondary)', marginBottom: '12px' }}>
                                Blocked nodes cannot deliver swarm interactions, appear in swarm feeds, or exchange chat with this node.
                            </p>
                            <div style={{ display: 'grid', gap: '12px' }}>
                                <input
                                    value={nodeDomain}
                                    onChange={(e) => setNodeDomain(e.target.value)}
                                    placeholder="node.example.com"
                                    className="input"
                                />
                                <textarea
                                    value={nodeReason}
                                    onChange={(e) => setNodeReason(e.target.value)}
                                    placeholder="Reason for blocking this node (optional)"
                                    className="input"
                                    style={{ minHeight: '88px', resize: 'vertical' }}
                                />
                                <div>
                                    <button
                                        className="btn btn-primary btn-sm"
                                        onClick={() => handleNodeAction('block', nodeDomain, nodeReason)}
                                        disabled={!nodeDomain.trim()}
                                    >
                                        Block node
                                    </button>
                                </div>
                            </div>
                        </div>

                        {loading ? (
                            <div style={{ padding: '48px', textAlign: 'center', color: 'var(--foreground-tertiary)' }}>Loading nodes...</div>
                        ) : nodes.length === 0 ? (
                            <div style={{ padding: '48px', textAlign: 'center', color: 'var(--foreground-tertiary)' }}>No known nodes.</div>
                        ) : (
                            <div style={{ display: 'grid', gap: '12px' }}>
                                {nodes.map((node) => (
                                    <div key={node.id} className="card" style={{ padding: '16px' }}>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '16px', alignItems: 'flex-start' }}>
                                            <div style={{ flex: 1, minWidth: 0 }}>
                                                <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '8px', flexWrap: 'wrap' }}>
                                                    <span style={{
                                                        fontSize: '11px',
                                                        padding: '2px 8px',
                                                        borderRadius: '4px',
                                                        background: node.isBlocked ? 'rgba(239, 68, 68, 0.1)' : 'rgba(34, 197, 94, 0.1)',
                                                        color: node.isBlocked ? 'rgb(239, 68, 68)' : 'rgb(34, 197, 94)',
                                                        fontWeight: 600,
                                                        textTransform: 'uppercase',
                                                    }}>
                                                        {node.isBlocked ? 'blocked' : 'allowed'}
                                                    </span>
                                                    {!node.isBlocked && !node.isActive && (
                                                        <span style={{ fontSize: '11px', color: 'var(--foreground-tertiary)' }}>
                                                            inactive
                                                        </span>
                                                    )}
                                                    {node.isNsfw && (
                                                        <span style={{ fontSize: '11px', color: 'rgb(245, 158, 11)' }}>
                                                            NSFW
                                                        </span>
                                                    )}
                                                </div>
                                                <div style={{ fontWeight: 600, marginBottom: '4px' }}>
                                                    {node.name || node.domain}
                                                </div>
                                                <div style={{ color: 'var(--foreground-secondary)', marginBottom: '8px' }}>
                                                    {node.domain}
                                                </div>
                                                {node.description && (
                                                    <div style={{ fontSize: '14px', color: 'var(--foreground-secondary)', marginBottom: '8px' }}>
                                                        {node.description}
                                                    </div>
                                                )}
                                                <div style={{ fontSize: '13px', color: 'var(--foreground-tertiary)' }}>
                                                    {node.blockedAt ? `Blocked ${formatDate(node.blockedAt)}` : node.lastSeenAt ? `Last seen ${formatDate(node.lastSeenAt)}` : 'Never seen'}
                                                    {typeof node.trustScore === 'number' && <span> • Trust {node.trustScore}</span>}
                                                </div>
                                                {node.blockReason && (
                                                    <div style={{ fontSize: '13px', color: 'var(--foreground-secondary)', marginTop: '6px' }}>
                                                        Reason: {node.blockReason}
                                                    </div>
                                                )}
                                            </div>
                                            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                                                {node.isBlocked ? (
                                                    <button className="btn btn-ghost btn-sm" onClick={() => handleNodeAction('unblock', node.domain)}>
                                                        Unblock
                                                    </button>
                                                ) : (
                                                    <button
                                                        className="btn btn-primary btn-sm"
                                                        onClick={() => handleNodeAction('block', node.domain, window.prompt('Reason (optional):') || '')}
                                                    >
                                                        Block
                                                    </button>
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                )}
        </>
    );
}
