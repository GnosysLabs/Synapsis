import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchNodeInfo: vi.fn(),
  isNodeBlocked: vi.fn(),
}));

vi.mock('./discovery', () => ({
  fetchNodeInfo: mocks.fetchNodeInfo,
}));

vi.mock('./node-blocklist', () => ({
  isNodeBlocked: mocks.isNodeBlocked,
}));

import {
  clearTransientNodeProbeCache,
  probeTransientNode,
} from './transient-node-probe';

function node(domain: string) {
  return {
    domain,
    name: domain,
    publicKey: 'PUBLIC KEY',
    isNsfw: false,
  };
}

describe('transient public node probes', () => {
  beforeEach(() => {
    clearTransientNodeProbeCache();
    mocks.fetchNodeInfo.mockReset();
    mocks.isNodeBlocked.mockReset().mockResolvedValue(false);
  });

  it('shares and caches a probe while rechecking the blocklist', async () => {
    let finishProbe: ((value: ReturnType<typeof node>) => void) | undefined;
    mocks.fetchNodeInfo.mockImplementation(() => new Promise((resolve) => {
      finishProbe = resolve;
    }));

    const first = probeTransientNode('PEER.social');
    const second = probeTransientNode('https://peer.social/');
    await vi.waitFor(() => expect(mocks.fetchNodeInfo).toHaveBeenCalledTimes(1));
    finishProbe?.(node('peer.social'));

    await expect(Promise.all([first, second])).resolves.toEqual([
      node('peer.social'),
      node('peer.social'),
    ]);
    await expect(probeTransientNode('peer.social')).resolves.toEqual(node('peer.social'));
    expect(mocks.fetchNodeInfo).toHaveBeenCalledTimes(1);

    mocks.isNodeBlocked.mockResolvedValue(true);
    await expect(probeTransientNode('peer.social')).resolves.toBeNull();
    expect(mocks.fetchNodeInfo).toHaveBeenCalledTimes(1);
  });

  it('negative-caches an unavailable origin', async () => {
    mocks.fetchNodeInfo.mockResolvedValue(null);

    await expect(probeTransientNode('missing.social')).resolves.toBeNull();
    await expect(probeTransientNode('missing.social')).resolves.toBeNull();

    expect(mocks.fetchNodeInfo).toHaveBeenCalledTimes(1);
  });

  it('admits at most eight distinct first-contact probes at once', async () => {
    const finishers: Array<() => void> = [];
    mocks.fetchNodeInfo.mockImplementation((domain: string) => new Promise((resolve) => {
      finishers.push(() => resolve(node(domain)));
    }));

    const probes = Array.from({ length: 9 }, (_, index) => (
      probeTransientNode(`node${index}.social`)
    ));
    await vi.waitFor(() => expect(mocks.fetchNodeInfo).toHaveBeenCalledTimes(8));
    await expect(probes[8]).resolves.toBeNull();

    finishers.forEach((finish) => finish());
    await Promise.all(probes.slice(0, 8));
  });
});
