'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { getProfilePath } from '@/lib/utils/handle';
import { ArrowLeftIcon } from '@/components/Icons';
import { UserX, Globe, Trash2 } from 'lucide-react';

interface BlockedUser {
    id: string;
    handle: string;
    displayName: string | null;
    avatarUrl: string | null;
    blockedAt: string;
}

interface MutedNode {
    domain: string;
    mutedAt: string;
}

export default function ModerationSettingsPage() {
    const [blockedUsers, setBlockedUsers] = useState<BlockedUser[]>([]);
    const [mutedNodes, setMutedNodes] = useState<MutedNode[]>([]);
    const [loading, setLoading] = useState(true);
    const [newNodeDomain, setNewNodeDomain] = useState('');
    const [addingNode, setAddingNode] = useState(false);

    useEffect(() => {
        loadData();
    }, []);

    const loadData = async () => {
        setLoading(true);
        try {
            const [blockedRes, mutedRes] = await Promise.all([
                fetch('/api/settings/blocked-users'),
                fetch('/api/settings/muted-nodes'),
            ]);

            if (blockedRes.ok) {
                const data = await blockedRes.json();
                setBlockedUsers(data.blockedUsers || []);
            }

            if (mutedRes.ok) {
                const data = await mutedRes.json();
                setMutedNodes(data.mutedNodes || []);
            }
        } catch (error) {
            console.error('Failed to load moderation settings:', error);
        } finally {
            setLoading(false);
        }
    };

    const handleUnblock = async (userId: string) => {
        try {
            const res = await fetch(`/api/settings/blocked-users?userId=${userId}`, {
                method: 'DELETE',
            });
            if (res.ok) {
                setBlockedUsers(prev => prev.filter(u => u.id !== userId));
            }
        } catch (error) {
            console.error('Failed to unblock user:', error);
        }
    };

    const handleUnmuteNode = async (domain: string) => {
        try {
            const res = await fetch(`/api/settings/muted-nodes?domain=${encodeURIComponent(domain)}`, {
                method: 'DELETE',
            });
            if (res.ok) {
                setMutedNodes(prev => prev.filter(n => n.domain !== domain));
            }
        } catch (error) {
            console.error('Failed to unmute node:', error);
        }
    };

    const handleMuteNode = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!newNodeDomain.trim() || addingNode) return;

        setAddingNode(true);
        try {
            const res = await fetch('/api/settings/muted-nodes', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ domain: newNodeDomain.trim() }),
            });

            if (res.ok) {
                const data = await res.json();
                setMutedNodes(prev => [
                    { domain: data.domain, mutedAt: new Date().toISOString() },
                    ...prev.filter(n => n.domain !== data.domain),
                ]);
                setNewNodeDomain('');
            }
        } catch (error) {
            console.error('Failed to mute node:', error);
        } finally {
            setAddingNode(false);
        }
    };

    if (loading) {
        return (
            <div style={{ maxWidth: '600px', margin: '0 auto', padding: '24px 16px 64px' }}>
                <div style={{ textAlign: 'center', padding: '48px', color: 'var(--foreground-tertiary)' }}>
                    Loading...
                </div>
            </div>
        );
    }

    return (
        <div style={{ maxWidth: '600px', margin: '0 auto', padding: '24px 16px 64px' }}>
            <header style={{
                display: 'flex',
                alignItems: 'center',
                gap: '16px',
                marginBottom: '32px',
            }}>
                <Link href="/settings" style={{ color: 'var(--foreground)' }}>
                    <ArrowLeftIcon />
                </Link>
                <div>
                    <h1 style={{ fontSize: '24px', fontWeight: 700 }}>Moderation</h1>
                    <p style={{ color: 'var(--foreground-tertiary)', fontSize: '14px' }}>
                        Manage blocked users and muted nodes
                    </p>
                </div>
            </header>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
                {/* Blocked Users */}
                <section>
                    <div style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                        marginBottom: '12px',
                    }}>
                        <UserX size={18} />
                        <h2 style={{ fontSize: '16px', fontWeight: 600 }}>Blocked Users</h2>
                        <span style={{
                            fontSize: '12px',
                            color: 'var(--foreground-tertiary)',
                            background: 'var(--background-secondary)',
                            padding: '2px 8px',
                            borderRadius: '10px',
                        }}>
                            {blockedUsers.length}
                        </span>
                    </div>

                    {blockedUsers.length === 0 ? (
                        <div className="card" style={{
                            padding: '24px',
                            textAlign: 'center',
                            color: 'var(--foreground-tertiary)',
                        }}>
                            You haven't blocked anyone
                        </div>
                    ) : (
                        <div className="card" style={{ overflow: 'hidden' }}>
                            {blockedUsers.map((user, i) => (
                                <div
                                    key={user.id}
                                    style={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'space-between',
                                        padding: '12px 16px',
                                        borderBottom: i < blockedUsers.length - 1 ? '1px solid var(--border)' : 'none',
                                    }}
                                >
                                    <Link
                                        href={getProfilePath(user.handle)}
                                        style={{
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: '12px',
                                            color: 'var(--foreground)',
                                            textDecoration: 'none',
                                        }}
                                    >
                                        <img
                                            src={user.avatarUrl || '/default-avatar.png'}
                                            alt=""
                                            style={{
                                                width: '40px',
                                                height: '40px',
                                                borderRadius: '50%',
                                                objectFit: 'cover',
                                            }}
                                        />
                                        <div>
                                            <div style={{ fontWeight: 500 }}>
                                                {user.displayName || user.handle}
                                            </div>
                                            <div style={{ fontSize: '13px', color: 'var(--foreground-tertiary)' }}>
                                                @{user.handle}
                                            </div>
                                        </div>
                                    </Link>
                                    <button
                                        onClick={() => handleUnblock(user.id)}
                                        className="btn btn-ghost btn-sm"
                                    >
                                        Unblock
                                    </button>
                                </div>
                            ))}
                        </div>
                    )}
                </section>

                {/* Muted Nodes */}
                <section>
                    <div style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                        marginBottom: '12px',
                    }}>
                        <Globe size={18} />
                        <h2 style={{ fontSize: '16px', fontWeight: 600 }}>Muted Nodes</h2>
                        <span style={{
                            fontSize: '12px',
                            color: 'var(--foreground-tertiary)',
                            background: 'var(--background-secondary)',
                            padding: '2px 8px',
                            borderRadius: '10px',
                        }}>
                            {mutedNodes.length}
                        </span>
                    </div>

                    <p style={{
                        fontSize: '13px',
                        color: 'var(--foreground-secondary)',
                        marginBottom: '12px',
                    }}>
                        Posts from muted nodes won't appear in your feeds or search results.
                    </p>

                    <form onSubmit={handleMuteNode} style={{ marginBottom: '12px' }}>
                        <div style={{ display: 'flex', gap: '8px' }}>
                            <input
                                type="text"
                                className="input"
                                placeholder="node.example.com"
                                value={newNodeDomain}
                                onChange={(e) => setNewNodeDomain(e.target.value)}
                                style={{ flex: 1 }}
                            />
                            <button
                                type="submit"
                                className="btn btn-primary"
                                disabled={!newNodeDomain.trim() || addingNode}
                            >
                                {addingNode ? 'Adding...' : 'Mute'}
                            </button>
                        </div>
                    </form>

                    {mutedNodes.length === 0 ? (
                        <div className="card" style={{
                            padding: '24px',
                            textAlign: 'center',
                            color: 'var(--foreground-tertiary)',
                        }}>
                            No muted nodes
                        </div>
                    ) : (
                        <div className="card" style={{ overflow: 'hidden' }}>
                            {mutedNodes.map((node, i) => (
                                <div
                                    key={node.domain}
                                    style={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'space-between',
                                        padding: '12px 16px',
                                        borderBottom: i < mutedNodes.length - 1 ? '1px solid var(--border)' : 'none',
                                    }}
                                >
                                    <div>
                                        <div style={{ fontWeight: 500 }}>{node.domain}</div>
                                        <div style={{ fontSize: '12px', color: 'var(--foreground-tertiary)' }}>
                                            Muted {new Date(node.mutedAt).toLocaleDateString()}
                                        </div>
                                    </div>
                                    <button
                                        onClick={() => handleUnmuteNode(node.domain)}
                                        className="btn btn-ghost btn-sm"
                                        style={{ color: 'var(--error)' }}
                                    >
                                        <Trash2 size={16} />
                                    </button>
                                </div>
                            ))}
                        </div>
                    )}
                </section>
            </div>
        </div>
    );
}
