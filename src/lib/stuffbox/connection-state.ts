import { cookies } from 'next/headers';
import { openStuffboxSecret, sealStuffboxSecret } from './crypto';

const COOKIE_NAME = 'synapsis_stuffbox_connect';
const CONTEXT = 'stuffbox-connection-state';

export interface StuffboxConnectionState {
  userId: string;
  baseUrl: string;
  verifier: string;
  state: string;
  redirectUri: string;
  expiresAt: number;
}

export async function saveStuffboxConnectionState(value: StuffboxConnectionState): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(COOKIE_NAME, sealStuffboxSecret(JSON.stringify(value), CONTEXT), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/api/storage/stuffbox/callback',
    expires: new Date(value.expiresAt),
  });
}

export async function consumeStuffboxConnectionState(): Promise<StuffboxConnectionState | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(COOKIE_NAME)?.value;
  cookieStore.delete(COOKIE_NAME);
  if (!token) return null;
  try {
    const value = JSON.parse(openStuffboxSecret(token, CONTEXT)) as StuffboxConnectionState;
    return value.expiresAt > Date.now() ? value : null;
  } catch {
    return null;
  }
}
