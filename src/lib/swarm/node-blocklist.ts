import { db, swarmNodes } from '@/db';
import { and, eq, inArray } from 'drizzle-orm';

export function normalizeNodeDomain(domain: string): string {
  return domain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/^@/, '');
}

export async function isNodeBlocked(domain: string | null | undefined): Promise<boolean> {
  if (!db || !domain) return false;

  const normalized = normalizeNodeDomain(domain);
  if (!normalized) return false;

  const node = await db.query.swarmNodes.findFirst({
    where: eq(swarmNodes.domain, normalized),
    columns: {
      isBlocked: true,
    },
  });

  return Boolean(node?.isBlocked);
}

export async function getBlockedNodeDomains(): Promise<Set<string>> {
  if (!db) return new Set();

  const rows = await db.query.swarmNodes.findMany({
    where: eq(swarmNodes.isBlocked, true),
    columns: {
      domain: true,
    },
  });

  return new Set(rows.map((row) => row.domain));
}

export async function filterBlockedDomains(domains: string[]): Promise<string[]> {
  if (!db || domains.length === 0) return domains;

  const normalized = Array.from(new Set(domains.map(normalizeNodeDomain).filter(Boolean)));
  if (normalized.length === 0) return [];

  const blocked = await db.query.swarmNodes.findMany({
    where: and(
      inArray(swarmNodes.domain, normalized),
      eq(swarmNodes.isBlocked, true),
    ),
    columns: {
      domain: true,
    },
  });

  const blockedSet = new Set(blocked.map((row) => row.domain));
  return normalized.filter((domain) => !blockedSet.has(domain));
}

export async function upsertBlockedNode(domain: string, reason?: string | null) {
  if (!db) return null;

  const normalized = normalizeNodeDomain(domain);
  if (!normalized) return null;

  const existing = await db.query.swarmNodes.findFirst({
    where: eq(swarmNodes.domain, normalized),
  });

  if (existing) {
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

  const normalized = normalizeNodeDomain(domain);
  if (!normalized) return null;

  const existing = await db.query.swarmNodes.findFirst({
    where: eq(swarmNodes.domain, normalized),
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
