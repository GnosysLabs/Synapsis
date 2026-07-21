import { eq } from 'drizzle-orm';
import { db, users } from '@/db';
import type { StuffboxBadge } from '@/lib/types';
import { getBadgeAttestation } from '@/lib/stuffbox/client';
import { getStuffboxAccess, getStuffboxConnection } from '@/lib/stuffbox/tokens';
import {
  OFFICIAL_STUFFBOX_BADGE_ISSUER,
  stuffboxBadgeColumns,
  stuffboxBadgeFromStoredUser,
  verifyStuffboxBadgeAttestation,
} from '@/lib/stuffbox/badge';

const REFRESH_AHEAD_MS = 6 * 60 * 60 * 1000;
const refreshes = new Map<string, Promise<StuffboxBadge | null>>();

function hasSameBadgeEntitlement(
  cached: StuffboxBadge | null,
  refreshed: StuffboxBadge,
): cached is StuffboxBadge {
  return Boolean(cached
    && cached.level === refreshed.level
    && cached.plan === refreshed.plan
    && cached.issuer === refreshed.issuer);
}

export async function clearStuffboxBadge(userId: string): Promise<void> {
  await db.update(users).set(stuffboxBadgeColumns(null)).where(eq(users.id, userId));
}

export async function getOrRefreshStuffboxBadge(
  user: Pick<typeof users.$inferSelect, 'id' | 'handle' | 'stuffboxBadgeProof' | 'stuffboxBadgeLevel' | 'stuffboxBadgePlan' | 'stuffboxBadgeIssuer' | 'stuffboxBadgeExpiresAt'>,
  options: { force?: boolean } = {},
): Promise<StuffboxBadge | null> {
  const cached = stuffboxBadgeFromStoredUser(user);
  if (!options.force && cached && Date.parse(cached.expiresAt) > Date.now() + REFRESH_AHEAD_MS) {
    return cached;
  }
  const existing = refreshes.get(user.id);
  if (existing) return existing;
  const operation = (async () => {
    try {
      const connection = await getStuffboxConnection(user.id);
      if (!connection) {
        if (cached) await clearStuffboxBadge(user.id);
        return null;
      }
      const baseOrigin = new URL(connection.baseUrl).origin;
      if (baseOrigin !== OFFICIAL_STUFFBOX_BADGE_ISSUER && process.env.NODE_ENV === 'production') {
        await clearStuffboxBadge(user.id);
        return null;
      }
      const access = await getStuffboxAccess(user.id);
      const response = await getBadgeAttestation(access.baseUrl, access.accessToken);
      const badge = await verifyStuffboxBadgeAttestation(response.attestation, user.handle, {
        issuer: baseOrigin,
      });
      if (!badge) throw new Error('Stuffbox badge proof did not match this account');
      if (hasSameBadgeEntitlement(cached, badge)
        && Date.parse(cached.expiresAt) > Date.now() + REFRESH_AHEAD_MS) {
        return cached;
      }
      await db.update(users).set(stuffboxBadgeColumns(badge)).where(eq(users.id, user.id));
      return badge;
    } catch (error) {
      console.warn('Unable to refresh Stuffbox badge:', error);
      return cached;
    } finally {
      refreshes.delete(user.id);
    }
  })();
  refreshes.set(user.id, operation);
  return operation;
}
