'use client';

import { useEffect, useRef, useState } from 'react';
import { Eye, EyeOff, Loader2, LockKeyhole } from 'lucide-react';

import type { E2EEIdentityState } from '@/lib/e2ee/use-e2ee-identity';

interface E2EEChatGateProps {
  state: E2EEIdentityState;
  busy: boolean;
  error: string | null;
  identityUnlocked: boolean;
  onSetup: (pin: string) => Promise<void>;
  onUnlock: (pin: string) => Promise<void>;
  onReset: (pin: string, currentPassword: string) => Promise<void>;
  onRetry: () => Promise<void>;
  onCancel: () => void;
}

function formatCountdown(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds.toString().padStart(2, '0')}s` : `${seconds}s`;
}

export function E2EEChatGate(props: E2EEChatGateProps) {
  const { busy, onCancel } = props;
  const [pin, setPin] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [showPin, setShowPin] = useState(false);
  const [resetMode, setResetMode] = useState(false);
  const [understandsReset, setUnderstandsReset] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const pinRef = useRef<HTMLInputElement>(null);

  const lockedVault = props.state.status === 'locked' && props.state.vault.configured
    ? props.state.vault
    : null;
  const lockedUntilMs = lockedVault?.lockedUntil
    ? new Date(lockedVault.lockedUntil).getTime()
    : null;

  useEffect(() => {
    if (props.state.status === 'setup_required' || props.state.status === 'locked') {
      pinRef.current?.focus();
    }
  }, [props.state.status, resetMode]);

  useEffect(() => {
    if (!lockedUntilMs || lockedUntilMs <= Date.now()) return;
    const timer = window.setInterval(() => {
      const next = Date.now();
      setNow(next);
      if (next >= lockedUntilMs) window.clearInterval(timer);
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [lockedUntilMs]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || busy) return;
      if (resetMode) {
        setResetMode(false);
        setLocalError(null);
      } else {
        onCancel();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [busy, onCancel, resetMode]);

  if (props.state.status === 'loading') {
    return (
      <main aria-busy="true" style={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }}>
        <div style={{ textAlign: 'center', color: 'var(--foreground-secondary)' }}>
          <Loader2 className="animate-spin" size={28} style={{ margin: '0 auto 12px' }} aria-hidden="true" />
          <p>Opening encrypted messages…</p>
        </div>
      </main>
    );
  }

  if (props.state.status === 'error') {
    return (
      <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24 }}>
        <section style={{ maxWidth: 420, textAlign: 'center' }}>
          <h1 style={{ fontSize: 20 }}>Encrypted messages unavailable</h1>
          <p style={{ color: 'var(--foreground-secondary)' }}>{props.state.message}</p>
          <button className="btn btn-primary" onClick={() => void props.onRetry()}>Try again</button>
        </section>
      </main>
    );
  }

  if (props.state.status === 'ready') return null;

  const isSetup = props.state.status === 'setup_required';
  const isMigrationSetup = props.state.status === 'setup_required' && !!props.state.previousKey;
  const lockedUntil = lockedVault?.lockedUntil
    ? new Date(lockedVault.lockedUntil)
    : null;
  const remainingLockSeconds = lockedUntilMs ? Math.max(0, Math.ceil((lockedUntilMs - now) / 1_000)) : 0;
  // A recovery lock blocks further PIN guesses, but password-authorized key
  // reset remains available to someone who genuinely forgot the PIN.
  const isRateLimited = !resetMode && remainingLockSeconds > 0;
  const attemptsRemaining = lockedVault?.attemptsRemaining;
  const title = resetMode
    ? 'Reset encrypted messages?'
    : isSetup
      ? 'Set up encrypted messages'
      : 'Unlock encrypted messages';
  const description = resetMode
    ? 'Resetting starts a new encryption key. Messages encrypted with your old key will no longer open. This cannot be undone.'
    : isSetup
      ? isMigrationSetup
        ? 'Create a PIN for this node. A new encryption key will safely replace your previous node’s key; old encrypted history will remain unavailable here.'
        : 'Create a PIN to protect and restore your encrypted message history. You’ll enter it only on a new or cleared device. This PIN is separate from your login password.'
      : 'Enter your encrypted messages PIN to restore your history on this device. This is not your login password.';

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setLocalError(null);
    if (!/^\d{6,12}$/.test(pin)) {
      setLocalError('PIN must contain 6–12 digits.');
      return;
    }
    if ((isSetup || resetMode) && pin !== confirmation) {
      setLocalError('PINs don’t match. Try again.');
      return;
    }
    if (!props.identityUnlocked) {
      setLocalError('Your identity is locked. Sign in again before setting up encrypted messages.');
      return;
    }
    if (resetMode) {
      if (!understandsReset || !currentPassword) {
        setLocalError('Confirm the warning and enter your current login password.');
        return;
      }
      await props.onReset(pin, currentPassword).catch(() => undefined);
    } else if (isSetup) {
      await props.onSetup(pin).catch(() => undefined);
    } else {
      await props.onUnlock(pin).catch(() => undefined);
    }
  };

  return (
    <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24 }}>
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="e2ee-gate-title"
        aria-describedby="e2ee-gate-description"
        style={{
          width: '100%',
          maxWidth: 440,
          border: '1px solid var(--border)',
          borderRadius: 20,
          background: 'var(--background)',
          padding: 24,
          boxShadow: '0 18px 60px rgba(0,0,0,.28)',
        }}
      >
        <LockKeyhole size={30} aria-hidden="true" style={{ color: 'var(--accent)', marginBottom: 16 }} />
        <h1 id="e2ee-gate-title" style={{ fontSize: 22, margin: '0 0 10px' }}>{title}</h1>
        <p id="e2ee-gate-description" style={{ color: 'var(--foreground-secondary)', lineHeight: 1.5 }}>
          {description}
        </p>

        <form onSubmit={submit} aria-busy={props.busy} style={{ display: 'grid', gap: 14, marginTop: 20 }}>
          {resetMode && (
            <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', fontSize: 14 }}>
              <input
                type="checkbox"
                checked={understandsReset}
                onChange={(event) => setUnderstandsReset(event.target.checked)}
                style={{ marginTop: 3 }}
              />
              <span>I understand that my old encrypted message history will be unavailable.</span>
            </label>
          )}

          <label style={{ display: 'grid', gap: 6 }}>
            <span style={{ fontSize: 14, fontWeight: 600 }}>{resetMode ? 'New encrypted messages PIN' : 'Encrypted messages PIN'}</span>
            <div style={{ position: 'relative' }}>
              <input
                ref={pinRef}
                className="input"
                type={showPin ? 'text' : 'password'}
                inputMode="numeric"
                autoComplete={isSetup || resetMode ? 'new-password' : 'off'}
                minLength={6}
                maxLength={12}
                value={pin}
                onChange={(event) => setPin(event.target.value.replace(/\D/g, '').slice(0, 12))}
                aria-invalid={!!(localError || props.error)}
                aria-describedby="e2ee-pin-hint e2ee-gate-error"
                disabled={props.busy || isRateLimited}
                style={{ width: '100%', paddingRight: 48, fontSize: 16 }}
              />
              <button
                type="button"
                aria-label={showPin ? 'Hide PIN' : 'Show PIN'}
                onClick={() => setShowPin((value) => !value)}
                style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 0, color: 'var(--foreground-secondary)', minWidth: 36, minHeight: 36 }}
              >
                {showPin ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
            <span id="e2ee-pin-hint" style={{ fontSize: 12, color: 'var(--foreground-tertiary)' }}>6–12 digits; avoid birthdays and repeated or sequential numbers.</span>
          </label>

          {(isSetup || resetMode) && (
            <label style={{ display: 'grid', gap: 6 }}>
              <span style={{ fontSize: 14, fontWeight: 600 }}>Confirm PIN</span>
              <input
                className="input"
                type="password"
                inputMode="numeric"
                autoComplete="new-password"
                minLength={6}
                maxLength={12}
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value.replace(/\D/g, '').slice(0, 12))}
                disabled={props.busy}
                style={{ fontSize: 16 }}
              />
            </label>
          )}

          {resetMode && (
            <label style={{ display: 'grid', gap: 6 }}>
              <span style={{ fontSize: 14, fontWeight: 600 }}>Current login password</span>
              <input
                className="input"
                type="password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
                disabled={props.busy}
                style={{ fontSize: 16 }}
              />
            </label>
          )}

          {isRateLimited && (
            <p role="status" aria-live="polite" style={{ color: 'var(--destructive)', fontSize: 14, margin: 0 }}>
              Too many attempts. Try again in {formatCountdown(remainingLockSeconds)}
              {lockedUntil ? ` (${lockedUntil.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})` : ''}.
            </p>
          )}
          {!isSetup && !resetMode && !isRateLimited && typeof attemptsRemaining === 'number' && attemptsRemaining > 0 && (
            <p role="status" aria-live="polite" style={{ color: 'var(--foreground-secondary)', fontSize: 13, margin: 0 }}>
              {attemptsRemaining} {attemptsRemaining === 1 ? 'attempt' : 'attempts'} remaining before a temporary lock.
            </p>
          )}
          {(localError || props.error) && (
            <p id="e2ee-gate-error" role="alert" style={{ color: 'var(--destructive)', fontSize: 14, margin: 0 }}>
              {localError || props.error}
            </p>
          )}

          <button
            type="submit"
            className={resetMode ? 'btn btn-danger' : 'btn btn-primary'}
            disabled={props.busy || isRateLimited}
            style={{ justifyContent: 'center', minHeight: 44 }}
          >
            {props.busy ? <Loader2 size={18} className="animate-spin" aria-hidden="true" /> : null}
            {props.busy
              ? resetMode ? 'Resetting…' : isSetup ? 'Setting up…' : 'Unlocking…'
              : resetMode ? 'Reset encrypted messages' : isSetup ? 'Set up encrypted messages' : 'Unlock'}
          </button>

          {!isSetup && !resetMode && (
            <button type="button" className="btn btn-ghost" onClick={() => setResetMode(true)}>
              Forgot PIN?
            </button>
          )}
          {resetMode && (
            <button type="button" className="btn btn-ghost" onClick={() => setResetMode(false)}>
              Back to PIN
            </button>
          )}
          <button type="button" className="btn btn-ghost" onClick={props.onCancel}>Not now</button>
        </form>
      </section>
    </main>
  );
}
