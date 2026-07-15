import { cookies } from 'next/headers';
import { openStuffboxSecret, sealStuffboxSecret } from './crypto';

const COOKIE_NAME = 'synapsis_stuffbox_connect';
const CONTEXT = 'stuffbox-connection-state';

export interface StuffboxConnectionState {
  userId: string;
  baseUrl: string;
  clientId: string;
  verifier: string;
  state: string;
  callbackUrl: string;
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
    const value = JSON.parse(openStuffboxSecret(token, CONTEXT)) as Partial<StuffboxConnectionState>;
    if (
      typeof value.userId !== 'string'
      || typeof value.baseUrl !== 'string'
      || typeof value.clientId !== 'string'
      || typeof value.verifier !== 'string'
      || typeof value.state !== 'string'
      || typeof value.callbackUrl !== 'string'
      || typeof value.expiresAt !== 'number'
      || value.expiresAt <= Date.now()
    ) {
      return null;
    }
    return value as StuffboxConnectionState;
  } catch {
    return null;
  }
}
