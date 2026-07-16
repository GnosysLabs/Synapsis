'use client';

import { useEffect, useRef, useState } from 'react';
import { Eye, EyeOff, Loader2, LockKeyhole } from 'lucide-react';

import type { E2EEIdentityState } from '@/lib/e2ee/use-e2ee-identity';

interface E2EEChatGateProps {
  state: E2EEIdentityState;
  busy: boolean;
  error: string | null;
  identityUnlocked: boolean;
  onSetup: (password: string) => Promise<void>;
  onUnlock: (password: string) => Promise<void>;
  onMigrate: (password: string, legacyPin?: string) => Promise<void>;
  onReset: (currentPassword: string) => Promise<void>;
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
  const [password, setPassword] = useState('');
  const [legacyPin, setLegacyPin] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [resetMode, setResetMode] = useState(false);
  const [understandsReset, setUnderstandsReset] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const passwordRef = useRef<HTMLInputElement>(null);

  const vault = props.state.status === 'locked' || props.state.status === 'migration_required'
    ? props.state.vault
    : null;
  const isSetup = props.state.status === 'setup_required';
  const isLegacy = vault?.recoveryMethod === 'legacy_pin';
  const hasRememberedLegacyKey = props.state.status === 'migration_required';
  const lockedUntilMs = vault?.lockedUntil ? new Date(vault.lockedUntil).getTime() : null;

