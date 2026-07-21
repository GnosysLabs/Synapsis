import { parse } from 'tldts';

const LEGACY_SWARM_SEED_DOMAINS: Readonly<Record<string, string>> = {
  'node.synapsis.social': 'synapsis.social',
};

export function normalizeNodeDomain(domain: string): string {
  return domain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/^@/, '');
}

/**
 * Return the canonical host for a publicly addressable swarm node.
 *
 * The swarm is a public network, so local development hosts, IP addresses,
 * special-use names, and made-up TLDs must never enter the node registry.
 * Ports are retained because a public hostname may intentionally expose
 * Synapsis on a non-standard port.
 */
export function getPublicSwarmDomain(value: string | null | undefined): string | null {
  if (!value) return null;

  const normalized = normalizeNodeDomain(value);
  if (!normalized) return null;

  try {
    const url = new URL(`https://${normalized}`);
    if (url.username || url.password) return null;

    const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
    const result = parse(hostname, {
      allowPrivateDomains: false,
      detectSpecialUse: true,
    });

    if (
      !result.domain ||
      result.isIcann !== true ||
      result.isIp ||
      result.isSpecialUse
    ) {
      return null;
    }

    return url.port ? `${hostname}:${url.port}` : hostname;
  } catch {
    return null;
  }
}

export function isPublicSwarmDomain(value: string | null | undefined): boolean {
  return getPublicSwarmDomain(value) !== null;
}

export function resolveNodeAssetUrl(
  value: string | null | undefined,
  nodeDomain: string
): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;

  try {
    const resolved = new URL(trimmed, `https://${normalizeNodeDomain(nodeDomain)}`);
    return resolved.protocol === 'http:' || resolved.protocol === 'https:'
      ? resolved.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve retired bootstrap hostnames to the node identity they represent.
 * This keeps upgraded nodes working even before their persisted seed rows are
 * rewritten by the accompanying data migration.
 */
export function getCanonicalSwarmSeedDomain(value: string | null | undefined): string | null {
  const domain = getPublicSwarmDomain(value);
  if (!domain) return null;

  return LEGACY_SWARM_SEED_DOMAINS[domain] ?? domain;
}

/** Hosts that may still store or advertise the same canonical seed identity. */
export function getSwarmSeedDomainAliases(value: string): string[] {
  const canonical = getCanonicalSwarmSeedDomain(value);
  if (!canonical) return [];
  return [
    canonical,
    ...Object.entries(LEGACY_SWARM_SEED_DOMAINS)
      .filter(([, replacement]) => replacement === canonical)
      .map(([alias]) => alias),
  ];
}
