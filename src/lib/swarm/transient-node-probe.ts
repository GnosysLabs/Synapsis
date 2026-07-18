import type { SwarmNodeInfo } from './types';
import { fetchNodeInfo } from './discovery';
import { isNodeBlocked } from './node-blocklist';
import { getPublicSwarmDomain } from './node-domain';

const POSITIVE_PROBE_TTL_MS = 5 * 60 * 1_000;
const NEGATIVE_PROBE_TTL_MS = 30 * 1_000;
const MAX_CACHED_TRANSIENT_PROBES = 500;
const MAX_CONCURRENT_TRANSIENT_PROBES = 8;

interface TransientProbeCacheEntry {
  info: SwarmNodeInfo | null;
  expiresAt: number;
}

const transientProbeCache = new Map<string, TransientProbeCacheEntry>();
const pendingTransientProbes = new Map<string, Promise<SwarmNodeInfo | null>>();
let activeTransientProbes = 0;

function readCachedProbe(domain: string, now: number): SwarmNodeInfo | null | undefined {
  const cached = transientProbeCache.get(domain);
  if (!cached) return undefined;
  if (cached.expiresAt <= now) {
    transientProbeCache.delete(domain);
    return undefined;
  }

  // Refresh insertion order so a small set of legitimate hot origins cannot
  // be displaced by a stream of one-off hostile domains.
  transientProbeCache.delete(domain);
  transientProbeCache.set(domain, cached);
  return cached.info;
}

function cacheProbe(domain: string, info: SwarmNodeInfo | null): void {
  if (!transientProbeCache.has(domain)
    && transientProbeCache.size >= MAX_CACHED_TRANSIENT_PROBES) {
    const oldestDomain = transientProbeCache.keys().next().value as string | undefined;
    if (oldestDomain) transientProbeCache.delete(oldestDomain);
  }

  transientProbeCache.delete(domain);
  transientProbeCache.set(domain, {
    info,
    expiresAt: Date.now() + (info ? POSITIVE_PROBE_TTL_MS : NEGATIVE_PROBE_TTL_MS),
  });
}

/**
 * Verify a user-supplied read target without enrolling it in the swarm.
 *
 * Public read routes share per-origin work and a small global first-contact
 * pool. Administrative and background discovery deliberately continue to use
 * fetchNodeInfo/discoverNode directly and are not charged to this pool.
 */
export async function probeTransientNode(domainInput: string): Promise<SwarmNodeInfo | null> {
  const domain = getPublicSwarmDomain(domainInput);
  if (!domain || await isNodeBlocked(domain)) return null;

  const cached = readCachedProbe(domain, Date.now());
  if (cached !== undefined) return cached;

  const pending = pendingTransientProbes.get(domain);
  if (pending) return pending;
  if (activeTransientProbes >= MAX_CONCURRENT_TRANSIENT_PROBES) return null;

  activeTransientProbes += 1;
  const operation = (async () => {
    const info = await fetchNodeInfo(domain);
    if (await isNodeBlocked(domain)) {
      transientProbeCache.delete(domain);
      return null;
    }
    cacheProbe(domain, info);
    return info;
  })();
  pendingTransientProbes.set(domain, operation);

  try {
    return await operation;
  } finally {
    activeTransientProbes -= 1;
    if (pendingTransientProbes.get(domain) === operation) {
      pendingTransientProbes.delete(domain);
    }
  }
}

export function clearTransientNodeProbeCache(): void {
  transientProbeCache.clear();
}
