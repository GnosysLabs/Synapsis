'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Bot, Check, Copy, KeyRound, Loader2, ShieldCheck, Terminal, Trash2 } from 'lucide-react';
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

function CommandBlock({ command }: { command: string }) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle');

  const copy = async () => {
    try {
      if (!navigator.clipboard) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(command);
      setCopyState('copied');
      window.setTimeout(() => setCopyState('idle'), 2_000);
    } catch {
      setCopyState('error');
    }
  };

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: '10px',
      marginTop: '10px',
      padding: '10px 10px 10px 12px',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius-md)',
      background: 'var(--background)',
    }}>
      <code style={{ flex: 1, minWidth: 0, overflowX: 'auto', whiteSpace: 'nowrap', fontSize: '13px' }}>
        {command}
      </code>
      <button className="btn btn-ghost btn-sm" type="button" onClick={copy} aria-label={`Copy command: ${command}`}>
        {copyState === 'copied' ? <Check size={15} /> : <Copy size={15} />}
        <span>{copyState === 'copied' ? 'Copied' : copyState === 'error' ? 'Copy failed' : 'Copy'}</span>
      </button>
    </div>
  );
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
  const [nodeUrl, setNodeUrl] = useState('https://your-node.example');

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
    setNodeUrl(window.location.origin);
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

      <section className="card" style={{ padding: '22px', marginBottom: '28px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px', marginBottom: '20px' }}>
          <Bot size={24} style={{ flexShrink: 0 }} />
          <div>
            <h2 style={{ fontSize: '19px', fontWeight: 650, marginBottom: '6px' }}>Post from a terminal or agent</h2>
            <p style={{ color: 'var(--foreground-secondary)', fontSize: '14px', lineHeight: 1.55 }}>
              The Synapsis CLI lets you publish without giving a terminal or AI agent your password or account identity key.
              Each connection is scoped, expires automatically, and can be revoked below at any time.
            </p>
          </div>
        </div>

        <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '20px' }}>
          <li style={{ display: 'grid', gridTemplateColumns: '28px minmax(0, 1fr)', gap: '12px' }}>
            <div aria-hidden="true" style={{ width: '28px', height: '28px', borderRadius: '50%', display: 'grid', placeItems: 'center', background: 'var(--background-tertiary)', fontSize: '13px', fontWeight: 700 }}>1</div>
            <div>
              <h3 style={{ fontSize: '15px', fontWeight: 650, marginBottom: '4px' }}>Install the CLI</h3>
              <p style={{ color: 'var(--foreground-secondary)', fontSize: '13px', lineHeight: 1.5 }}>
                Run this once on the computer where you use your terminal or agent. Node.js 20 or newer is required.
              </p>
              <CommandBlock command="npm install --global @gnosyslabs/synapsis-cli" />
            </div>
          </li>

          <li style={{ display: 'grid', gridTemplateColumns: '28px minmax(0, 1fr)', gap: '12px' }}>
            <div aria-hidden="true" style={{ width: '28px', height: '28px', borderRadius: '50%', display: 'grid', placeItems: 'center', background: 'var(--background-tertiary)', fontSize: '13px', fontWeight: 700 }}>2</div>
            <div>
              <h3 style={{ fontSize: '15px', fontWeight: 650, marginBottom: '4px' }}>Connect this account</h3>
              <p style={{ color: 'var(--foreground-secondary)', fontSize: '13px', lineHeight: 1.5 }}>
                This opens Synapsis in your browser. Sign in, review the requested permissions, and approve the device here.
              </p>
              <CommandBlock command={`synapsis auth connect ${nodeUrl}`} />
              <p style={{ color: 'var(--foreground-tertiary)', fontSize: '12px', lineHeight: 1.45, marginTop: '8px' }}>
                Repeat this command for any other account or node you want available. Use <code>synapsis auth status</code> to see connected accounts.
              </p>
            </div>
          </li>

          <li style={{ display: 'grid', gridTemplateColumns: '28px minmax(0, 1fr)', gap: '12px' }}>
            <div aria-hidden="true" style={{ width: '28px', height: '28px', borderRadius: '50%', display: 'grid', placeItems: 'center', background: 'var(--background-tertiary)', fontSize: '13px', fontWeight: 700 }}>3</div>
            <div>
              <h3 style={{ fontSize: '15px', fontWeight: 650, marginBottom: '4px' }}>Publish your first post</h3>
              <p style={{ color: 'var(--foreground-secondary)', fontSize: '13px', lineHeight: 1.5 }}>
                Text posts work immediately after approval.
              </p>
              <CommandBlock command={'synapsis post create --text "Hello from the CLI"'} />
              <details style={{ marginTop: '10px', color: 'var(--foreground-secondary)', fontSize: '13px' }}>
                <summary style={{ cursor: 'pointer', color: 'var(--foreground)' }}>Post a photo or other media</summary>
                <p style={{ lineHeight: 1.5, marginTop: '8px' }}>
                  Connect <Link href="/settings/storage" style={{ color: 'var(--accent)' }}>Media Storage</Link> first, then include a file and useful alt text. Up to four media files are supported.
                </p>
                <CommandBlock command={'synapsis post create --text "A new photo" --media ./photo.jpg --alt "Describe the photo"'} />
              </details>
            </div>
          </li>

          <li style={{ display: 'grid', gridTemplateColumns: '28px minmax(0, 1fr)', gap: '12px' }}>
            <div aria-hidden="true" style={{ width: '28px', height: '28px', borderRadius: '50%', display: 'grid', placeItems: 'center', background: 'var(--background-tertiary)', fontSize: '13px', fontWeight: 700 }}>4</div>
            <div>
              <h3 style={{ fontSize: '15px', fontWeight: 650, marginBottom: '4px' }}>Teach your agent how to post</h3>
              <p style={{ color: 'var(--foreground-secondary)', fontSize: '13px', lineHeight: 1.5 }}>
                Install the bundled posting skill for Codex, Claude Code, and Agent Skills-compatible clients. Then ask your agent to post to Synapsis in ordinary language.
              </p>
              <CommandBlock command="synapsis skill install" />
            </div>
          </li>
        </ol>

        <div style={{ display: 'flex', gap: '10px', marginTop: '22px', padding: '14px', borderRadius: 'var(--radius-md)', background: 'var(--background-secondary)' }}>
          <ShieldCheck size={20} style={{ color: 'var(--success)', flexShrink: 0 }} />
          <div>
            <div style={{ fontSize: '14px', fontWeight: 650, marginBottom: '3px' }}>Limited, revocable access</div>
            <p style={{ color: 'var(--foreground-secondary)', fontSize: '12px', lineHeight: 1.5 }}>
              Authorized devices can only publish posts and upload media. They cannot read your password, primary signing key, private messages, or account settings. Credentials expire after 90 days by default.
            </p>
          </div>
        </div>
      </section>

      <section>
        <h2 style={{ fontSize: '18px', fontWeight: 650, marginBottom: '4px' }}>Authorized devices</h2>
        <p style={{ color: 'var(--foreground-tertiary)', fontSize: '13px', lineHeight: 1.5, marginBottom: '12px' }}>
          Review active connections or revoke access immediately.
        </p>
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
