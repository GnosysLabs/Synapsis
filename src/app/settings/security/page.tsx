'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ArrowLeftIcon } from '@/components/Icons';
import { Shield, Lock, Check, AlertCircle, Mail, Trash2 } from 'lucide-react';
import { useAuth } from '@/lib/contexts/AuthContext';
import { prepareE2EEPasswordChange } from '@/lib/e2ee/client';

export default function SecuritySettingsPage() {
    const [currentPassword, setCurrentPassword] = useState('');
    const [newPassword, setNewPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);
    const { isIdentityUnlocked, signUserAction, user } = useAuth();

    // Email change states
    const [newEmail, setNewEmail] = useState('');
    const [emailPassword, setEmailPassword] = useState('');
    const [isChangingEmail, setIsChangingEmail] = useState(false);
    const [emailError, setEmailError] = useState<string | null>(null);
    const [emailSuccess, setEmailSuccess] = useState<string | null>(null);

    // Delete account states
    const [deletePassword, setDeletePassword] = useState('');
    const [deleteConfirm, setDeleteConfirm] = useState('');
    const [isDeleting, setIsDeleting] = useState(false);
    const [deleteError, setDeleteError] = useState<string | null>(null);
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError(null);
        setSuccess(null);

        // Validation
        if (newPassword.length < 8) {
            setError('New password must be at least 8 characters long');
            return;
        }

        if (newPassword !== confirmPassword) {
            setError('New passwords do not match');
            return;
        }

        if (currentPassword === newPassword) {
            setError('New password cannot be the same as the current password');
            return;
        }

        // With persistence, identity should be unlocked
        if (!isIdentityUnlocked) {
            setError('Your session has expired. Please log in again.');
            return;
        }

        setIsSubmitting(true);

        try {
            const e2eeRecovery = user?.did
                ? await prepareE2EEPasswordChange({
                    did: user.did,
                    currentPassword,
                    newPassword,
                })
                : undefined;
            // Sign the password change action
            // This proves we have the key unlocked (which required knowing the password)
            const signedPayload = await signUserAction('change_password', {
                currentPassword,
                newPassword,
                ...(e2eeRecovery ? { e2eeRecovery } : {}),
            });

            const res = await fetch('/api/account/password', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(signedPayload),
            });

            const data = await res.json();

            if (!res.ok) {
                throw new Error(data.error || 'Failed to change password');
            }

            setSuccess('Password updated successfully');
            setCurrentPassword('');
            setNewPassword('');
            setConfirmPassword('');
        } catch (error) {
            setError(error instanceof Error ? error.message : 'An error occurred');
        } finally {
            setIsSubmitting(false);
        }
    };

    const handleEmailChange = async (e: React.FormEvent) => {
        e.preventDefault();
        setEmailError(null);
        setEmailSuccess(null);

        if (!newEmail || !emailPassword) {
            setEmailError('Please enter your new email and current password');
            return;
        }

        if (!isIdentityUnlocked) {
            setEmailError('Your session has expired. Please log in again.');
            return;
        }

        setIsChangingEmail(true);

        try {
            const signedPayload = await signUserAction('change_email', { 
                newEmail, 
                currentPassword: emailPassword 
            });

            const res = await fetch('/api/account/email', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(signedPayload),
            });

            const data = await res.json();

            if (!res.ok) {
                throw new Error(data.error || 'Failed to change email');
            }

            setEmailSuccess('Email updated successfully');
            setNewEmail('');
            setEmailPassword('');
        } catch (error) {
            setEmailError(error instanceof Error ? error.message : 'An error occurred');
        } finally {
            setIsChangingEmail(false);
        }
    };

    const handleDeleteAccount = async (e: React.FormEvent) => {
        e.preventDefault();
        setDeleteError(null);

        if (deleteConfirm !== 'DELETE') {
            setDeleteError('Please type DELETE to confirm account deletion');
            return;
        }

        if (!deletePassword) {
            setDeleteError('Please enter your password to confirm');
            return;
        }

        if (!isIdentityUnlocked) {
            setDeleteError('Your session has expired. Please log in again.');
            return;
        }

        setIsDeleting(true);

        try {
            const signedPayload = await signUserAction('delete_account', { 
                password: deletePassword 
            });

            const res = await fetch('/api/account/delete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(signedPayload),
            });

            const data = await res.json();

            if (!res.ok) {
                throw new Error(data.error || 'Failed to delete account');
            }

            // Account deleted - redirect to home
            window.location.href = '/';
        } catch (error) {
            setDeleteError(error instanceof Error ? error.message : 'An error occurred');
            setIsDeleting(false);
        }
    };

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
                    <h1 style={{ fontSize: '24px', fontWeight: 700 }}>Security</h1>
                    <p style={{ color: 'var(--foreground-tertiary)', fontSize: '14px' }}>
                        Manage your password and security settings
                    </p>
                </div>
            </header>

            <div className="card" style={{ padding: '24px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '24px' }}>
                    <div style={{
                        width: '40px',
                        height: '40px',
                        borderRadius: '50%',
                        background: 'var(--background-tertiary)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                    }}>
                        <Lock size={20} />
                    </div>
                    <div>
                        <h2 style={{ fontSize: '18px', fontWeight: 600 }}>Change Password</h2>
                        <p style={{ color: 'var(--foreground-secondary)', fontSize: '14px' }}>
                            Update your password to keep your account secure
                        </p>
                    </div>
                </div>

                <form onSubmit={handleSubmit}>
                    <div style={{ marginBottom: '20px' }}>
                        <label style={{ fontSize: '13px', color: 'var(--foreground-tertiary)', display: 'block', marginBottom: '6px' }}>
                            Current Password
                        </label>
                        <input
                            type="password"
                            className="input"
                            value={currentPassword}
                            onChange={(e) => setCurrentPassword(e.target.value)}
                            placeholder="Enter current password"
                            required
                        />
                    </div>

                    <div style={{ marginBottom: '20px' }}>
                        <label style={{ fontSize: '13px', color: 'var(--foreground-tertiary)', display: 'block', marginBottom: '6px' }}>
                            New Password
                        </label>
                        <input
                            type="password"
                            className="input"
                            value={newPassword}
                            onChange={(e) => setNewPassword(e.target.value)}
                            placeholder="Enter new password (min. 8 characters)"
                            required
                        />
                    </div>

                    <div style={{ marginBottom: '24px' }}>
                        <label style={{ fontSize: '13px', color: 'var(--foreground-tertiary)', display: 'block', marginBottom: '6px' }}>
                            Confirm New Password
                        </label>
                        <input
                            type="password"
                            className="input"
                            value={confirmPassword}
                            onChange={(e) => setConfirmPassword(e.target.value)}
                            placeholder="Confirm new password"
                            required
                        />
                    </div>

                    {error && (
                        <div style={{
                            padding: '12px',
                            background: 'rgba(239, 68, 68, 0.1)',
                            border: '1px solid rgba(239, 68, 68, 0.2)',
                            borderRadius: '8px',
                            color: 'var(--error)',
                            fontSize: '14px',
                            marginBottom: '20px',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '8px',
                        }}>
                            <AlertCircle size={16} />
                            {error}
                        </div>
                    )}

                    {success && (
                        <div style={{
                            padding: '12px',
                            background: 'rgba(34, 197, 94, 0.1)',
                            border: '1px solid rgba(34, 197, 94, 0.2)',
                            borderRadius: '8px',
                            color: 'var(--success)',
                            fontSize: '14px',
                            marginBottom: '20px',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '8px',
                        }}>
                            <Check size={16} />
                            {success}
                        </div>
                    )}

                    <div style={{
                        marginTop: '20px',
                        padding: '12px',
                        background: 'var(--background-tertiary)',
                        borderRadius: '8px',
                        marginBottom: '20px',
                        fontSize: '13px',
                        color: 'var(--foreground-secondary)'
                    }}>
                        <strong>Note:</strong> Changing your password will re-encrypt your identity keys.
                        Your DID and followers remain unchanged.
                    </div>

                    <button
                        type="submit"
                        className="btn btn-primary"
                        disabled={isSubmitting || !currentPassword || !newPassword || !confirmPassword}
                        style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}
                    >
                        {isSubmitting ? (
                            'Updating...'
                        ) : (
                            <>
                                <Shield size={16} /> Update Password
                            </>
                        )}
                    </button>
                </form>
            </div>

            {/* Change Email Section */}
            <div className="card" style={{ padding: '24px', marginTop: '24px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '24px' }}>
                    <div style={{
                        width: '40px',
                        height: '40px',
                        borderRadius: '50%',
                        background: 'var(--background-tertiary)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                    }}>
                        <Mail size={20} />
                    </div>
                    <div>
                        <h2 style={{ fontSize: '18px', fontWeight: 600 }}>Change Email</h2>
                        <p style={{ color: 'var(--foreground-secondary)', fontSize: '14px' }}>
                            Update your email address
                        </p>
                    </div>
                </div>

                <form onSubmit={handleEmailChange}>
                    <div style={{ marginBottom: '20px' }}>
                        <label style={{ fontSize: '13px', color: 'var(--foreground-tertiary)', display: 'block', marginBottom: '6px' }}>
                            Current Email
                        </label>
                        <input
                            type="email"
                            className="input"
                            value={user?.email || ''}
                            disabled
                            style={{ opacity: 0.6 }}
                        />
                    </div>

                    <div style={{ marginBottom: '20px' }}>
                        <label style={{ fontSize: '13px', color: 'var(--foreground-tertiary)', display: 'block', marginBottom: '6px' }}>
                            New Email
                        </label>
                        <input
                            type="email"
                            className="input"
                            value={newEmail}
                            onChange={(e) => setNewEmail(e.target.value)}
                            placeholder="Enter new email address"
                            required
                        />
                    </div>

                    <div style={{ marginBottom: '24px' }}>
                        <label style={{ fontSize: '13px', color: 'var(--foreground-tertiary)', display: 'block', marginBottom: '6px' }}>
                            Current Password (for verification)
                        </label>
                        <input
                            type="password"
                            className="input"
                            value={emailPassword}
                            onChange={(e) => setEmailPassword(e.target.value)}
                            placeholder="Enter your current password"
                            required
                        />
                    </div>

                    {emailError && (
                        <div style={{
                            padding: '12px',
                            background: 'rgba(239, 68, 68, 0.1)',
                            border: '1px solid rgba(239, 68, 68, 0.2)',
                            borderRadius: '8px',
                            color: 'var(--error)',
                            fontSize: '14px',
                            marginBottom: '20px',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '8px',
                        }}>
                            <AlertCircle size={16} />
                            {emailError}
                        </div>
                    )}

                    {emailSuccess && (
                        <div style={{
                            padding: '12px',
                            background: 'rgba(34, 197, 94, 0.1)',
                            border: '1px solid rgba(34, 197, 94, 0.2)',
                            borderRadius: '8px',
                            color: 'var(--success)',
                            fontSize: '14px',
                            marginBottom: '20px',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '8px',
                        }}>
                            <Check size={16} />
                            {emailSuccess}
                        </div>
                    )}

                    <button
                        type="submit"
                        className="btn btn-primary"
                        disabled={isChangingEmail || !newEmail || !emailPassword}
                        style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}
                    >
                        {isChangingEmail ? (
                            'Updating...'
                        ) : (
                            <>
                                <Mail size={16} /> Update Email
                            </>
                        )}
                    </button>
                </form>
            </div>

            {/* Delete Account Section */}
            <div className="card" style={{ padding: '24px', marginTop: '24px', border: '1px solid rgba(239, 68, 68, 0.3)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '24px' }}>
                    <div style={{
                        width: '40px',
                        height: '40px',
                        borderRadius: '50%',
                        background: 'rgba(239, 68, 68, 0.1)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: 'var(--error)',
                    }}>
                        <Trash2 size={20} />
                    </div>
                    <div>
                        <h2 style={{ fontSize: '18px', fontWeight: 600, color: 'var(--error)' }}>Delete Account</h2>
                        <p style={{ color: 'var(--foreground-secondary)', fontSize: '14px' }}>
                            Permanently delete your account and all data
                        </p>
                    </div>
                </div>

                {!showDeleteConfirm ? (
                    <div>
                        <div style={{
                            padding: '16px',
                            background: 'rgba(239, 68, 68, 0.05)',
                            borderRadius: '8px',
                            marginBottom: '20px',
                            fontSize: '14px',
                            color: 'var(--foreground-secondary)',
                            lineHeight: 1.5,
                        }}>
                            <strong style={{ color: 'var(--error)' }}>Warning:</strong> This action cannot be undone. 
                            Your account, posts, and all associated data will be permanently deleted. 
                            Your handle will be released and may be claimed by someone else.
                        </div>
                        <button
                            onClick={() => setShowDeleteConfirm(true)}
                            className="btn"
                            style={{ 
                                width: '100%', 
                                background: 'rgba(239, 68, 68, 0.1)', 
                                color: 'var(--error)',
                                border: '1px solid rgba(239, 68, 68, 0.3)',
                            }}
                        >
                            I want to delete my account
                        </button>
                    </div>
                ) : (
                    <form onSubmit={handleDeleteAccount}>
                        <div style={{
                            padding: '16px',
                            background: 'rgba(239, 68, 68, 0.1)',
                            borderRadius: '8px',
                            marginBottom: '20px',
                            fontSize: '14px',
                            color: 'var(--foreground-secondary)',
                            lineHeight: 1.5,
                        }}>
                            <strong style={{ color: 'var(--error)' }}>This is permanent.</strong> Type <code style={{ background: 'var(--background)', padding: '2px 6px', borderRadius: '4px' }}>DELETE</code> below to confirm.
                        </div>

                        <div style={{ marginBottom: '20px' }}>
                            <label style={{ fontSize: '13px', color: 'var(--foreground-tertiary)', display: 'block', marginBottom: '6px' }}>
                                Type DELETE to confirm
                            </label>
                            <input
                                type="text"
                                className="input"
                                value={deleteConfirm}
                                onChange={(e) => setDeleteConfirm(e.target.value)}
                                placeholder="DELETE"
                                required
                            />
                        </div>

                        <div style={{ marginBottom: '20px' }}>
                            <label style={{ fontSize: '13px', color: 'var(--foreground-tertiary)', display: 'block', marginBottom: '6px' }}>
                                Your Password (for verification)
                            </label>
                            <input
                                type="password"
                                className="input"
                                value={deletePassword}
                                onChange={(e) => setDeletePassword(e.target.value)}
                                placeholder="Enter your password"
                                required
                            />
                        </div>

                        {deleteError && (
                            <div style={{
                                padding: '12px',
                                background: 'rgba(239, 68, 68, 0.1)',
                                border: '1px solid rgba(239, 68, 68, 0.2)',
                                borderRadius: '8px',
                                color: 'var(--error)',
                                fontSize: '14px',
                                marginBottom: '20px',
                                display: 'flex',
                                alignItems: 'center',
                                gap: '8px',
                            }}>
                                <AlertCircle size={16} />
                                {deleteError}
                            </div>
                        )}

                        <div style={{ display: 'flex', gap: '12px' }}>
                            <button
                                type="button"
                                onClick={() => {
                                    setShowDeleteConfirm(false);
                                    setDeleteConfirm('');
                                    setDeletePassword('');
                                    setDeleteError(null);
                                }}
                                className="btn btn-ghost"
                                style={{ flex: 1 }}
                                disabled={isDeleting}
                            >
                                Cancel
                            </button>
                            <button
                                type="submit"
                                className="btn"
                                disabled={isDeleting || deleteConfirm !== 'DELETE' || !deletePassword}
                                style={{ 
                                    flex: 1,
                                    background: 'var(--error)', 
                                    color: '#fff',
                                }}
                            >
                                {isDeleting ? 'Deleting...' : 'Delete My Account'}
                            </button>
                        </div>
                    </form>
                )}
            </div>
        </div>
    );
}
