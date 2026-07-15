import { parse } from 'tldts';

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

