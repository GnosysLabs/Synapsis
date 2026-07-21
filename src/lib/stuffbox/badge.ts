import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from 'jose';
import { z } from 'zod';
import type { StuffboxBadge } from '@/lib/types';
import { resolveAccountAddress } from '@/lib/identity/account-address';
import { safeFederationRequest } from '@/lib/swarm/safe-federation-http';

export const OFFICIAL_STUFFBOX_BADGE_ISSUER = 'https://stuffbox.xyz';
const BADGE_AUDIENCE = 'synapsis';
const BADGE_KEY_ID = 'stuffbox-badge-v1';
const BADGE_MAX_BYTES = 8 * 1024;
const BADGE_MAX_LIFETIME_SECONDS = 24 * 60 * 60;
const BADGE_CLOCK_SKEW_SECONDS = 5 * 60;
const badgePlans = ['free', 'mini', 'personal', 'plus', 'power', 'max', 'ultra'] as const;

const jwksSchema = z.object({
  keys: z.array(z.object({
    kty: z.literal('OKP'),
    crv: z.literal('Ed25519'),
    x: z.string().min(32).max(128),
    kid: z.literal(BADGE_KEY_ID),
    use: z.literal('sig'),
    alg: z.literal('EdDSA'),
  }).passthrough()).min(1).max(4),
});

type StoredStuffboxBadge = {
  stuffboxBadgeProof?: string | null;
  stuffboxBadgeLevel?: string | null;
  stuffboxBadgePlan?: string | null;
  stuffboxBadgeIssuer?: string | null;
  stuffboxBadgeExpiresAt?: Date | string | null;
};

let cachedJwks: { value: JSONWebKeySet; expiresAt: number } | null = null;

