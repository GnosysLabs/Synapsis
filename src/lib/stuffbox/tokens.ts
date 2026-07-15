import { eq } from 'drizzle-orm';
import { db, stuffboxConnections } from '@/db';
import { openStuffboxSecret, sealStuffboxSecret } from './crypto';
import { refreshTokens, type StuffboxApiError } from './client';
import type { StuffboxTokenSet } from './types';

const refreshes = new Map<string, Promise<{ baseUrl: string; accessToken: string }>>();

function encrypted(token: string, userId: string, kind: 'access' | 'refresh'): string {
  return sealStuffboxSecret(token, `stuffbox:${userId}:${kind}`);
}

function decrypted(token: string, userId: string, kind: 'access' | 'refresh'): string {
  return openStuffboxSecret(token, `stuffbox:${userId}:${kind}`);
}

export async function saveStuffboxTokens(
  userId: string,
  baseUrl: string,
  tokens: StuffboxTokenSet,
): Promise<void> {
  const now = Date.now();
  const values = {
    userId,
    baseUrl,
    accessTokenEncrypted: encrypted(tokens.accessToken, userId, 'access'),
    accessTokenExpiresAt: new Date(now + tokens.expiresIn * 1000),
    refreshTokenEncrypted: encrypted(tokens.refreshToken, userId, 'refresh'),
    refreshTokenExpiresAt: tokens.refreshTokenExpiresIn
      ? new Date(now + tokens.refreshTokenExpiresIn * 1000)
      : null,
    scopes: JSON.stringify(tokens.scopes),
    updatedAt: new Date(),
  };
  await db.insert(stuffboxConnections).values(values).onConflictDoUpdate({
    target: stuffboxConnections.userId,
    set: values,
  });
}

export async function getStuffboxAccess(userId: string): Promise<{ baseUrl: string; accessToken: string }> {
  const connection = await db.query.stuffboxConnections.findFirst({ where: { userId } });
  if (!connection) throw new Error('STUFFBOX_NOT_CONNECTED');

  if (connection.accessTokenExpiresAt.getTime() > Date.now() + 60_000) {
    return {
      baseUrl: connection.baseUrl,
      accessToken: decrypted(connection.accessTokenEncrypted, userId, 'access'),
    };
  }

  const existing = refreshes.get(userId);
  if (existing) return existing;

  const operation = (async () => {
    try {
      const refreshToken = decrypted(connection.refreshTokenEncrypted, userId, 'refresh');
      const tokens = await refreshTokens(connection.baseUrl, refreshToken);
      await saveStuffboxTokens(userId, connection.baseUrl, tokens);
      return { baseUrl: connection.baseUrl, accessToken: tokens.accessToken };
    } catch (error) {
      const apiError = error as StuffboxApiError;
      if (apiError?.status === 401 || apiError?.code === 'refresh_token_reuse') {
        await db.delete(stuffboxConnections).where(eq(stuffboxConnections.userId, userId));
      }
      throw error;
    } finally {
      refreshes.delete(userId);
    }
  })();
  refreshes.set(userId, operation);
  return operation;
}

export async function getStuffboxConnection(userId: string) {
  return db.query.stuffboxConnections.findFirst({ where: { userId } });
}

export async function removeStuffboxConnection(userId: string): Promise<void> {
  await db.delete(stuffboxConnections).where(eq(stuffboxConnections.userId, userId));
}

export function readStuffboxRefreshToken(connection: typeof stuffboxConnections.$inferSelect): string {
  return decrypted(connection.refreshTokenEncrypted, connection.userId, 'refresh');
}