  useEffect(() => {
    if (isSetup || vault) passwordRef.current?.focus();
  }, [isSetup, vault, resetMode]);

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
      } else onCancel();
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

  const lockedUntil = vault?.lockedUntil ? new Date(vault.lockedUntil) : null;
  const remainingLockSeconds = lockedUntilMs ? Math.max(0, Math.ceil((lockedUntilMs - now) / 1_000)) : 0;
  const isRateLimited = !resetMode && !hasRememberedLegacyKey && remainingLockSeconds > 0;
  const title = resetMode
    ? 'Start encrypted messages fresh?'
    : isLegacy ? 'Finish removing your chat PIN'
      : isSetup ? 'Set up encrypted messages' : 'Unlock encrypted messages';
  const description = resetMode
    ? 'This creates a new encryption key. Messages encrypted with the old key will no longer open, and this cannot be undone.'
    : isLegacy
      ? hasRememberedLegacyKey
        ? 'Enter your account password once. Your remembered chat key will be switched to password recovery without losing history.'
        : 'Enter your old chat PIN one last time plus your account password. After this, there is no separate chat PIN.'
      : isSetup
        ? 'Encrypted messages will use your account password for recovery on a new device. This device will stay unlocked.'
        : 'Enter the same password you use to sign in. Recognized devices open encrypted messages automatically.';

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setLocalError(null);
    if (password.length < 8) {
      setLocalError('Enter your account password.');
      return;
    }
    if (isLegacy && !hasRememberedLegacyKey && !resetMode && !/^\d{6,12}$/.test(legacyPin)) {
      setLocalError('Enter your previous 6–12 digit chat PIN.');
      return;
    }
    if (!props.identityUnlocked) {
      setLocalError('Your identity is locked. Sign in again before opening encrypted messages.');
      return;
    }
    if (resetMode) {
      if (!understandsReset) {
        setLocalError('Confirm that you understand the old history will be unavailable.');
        return;
      }
      await props.onReset(password).catch(() => undefined);
    } else if (isLegacy) {
      await props.onMigrate(password, hasRememberedLegacyKey ? undefined : legacyPin).catch(() => undefined);
    } else if (isSetup) await props.onSetup(password).catch(() => undefined);
    else await props.onUnlock(password).catch(() => undefined);
  };

  return (
    <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24 }}>
      <section role="dialog" aria-modal="true" aria-labelledby="e2ee-gate-title" aria-describedby="e2ee-gate-description" style={{
        width: '100%', maxWidth: 440, border: '1px solid var(--border)', borderRadius: 20,
        background: 'var(--background)', padding: 24, boxShadow: '0 18px 60px rgba(0,0,0,.28)',
      }}>
        <LockKeyhole size={30} aria-hidden="true" style={{ color: 'var(--accent)', marginBottom: 16 }} />
        <h1 id="e2ee-gate-title" style={{ fontSize: 22, margin: '0 0 10px' }}>{title}</h1>
        <p id="e2ee-gate-description" style={{ color: 'var(--foreground-secondary)', lineHeight: 1.5 }}>{description}</p>

        <form onSubmit={submit} aria-busy={props.busy} style={{ display: 'grid', gap: 14, marginTop: 20 }}>
          {resetMode && (
            <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', fontSize: 14 }}>
              <input type="checkbox" checked={understandsReset} onChange={(event) => setUnderstandsReset(event.target.checked)} style={{ marginTop: 3 }} />
              <span>I understand that my old encrypted message history will be unavailable.</span>
            </label>
          )}

          {isLegacy && !hasRememberedLegacyKey && !resetMode && (
            <label style={{ display: 'grid', gap: 6 }}>
              <span style={{ fontSize: 14, fontWeight: 600 }}>Previous chat PIN</span>
              <input className="input" type="password" inputMode="numeric" autoComplete="off" minLength={6} maxLength={12}
                value={legacyPin} onChange={(event) => setLegacyPin(event.target.value.replace(/\D/g, '').slice(0, 12))}
                disabled={props.busy || isRateLimited} style={{ fontSize: 16 }} />
            </label>
          )}

          <label style={{ display: 'grid', gap: 6 }}>
            <span style={{ fontSize: 14, fontWeight: 600 }}>Account password</span>
            <div style={{ position: 'relative' }}>
              <input ref={passwordRef} className="input" type={showPassword ? 'text' : 'password'} autoComplete="current-password"
                minLength={8} maxLength={256} value={password} onChange={(event) => setPassword(event.target.value)}
                aria-invalid={!!(localError || props.error)} aria-describedby="e2ee-gate-error"
                disabled={props.busy || isRateLimited} style={{ width: '100%', paddingRight: 48, fontSize: 16 }} />
              <button type="button" aria-label={showPassword ? 'Hide password' : 'Show password'} onClick={() => setShowPassword((value) => !value)}
                style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 0, color: 'var(--foreground-secondary)', minWidth: 36, minHeight: 36 }}>
                {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
          </label>

          {isRateLimited && <p role="status" aria-live="polite" style={{ color: 'var(--destructive)', fontSize: 14, margin: 0 }}>
            Too many attempts. Try again in {formatCountdown(remainingLockSeconds)}
            {lockedUntil ? ` (${lockedUntil.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})` : ''}.
          </p>}
          {!isSetup && !resetMode && !isRateLimited && !hasRememberedLegacyKey && typeof vault?.attemptsRemaining === 'number' && vault.attemptsRemaining > 0 && (
            <p role="status" aria-live="polite" style={{ color: 'var(--foreground-secondary)', fontSize: 13, margin: 0 }}>
              {vault.attemptsRemaining} {vault.attemptsRemaining === 1 ? 'attempt' : 'attempts'} remaining before a temporary lock.
            </p>
          )}
          {(localError || props.error) && <p id="e2ee-gate-error" role="alert" style={{ color: 'var(--destructive)', fontSize: 14, margin: 0 }}>{localError || props.error}</p>}

          <button type="submit" className={resetMode ? 'btn btn-danger' : 'btn btn-primary'} disabled={props.busy || isRateLimited} style={{ justifyContent: 'center', minHeight: 44 }}>
            {props.busy ? <Loader2 size={18} className="animate-spin" aria-hidden="true" /> : null}
            {props.busy ? 'Working…' : resetMode ? 'Start fresh' : isLegacy ? 'Remove chat PIN' : isSetup ? 'Set up encrypted messages' : 'Unlock'}
          </button>

          {isLegacy && !resetMode && <button type="button" className="btn btn-ghost" onClick={() => setResetMode(true)}>I no longer have the old PIN</button>}
          {resetMode && <button type="button" className="btn btn-ghost" onClick={() => setResetMode(false)}>Keep my message history</button>}
          <button type="button" className="btn btn-ghost" onClick={props.onCancel}>Not now</button>
        </form>
      </section>
    </main>
  );
}
