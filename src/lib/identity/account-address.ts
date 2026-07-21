import { getCanonicalSwarmSeedDomain, normalizeNodeDomain } from '@/lib/swarm/node-domain';
import { localHandleSchema, nodeDomainSchema } from '@/lib/utils/federation';

export interface AccountAddress {
  username: string;
  homeDomain: string;
  canonical: string;
}

function cleanUsername(value: string): string | null {
  const username = value.trim().replace(/^@/, '').toLowerCase();
  return localHandleSchema.safeParse(username).success ? username : null;
}

function cleanDomain(value: string): string | null {
  const normalized = normalizeNodeDomain(value).replace(/\.$/, '');
  const homeDomain = getCanonicalSwarmSeedDomain(normalized) ?? normalized;
  return nodeDomainSchema.safeParse(homeDomain).success ? homeDomain : null;
}

/** Canonicalize a domain specifically for durable account identity. */
export function canonicalAccountHomeDomain(
  value: string | null | undefined,
): string | null {
  return value ? cleanDomain(value) : null;
}

/** Resolve a configured account domain or fail before identity data is written. */
export function requireCanonicalAccountHomeDomain(value: string): string {
  const domain = canonicalAccountHomeDomain(value);
  if (!domain) throw new Error(`Invalid account home domain: ${JSON.stringify(value)}`);
  return domain;
}

/** Parse the one canonical account-address form used by application code. */
export function parseAccountAddress(value: string): AccountAddress | null {
  const clean = value.trim().replace(/^@/, '').toLowerCase();
  const separator = clean.lastIndexOf('@');
  if (separator <= 0 || clean.indexOf('@') !== separator) return null;

  const username = cleanUsername(clean.slice(0, separator));
  const homeDomain = cleanDomain(clean.slice(separator + 1));
  if (!username || !homeDomain) return null;

  return {
    username,
    homeDomain,
    canonical: `${username}@${homeDomain}`,
  };
}

/**
 * Resolve a boundary value into a canonical account address. Bare usernames
 * are accepted only when the caller supplies the authoritative home node.
 */
export function resolveAccountAddress(
  value: string,
  fallbackHomeDomain?: string | null,
): AccountAddress | null {
  const parsed = parseAccountAddress(value);
  if (parsed) return parsed;

  const username = cleanUsername(value);
  const homeDomain = fallbackHomeDomain ? cleanDomain(fallbackHomeDomain) : null;
  if (!username || !homeDomain) return null;

  return {
    username,
    homeDomain,
    canonical: `${username}@${homeDomain}`,
  };
}

export function canonicalAccountAddress(
  value: string,
  fallbackHomeDomain?: string | null,
): string | null {
  return resolveAccountAddress(value, fallbackHomeDomain)?.canonical ?? null;
}

export function accountUsername(value: string): string | null {
  return parseAccountAddress(value)?.username ?? null;
}

export function accountHomeDomain(value: string): string | null {
  return parseAccountAddress(value)?.homeDomain ?? null;
}

export function isAccountOnNode(value: string, nodeDomain: string): boolean {
  const address = parseAccountAddress(value);
  const domain = cleanDomain(nodeDomain);
  return Boolean(address && domain && address.homeDomain === domain);
}

export function sameAccountAddress(left: string, right: string): boolean {
  const leftAddress = parseAccountAddress(left);
  const rightAddress = parseAccountAddress(right);
  return Boolean(leftAddress && rightAddress && leftAddress.canonical === rightAddress.canonical);
}

export function displayAccountAddress(value: string): string {
  const parsed = parseAccountAddress(value);
  return parsed ? `@${parsed.canonical}` : value.startsWith('@') ? value : `@${value}`;
}
