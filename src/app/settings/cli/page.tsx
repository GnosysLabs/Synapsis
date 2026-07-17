'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { KeyRound, Loader2, Terminal, Trash2 } from 'lucide-react';
import { ArrowLeftIcon } from '@/components/Icons';
import { useAuth } from '@/lib/contexts/AuthContext';
import { useAppDialog } from '@/lib/contexts/DialogContext';

interface AuthorizationRequest {
  id: string;
  name: string;
  fingerprint: string;
  scopes: string[];
  credentialLifetimeDays: number;
  status: 'pending' | 'approved' | 'expired';
  expiresAt: string;
}

interface Credential {
  id: string;
  name: string;
  fingerprint: string;
  scopes: string[];
  expiresAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

function fingerprint(value: string): string {
  return value.match(/.{1,4}/g)?.join(' ') ?? value;
}

function scopeLabel(scope: string): string {
  if (scope === 'posts:write') return 'Publish posts';
  if (scope === 'media:write') return 'Upload media';
  return scope;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

export default function CliSettingsPage() {
  const { signUserAction } = useAuth();
  const { showConfirm } = useAppDialog();
  const [requestId, setRequestId] = useState<string | null>(null);
  const [authorization, setAuthorization] = useState<AuthorizationRequest | null>(null);
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isApproving, setIsApproving] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const loadCredentials = useCallback(async () => {
    const response = await fetch('/api/cli/credentials', { cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Unable to load CLI credentials');
    setCredentials(data.credentials || []);
  }, []);

  const loadAuthorization = useCallback(async (id: string) => {
    const response = await fetch(`/api/cli/authorizations/${encodeURIComponent(id)}/approval`, { cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Unable to load authorization request');
    setAuthorization(data);
  }, []);

  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('request');
    setRequestId(id);
    Promise.all([loadCredentials(), ...(id ? [loadAuthorization(id)] : [])])
      .catch(loadError => setError(loadError instanceof Error ? loadError.message : 'Unable to load CLI settings'))
      .finally(() => setIsLoading(false));
  }, [loadAuthorization, loadCredentials]);

  const approve = async () => {
    if (!requestId) return;
    setIsApproving(true);
    setError('');
    setMessage('');
    try {
      const signedAction = await signUserAction('cli_authorize', { requestId });
      const response = await fetch(`/api/cli/authorizations/${encodeURIComponent(requestId)}/approval`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(signedAction),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Unable to approve CLI access');
      setMessage('CLI access approved. You can return to the terminal.');
      await Promise.all([loadAuthorization(requestId), loadCredentials()]);
    } catch (approveError) {
      setError(approveError instanceof Error ? approveError.message : 'Unable to approve CLI access');
    } finally {
      setIsApproving(false);
    }
  };

  const revoke = async (credential: Credential) => {
    const confirmed = await showConfirm({
      title: `Revoke ${credential.name}?`,
      message: 'That CLI or agent will immediately lose its ability to publish posts and upload media.',
      confirmLabel: 'Revoke access',
      tone: 'danger',
    });
    if (!confirmed) return;

    setRevokingId(credential.id);
    setError('');
    try {
      const signedAction = await signUserAction('cli_revoke', { credentialId: credential.id });
      const response = await fetch(`/api/cli/credentials/${encodeURIComponent(credential.id)}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(signedAction),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Unable to revoke CLI access');
      await loadCredentials();
    } catch (revokeError) {
      setError(revokeError instanceof Error ? revokeError.message : 'Unable to revoke CLI access');
    } finally {
      setRevokingId(null);
    }
  };

  if (isLoading) {
    return (
      <main aria-busy="true" aria-label="Loading CLI settings" style={{ minHeight: '70vh', display: 'grid', placeItems: 'center' }}>
        <Loader2 className="animate-spin" size={24} />
      </main>
    );
  }

  return (
    <div style={{ maxWidth: '680px', margin: '0 auto', padding: '24px 16px 64px' }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '28px' }}>
        <Link href="/settings" style={{ color: 'var(--foreground)' }} aria-label="Back to settings">
          <ArrowLeftIcon />
        </Link>
        <div>
          <h1 style={{ fontSize: '24px', fontWeight: 700 }}>CLI & Agents</h1>
          <p style={{ color: 'var(--foreground-tertiary)', fontSize: '14px' }}>
            Give revocable posting access without sharing your password or identity key
          </p>
        </div>
      </header>

      {authorization && (
        <section className="card" style={{ padding: '20px', marginBottom: '20px', borderColor: 'var(--accent)' }}>
          <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-start' }}>
            <Terminal size={22} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <h2 style={{ fontSize: '18px', fontWeight: 650, marginBottom: '6px' }}>
                {authorization.name} requests access
              </h2>
              <p style={{ color: 'var(--foreground-secondary)', fontSize: '14px', lineHeight: 1.5 }}>
                This device will be authorized for {authorization.credentialLifetimeDays} days.
              </p>
              <ul style={{ margin: '14px 0', paddingLeft: '20px', color: 'var(--foreground-secondary)', fontSize: '14px' }}>
                {authorization.scopes.map(scope => <li key={scope}>{scopeLabel(scope)}</li>)}
              </ul>
              <div style={{ fontSize: '12px', color: 'var(--foreground-tertiary)', overflowWrap: 'anywhere' }}>
                Key fingerprint: {fingerprint(authorization.fingerprint)}
              </div>
              {authorization.status === 'pending' && (
                <button className="btn btn-primary" type="button" onClick={approve} disabled={isApproving} style={{ marginTop: '18px' }}>
                  {isApproving ? 'Approving…' : 'Approve CLI access'}
                </button>
              )}
              {authorization.status === 'expired' && <p style={{ color: 'var(--error)', marginTop: '16px' }}>This request expired. Start the CLI connection again.</p>}
              {authorization.status === 'approved' && <p style={{ color: 'var(--success)', marginTop: '16px' }}>Access approved. Return to the terminal.</p>}
            </div>
          </div>
        </section>
      )}

      <section>
        <h2 style={{ fontSize: '18px', fontWeight: 650, marginBottom: '12px' }}>Authorized devices</h2>
        {credentials.length === 0 ? (
          <div className="card" style={{ padding: '20px', color: 'var(--foreground-secondary)' }}>
            No CLI devices have been authorized.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {credentials.map(credential => {
              const inactive = Boolean(credential.revokedAt) || Date.parse(credential.expiresAt) <= Date.now();
              return (
                <article className="card" key={credential.id} style={{ padding: '18px', opacity: inactive ? 0.65 : 1 }}>
                  <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-start' }}>
                    <KeyRound size={20} />
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontWeight: 600 }}>{credential.name}</div>
                      <div style={{ color: 'var(--foreground-tertiary)', fontSize: '13px', marginTop: '4px' }}>
                        {credential.revokedAt ? 'Revoked' : Date.parse(credential.expiresAt) <= Date.now() ? 'Expired' : `Expires ${formatDate(credential.expiresAt)}`}
                      </div>
                      <div style={{ color: 'var(--foreground-tertiary)', fontSize: '12px', marginTop: '8px', overflowWrap: 'anywhere' }}>
                        {fingerprint(credential.fingerprint)}
                      </div>
                      <div style={{ color: 'var(--foreground-tertiary)', fontSize: '12px', marginTop: '6px' }}>
                        {credential.scopes.map(scopeLabel).join(' · ')}
                      </div>
                      {credential.lastUsedAt && <div style={{ color: 'var(--foreground-tertiary)', fontSize: '12px', marginTop: '6px' }}>Last used {formatDate(credential.lastUsedAt)}</div>}
                    </div>
                    {!inactive && (
                      <button className="btn btn-ghost" type="button" onClick={() => revoke(credential)} disabled={revokingId === credential.id} aria-label={`Revoke ${credential.name}`}>
                        {revokingId === credential.id ? <Loader2 className="animate-spin" size={16} /> : <Trash2 size={16} />}
                    </button>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      {message && <p role="status" style={{ color: 'var(--success)', marginTop: '16px' }}>{message}</p>}
      {error && <p role="alert" style={{ color: 'var(--error)', marginTop: '16px' }}>{error}</p>}
    </div>
  );
}
