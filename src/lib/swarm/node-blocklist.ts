import { db, swarmNodes } from '@/db';
import { eq } from 'drizzle-orm';
import { getPublicSwarmDomain, normalizeNodeDomain } from './node-domain';
import { quarantineOriginContent } from './remote-access';

export { normalizeNodeDomain } from './node-domain';

function canonicalBlockedNodeDomain(value: string): string | null {
  const publicDomain = getPublicSwarmDomain(value);
  if (publicDomain) return publicDomain;

  const normalized = normalizeNodeDomain(value).replace(/\.$/, '');
  return process.env.NODE_ENV !== 'production'
    && /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i.test(normalized)
    ? normalized
    : null;
}

export async function isNodeBlocked(domain: string | null | undefined): Promise<boolean> {
  if (!db || !domain) return false;

  const normalized = canonicalBlockedNodeDomain(domain);
  if (!normalized) return false;

  const node = await db.query.swarmNodes.findFirst({
    where: { domain: normalized },
    columns: {
      isBlocked: true,
    },
  });

  return Boolean(node?.isBlocked);
}

export async function getBlockedNodeDomains(): Promise<Set<string>> {
  if (!db) return new Set();

  const rows = await db.query.swarmNodes.findMany({
    where: { isBlocked: true },
    columns: {
      domain: true,
    },
  });

  return new Set(rows.map((row) => row.domain));
}

export async function filterBlockedDomains(domains: string[]): Promise<string[]> {
  if (!db || domains.length === 0) return domains;

  const normalized = Array.from(new Set(
    domains
      .map(canonicalBlockedNodeDomain)
      .filter((domain): domain is string => Boolean(domain)),
  ));
  if (normalized.length === 0) return [];

  const blocked = await db.query.swarmNodes.findMany({
    where: { AND: [{ domain: { in: normalized } }, { isBlocked: true }] },
    columns: {
      domain: true,
    },
  });

  const blockedSet = new Set(blocked.map((row) => row.domain));
  return normalized.filter((domain) => !blockedSet.has(domain));
}

export async function upsertBlockedNode(domain: string, reason?: string | null) {
  if (!db) return null;

  const normalized = canonicalBlockedNodeDomain(domain);
  if (!normalized) return null;

  const existing = await db.query.swarmNodes.findFirst({
    where: { domain: normalized },
  });

  if (existing) {
    await quarantineOriginContent(normalized);
    const [updated] = await db.update(swarmNodes)
      .set({
        isBlocked: true,
        blockReason: reason || null,
        blockedAt: new Date(),
        isActive: false,
        updatedAt: new Date(),
      })
      .where(eq(swarmNodes.id, existing.id))
      .returning();

    return updated;
  }

  await quarantineOriginContent(normalized);
  const [created] = await db.insert(swarmNodes)
    .values({
      domain: normalized,
      isBlocked: true,
      blockReason: reason || null,
      blockedAt: new Date(),
      isActive: false,
      trustScore: 0,
    })
    .returning();

  return created;
}

export async function unblockNode(domain: string) {
  if (!db) return null;

  const normalized = canonicalBlockedNodeDomain(domain);
  if (!normalized) return null;

  const existing = await db.query.swarmNodes.findFirst({
    where: { domain: normalized },
  });

  if (!existing) return null;

  const [updated] = await db.update(swarmNodes)
    .set({
      isBlocked: false,
      blockReason: null,
      blockedAt: null,
      updatedAt: new Date(),
    })
    .where(eq(swarmNodes.id, existing.id))
    .returning();

  return updated;
}
