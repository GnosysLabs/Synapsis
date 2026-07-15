'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ArrowLeftIcon } from '@/components/Icons';
import { useAuth } from '@/lib/contexts/AuthContext';
import { TriangleAlert, ShieldAlert } from 'lucide-react';

interface ExportStats {
    posts: number;
    following: number;
    mediaFiles: number;
    dms: number;
    bots: number;
}

export default function MigrationPage() {
    const { user } = useAuth();

    // Export state
    const [exportPassword, setExportPassword] = useState('');
    const [isExporting, setIsExporting] = useState(false);
    const [exportError, setExportError] = useState<string | null>(null);
    const [exportStats, setExportStats] = useState<ExportStats | null>(null);

    const handleExport = async () => {
        if (!exportPassword) {
            setExportError('Please enter your password');
            return;
        }

        setIsExporting(true);
        setExportError(null);

        try {
            const res = await fetch('/api/account/export', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password: exportPassword }),
            });

            const data = await res.json();

            if (!res.ok) {
                throw new Error(data.error || 'Export failed');
            }

            setExportStats(data.stats);

            // Trigger download
            const blob = new Blob([JSON.stringify(data.export, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `synapsis-export-${user?.handle}-${new Date().toISOString().split('T')[0]}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

        } catch (error) {
            setExportError(error instanceof Error ? error.message : 'Export failed');
        } finally {
            setIsExporting(false);
        }
    };

    if (!user) {
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
                        <h1 style={{ fontSize: '24px', fontWeight: 700 }}>Export Account</h1>
                    </div>
                </header>
                <div className="card" style={{ padding: '24px', textAlign: 'center' }}>
                    <p style={{ marginBottom: '16px' }}>Please log in to export your account.</p>
                    <Link href="/login" className="btn btn-primary">Log In</Link>
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
                    <h1 style={{ fontSize: '24px', fontWeight: 700 }}>Export Account</h1>
                    <p style={{ color: 'var(--foreground-tertiary)', fontSize: '14px' }}>
                        Download a backup of your identity and content
                    </p>
                </div>
            </header>

            <div className="card" style={{ padding: '24px' }}>
                <h2 style={{ fontSize: '18px', fontWeight: 600, marginBottom: '16px' }}>
                    Download Your Data
                </h2>

                <p style={{ color: 'var(--foreground-secondary)', marginBottom: '20px', lineHeight: 1.6 }}>
                    Download a signed backup of your account identity, posts, and media.
                    You can use this file to migrate to another Synapsis node by selecting &quot;Import&quot; on the login page of that node.
                </p>

                <div style={{
                    background: 'var(--background-tertiary)',
                    padding: '16px',
                    borderRadius: '8px',
                    marginBottom: '20px',
                }}>
                    <div style={{ fontSize: '13px', color: 'var(--foreground-tertiary)', marginBottom: '8px' }}>
                        Your export will include:
                    </div>
                    <ul style={{
                        listStyle: 'disc',
                        paddingLeft: '20px',
                        color: 'var(--foreground-secondary)',
                        fontSize: '14px',
                        lineHeight: 1.6,
                    }}>
                        <li>Your DID (Decentralized Identifier)</li>
                        <li>Your cryptographic keys (encrypted with your password)</li>
                        <li>Your profile information</li>
                        <li>All your posts</li>
                        <li>Your following list</li>
                        <li>DM conversation records and encrypted message envelopes</li>
                        <li>Your automated bots and their configuration</li>
                    </ul>
                </div>

                <div style={{
                    display: 'flex',
                    gap: '12px',
                    padding: '16px',
                    marginBottom: '20px',
                    background: 'rgba(245, 158, 11, 0.1)',
                    border: '1px solid rgba(245, 158, 11, 0.35)',
                    borderRadius: '8px',
                }}>
                    <TriangleAlert size={20} style={{ flexShrink: 0, color: '#f59e0b' }} />
                    <p style={{ fontSize: '13px', color: 'var(--foreground-secondary)', margin: 0, lineHeight: 1.5 }}>
                        Encrypted DM keys are not portable yet. This export preserves encrypted message records,
                        but E2EE history will not open after importing it on another node. Keep access to this
                        browser and node if you need to read that history.
                    </p>
                </div>

                <div style={{ marginBottom: '20px' }}>
                    <label style={{ fontSize: '13px', color: 'var(--foreground-tertiary)', display: 'block', marginBottom: '6px' }}>
                        Confirm your password
                    </label>
                    <input
                        type="password"
                        className="input"
                        value={exportPassword}
                        onChange={(e) => setExportPassword(e.target.value)}
                        placeholder="Enter your password"
                    />
                </div>

                {exportError && (
                    <div style={{ color: 'var(--error)', fontSize: '14px', marginBottom: '16px' }}>
                        {exportError}
                    </div>
                )}

                {exportStats && (
                    <div style={{
                        background: 'var(--success)',
                        color: '#000',
                        padding: '16px',
                        borderRadius: '8px',
                        marginBottom: '20px',
                    }}>
                        Export successful! Downloaded {exportStats.posts} posts, {exportStats.dms} DM threads, and {exportStats.bots} bots.
                    </div>
                )}

                <button
                    className="btn btn-primary"
                    onClick={handleExport}
                    disabled={isExporting || !exportPassword}
                    style={{ width: '100%' }}
                >
                    {isExporting ? 'Exporting...' : 'Download Export File'}
                </button>

                <div style={{
                    marginTop: '20px',
                    padding: '16px',
                    background: 'rgba(239, 68, 68, 0.1)',
                    border: '1px solid rgba(239, 68, 68, 0.3)',
                    borderRadius: '8px',
                }}>
                    <div style={{ fontWeight: 600, color: 'var(--error)', marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <ShieldAlert size={18} /> Security Warning
                    </div>
                    <p style={{ fontSize: '13px', color: 'var(--foreground-secondary)', margin: 0 }}>
                        The export file contains your encrypted private key. Keep this file secure
                        and never share it with anyone. Anyone with this file and your password
                        can access your account.
                    </p>
                </div>
            </div>
        </div>
    );
}
