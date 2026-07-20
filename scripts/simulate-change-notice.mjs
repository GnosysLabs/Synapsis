#!/usr/bin/env node

const DEFAULTS = Object.freeze({
  fanout: 3,
  relayRounds: 5,
  roundMs: 750,
  jitterMs: 250,
  minLinkMs: 25,
  maxLinkMs: 180,
  peerViewSize: 32,
  trials: 5,
});

class MinHeap {
  constructor() {
    this.items = [];
  }

  push(value) {
    const items = this.items;
    items.push(value);
    let index = items.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (items[parent].at <= value.at) break;
      items[index] = items[parent];
      index = parent;
    }
    items[index] = value;
  }

  pop() {
    const items = this.items;
    if (items.length === 0) return null;
    const first = items[0];
    const last = items.pop();
    if (items.length > 0 && last) {
      let index = 0;
      while (true) {
        const left = index * 2 + 1;
        const right = left + 1;
        if (left >= items.length) break;
        const child = right < items.length && items[right].at < items[left].at ? right : left;
        if (items[child].at >= last.at) break;
        items[index] = items[child];
        index = child;
      }
      items[index] = last;
    }
    return first;
  }

  get size() {
    return this.items.length;
  }
}

function mulberry32(seed) {
  let value = seed >>> 0;
  return () => {
    value += 0x6D2B79F5;
    let next = value;
    next = Math.imul(next ^ (next >>> 15), next | 1);
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
}

function randomInteger(random, minimum, maximum) {
  return minimum + Math.floor(random() * (maximum - minimum + 1));
}

function buildPeerViews(nodeCount, peerViewSize, random) {
  const boundedSize = Math.min(peerViewSize, nodeCount - 1);
  return Array.from({ length: nodeCount }, (_, node) => {
    const peers = new Set();
    // A successor keeps the generated overlay connected even at small sizes.
    peers.add((node + 1) % nodeCount);
    while (peers.size < boundedSize) {
      const candidate = randomInteger(random, 0, nodeCount - 1);
      if (candidate !== node) peers.add(candidate);
    }
    return [...peers];
  });
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function simulate(nodeCount, seed, options = DEFAULTS) {
  const random = mulberry32(seed);
  const peerViews = buildPeerViews(nodeCount, options.peerViewSize, random);
  const receivedAt = new Float64Array(nodeCount);
  receivedAt.fill(Number.POSITIVE_INFINITY);
  receivedAt[0] = 0;
  const contacted = Array.from({ length: nodeCount }, () => new Set());
  const outbound = new Uint16Array(nodeCount);
  const events = new MinHeap();
  let messages = 0;

  const scheduleRelayRounds = (node, firstSeenAt) => {
    for (let round = 0; round < options.relayRounds; round += 1) {
      events.push({
        at: firstSeenAt + round * options.roundMs + randomInteger(random, 0, options.jitterMs),
        kind: 'relay',
        node,
      });
    }
  };

  scheduleRelayRounds(0, 0);
  while (events.size > 0) {
    const event = events.pop();
    if (!event) break;
    if (event.kind === 'delivery') {
      if (receivedAt[event.node] !== Number.POSITIVE_INFINITY) continue;
      receivedAt[event.node] = event.at;
      scheduleRelayRounds(event.node, event.at);
      continue;
    }

    const available = peerViews[event.node].filter((peer) => !contacted[event.node].has(peer));
    for (let sent = 0; sent < options.fanout && available.length > 0; sent += 1) {
      const choice = randomInteger(random, 0, available.length - 1);
      const [target] = available.splice(choice, 1);
      contacted[event.node].add(target);
      outbound[event.node] += 1;
      messages += 1;
      events.push({
        at: event.at + randomInteger(random, options.minLinkMs, options.maxLinkMs),
        kind: 'delivery',
        node: target,
      });
    }
  }

  const latencies = [...receivedAt]
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  const reached = latencies.length;
  return {
    seed,
    nodes: nodeCount,
    reached,
    coverage: reached / nodeCount,
    p50Ms: percentile(latencies, 0.5),
    p95Ms: percentile(latencies, 0.95),
    p99Ms: percentile(latencies, 0.99),
    maxMs: latencies.at(-1) ?? null,
    messages,
    messagesPerNode: messages / nodeCount,
    originContacts: outbound[0],
    maxOutbound: Math.max(...outbound),
  };
}

function parseNodeCounts(argv) {
  const counts = argv
    .filter((value) => /^\d+$/.test(value))
    .map(Number)
    .filter((value) => value >= 2);
  return counts.length > 0 ? counts : [1_000, 10_000];
}

const results = [];
for (const nodes of parseNodeCounts(process.argv.slice(2))) {
  for (let trial = 0; trial < DEFAULTS.trials; trial += 1) {
    results.push(simulate(nodes, 0x51A7 + nodes * 17 + trial * 7919));
  }
}

const failures = results.filter((result) => (
  result.coverage !== 1
  || result.p99Ms === null
  || result.p99Ms > 10_000
  || result.originContacts > DEFAULTS.fanout * DEFAULTS.relayRounds
  || result.maxOutbound > DEFAULTS.fanout * DEFAULTS.relayRounds
));

console.log(JSON.stringify({
  protocol: DEFAULTS,
  acceptance: {
    coverage: '100% of online nodes',
    p99LatencyMs: 10_000,
    maxContactsPerNode: DEFAULTS.fanout * DEFAULTS.relayRounds,
  },
  results,
  passed: failures.length === 0,
}, null, 2));

if (failures.length > 0) process.exitCode = 1;