async function officialJwks(): Promise<JSONWebKeySet> {
  if (cachedJwks && cachedJwks.expiresAt > Date.now()) return cachedJwks.value;
  const response = await safeFederationRequest(
    `${OFFICIAL_STUFFBOX_BADGE_ISSUER}/api/v1/badge/jwks`,
    {
      headers: { Accept: 'application/json' },
      timeoutMs: 5_000,
      maxResponseBytes: 16 * 1024,
    },
  );
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Stuffbox badge key request failed (${response.status})`);
  }
  const parsed = jwksSchema.safeParse(response.json());
  if (!parsed.success) throw new Error('Stuffbox returned an invalid badge verification key');
  cachedJwks = { value: parsed.data as JSONWebKeySet, expiresAt: Date.now() + 60 * 60 * 1000 };
  return cachedJwks.value;
}

export async function verifyStuffboxBadgeAttestation(
  attestation: string,
  expectedHandle: string,
  options: { jwks?: JSONWebKeySet; issuer?: string; now?: Date } = {},
): Promise<StuffboxBadge | null> {
  if (!attestation || Buffer.byteLength(attestation, 'utf8') > BADGE_MAX_BYTES) return null;
  const expectedAddress = resolveAccountAddress(expectedHandle);
  if (!expectedAddress) return null;
  const issuer = options.issuer ?? OFFICIAL_STUFFBOX_BADGE_ISSUER;
  if (issuer !== OFFICIAL_STUFFBOX_BADGE_ISSUER && process.env.NODE_ENV === 'production') return null;
  try {
    const jwks = options.jwks ?? await officialJwks();
    const verified = await jwtVerify(attestation, createLocalJWKSet(jwks), {
      algorithms: ['EdDSA'],
      audience: BADGE_AUDIENCE,
      issuer,
      currentDate: options.now,
      clockTolerance: BADGE_CLOCK_SKEW_SECONDS,
    });
    if (verified.protectedHeader.kid !== BADGE_KEY_ID) return null;
    const { payload } = verified;
    const subject = typeof payload.sub === 'string' ? resolveAccountAddress(payload.sub) : null;
    const level = payload.level;
    const plan = payload.plan;
    if (!subject || subject.canonical !== expectedAddress.canonical) return null;
    if (level !== 'connected' && level !== 'supporter') return null;
    if (typeof plan !== 'string' || !badgePlans.includes(plan as typeof badgePlans[number])) return null;
    if ((plan === 'free') !== (level === 'connected')) return null;
    if (!Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp)) return null;
    if ((payload.exp as number) <= (payload.iat as number)) return null;
    if ((payload.exp as number) - (payload.iat as number) > BADGE_MAX_LIFETIME_SECONDS) return null;
    return {
      level,
      plan: plan as StuffboxBadge['plan'],
      issuer,
      attestation,
      expiresAt: new Date((payload.exp as number) * 1000).toISOString(),
    };
  } catch {
    return null;
  }
}

export function stuffboxBadgeFromStoredUser(
  user: StoredStuffboxBadge,
  now = Date.now(),
): StuffboxBadge | null {
  const expiresAt = user.stuffboxBadgeExpiresAt instanceof Date
    ? user.stuffboxBadgeExpiresAt
    : user.stuffboxBadgeExpiresAt
      ? new Date(user.stuffboxBadgeExpiresAt)
      : null;
  if (!user.stuffboxBadgeProof
    || !expiresAt
    || !Number.isFinite(expiresAt.getTime())
    || expiresAt.getTime() <= now
    || (user.stuffboxBadgeLevel !== 'connected' && user.stuffboxBadgeLevel !== 'supporter')
    || !badgePlans.includes(user.stuffboxBadgePlan as typeof badgePlans[number])
    || !user.stuffboxBadgeIssuer) {
    return null;
  }
  return {
    level: user.stuffboxBadgeLevel,
    plan: user.stuffboxBadgePlan as StuffboxBadge['plan'],
    issuer: user.stuffboxBadgeIssuer,
    attestation: user.stuffboxBadgeProof,
    expiresAt: expiresAt.toISOString(),
  };
}

export function stuffboxBadgeColumns(badge: StuffboxBadge | null) {
  return badge ? {
    stuffboxBadgeProof: badge.attestation,
    stuffboxBadgeLevel: badge.level,
    stuffboxBadgePlan: badge.plan,
    stuffboxBadgeIssuer: badge.issuer,
    stuffboxBadgeExpiresAt: new Date(badge.expiresAt),
  } : {
    stuffboxBadgeProof: null,
    stuffboxBadgeLevel: null,
    stuffboxBadgePlan: null,
    stuffboxBadgeIssuer: null,
    stuffboxBadgeExpiresAt: null,
  };
}

export function attachStoredStuffboxBadgesToPost<T>(post: T): T {
  if (!post || typeof post !== 'object' || Array.isArray(post)) return post;
  const record = post as Record<string, unknown>;
  const author = record.author && typeof record.author === 'object' && !Array.isArray(record.author)
    ? record.author as Record<string, unknown>
    : null;
  const next: Record<string, unknown> = { ...record };
  if (author) {
    next.author = {
      ...author,
      stuffboxBadge: author.stuffboxBadge
        || stuffboxBadgeFromStoredUser(author as StoredStuffboxBadge),
    };
  }
  for (const relation of ['repostOf', 'replyTo'] as const) {
    if (relation in record) {
      next[relation] = record[relation]
        ? attachStoredStuffboxBadgesToPost(record[relation])
        : record[relation];
    }
  }
  return next as T;
}

export async function verifyStuffboxBadgeOnPost<T>(post: T): Promise<T> {
  if (!post || typeof post !== 'object' || Array.isArray(post)) return post;
  const record = post as Record<string, unknown>;
  const author = record.author && typeof record.author === 'object' && !Array.isArray(record.author)
    ? record.author as Record<string, unknown>
    : null;
  const candidateBadge = author?.stuffboxBadge && typeof author.stuffboxBadge === 'object'
    ? author.stuffboxBadge as Record<string, unknown>
    : null;
  const badge = author
    && typeof author.handle === 'string'
    && typeof candidateBadge?.attestation === 'string'
      ? await verifyStuffboxBadgeAttestation(candidateBadge.attestation, author.handle)
      : null;
  const next: Record<string, unknown> = { ...record };
  if (author) next.author = { ...author, stuffboxBadge: badge };
  if (Array.isArray(record.repostedBy)) {
    next.repostedBy = await Promise.all(record.repostedBy.slice(0, 20).map(async (value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
      const reposter = value as Record<string, unknown>;
      const reposterCandidate = reposter.stuffboxBadge
        && typeof reposter.stuffboxBadge === 'object'
        && !Array.isArray(reposter.stuffboxBadge)
          ? reposter.stuffboxBadge as Record<string, unknown>
          : null;
      const reposterBadge = typeof reposter.handle === 'string'
        && typeof reposterCandidate?.attestation === 'string'
          ? await verifyStuffboxBadgeAttestation(reposterCandidate.attestation, reposter.handle)
          : null;
      return { ...reposter, stuffboxBadge: reposterBadge };
    }));
  }
  await Promise.all((['repostOf', 'replyTo'] as const).map(async (relation) => {
    if (relation in record) {
      next[relation] = record[relation]
        ? await verifyStuffboxBadgeOnPost(record[relation])
        : record[relation];
    }
  }));
  return next as T;
}
