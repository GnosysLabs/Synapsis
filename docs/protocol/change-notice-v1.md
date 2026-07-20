# ChangeNoticeV1

Status: implemented. Nodes must keep periodic content polling enabled.

## Purpose

`ChangeNoticeV1` is a small, signed wake-up. It never contains post content and
never makes a relay authoritative. A receiver that accepts a notice pulls an
origin-signed `ChangeBundleV1` from the authenticated relay that woke it. A
small set of direct recipients fetches from the origin and seeds those relay
caches. Periodic direct polling remains the recovery path.

## Origin-signed notice

```json
{
  "type": "ChangeNotice",
  "version": 1,
  "origin": "example.social",
  "cursor": 1234,
  "issuedAt": "2026-07-20T20:00:00.000Z",
  "expiresAt": "2026-07-20T20:02:00.000Z"
}
```

The detached `signature` is RSA-SHA256 over Synapsis canonical JSON for the
object above. `(origin, cursor)` is the notice identity. Relays forward the
notice and origin signature unchanged.

Rules:

- `origin` is a normalized public ICANN domain already established directly by
  the receiver. Relayed discovery hints cannot establish an origin or its key.
- `cursor` is a positive safe integer from the origin's monotonic content
  change stream.
- `issuedAt` may be at most 30 seconds in the future.
- `expiresAt` must be after `issuedAt`, no more than 120 seconds later, and not
  more than 30 seconds expired. This small skew allowance does not extend relay
  eligibility: workers stop forwarding at `expiresAt`.
- The signature must verify against the receiver's pinned key for `origin`.
- A cursor is accepted only when it is strictly greater than the receiver's
  durable highest accepted cursor for that origin. Duplicate and lower cursors
  are acknowledged but cause no pull and no new relay wave.
- Blocked, unknown, malformed, stale, or falsely signed origins are rejected.

Acceptance grants no content authority. A receiver verifies content against
the origin's pinned key and applies all existing content, identity, moderation,
size, and cache limits regardless of which relay transported it.

## Relay batch

Relays exchange a bounded envelope:

```json
{
  "version": 1,
  "sender": "relay.social",
  "timestamp": "2026-07-20T20:00:01.000Z",
  "notices": [
    { "notice": { "type": "ChangeNotice", "version": 1 }, "signature": "..." }
  ]
}
```

The example truncates the notice only for readability; the transmitted notice
has every field from the origin-signed shape. The relay adds a detached
RSA-SHA256 signature over the complete envelope. The receiver authenticates the
relay before parsing at most 50 notices in at most 64 KiB. Each accepted notice
is then independently authenticated against its origin key.

Each newly accepted cursor receives at most five relay rounds. A round selects
up to three established, unblocked peers not already selected for that cursor.
The worker sends all due notices in one batch, so activity from many origins is
coalesced into the same three requests. A node therefore contacts at most 15
peers for one cursor and an origin never contacts the whole network.

## ChangeBundleV1

An authenticated incremental timeline response may include:

```json
{
  "bundle": {
    "type": "ChangeBundle",
    "version": 1,
    "origin": "example.social",
    "fromCursor": 1200,
    "toCursor": 1234,
    "issuedAt": "2026-07-20T20:00:01.000Z",
    "expiresAt": "2026-07-20T20:05:01.000Z",
    "changes": [],
    "hasMoreChanges": false,
    "nodeIsNsfw": false
  },
  "signature": "..."
}
```

`changes` contains the same bounded, deeply validated post upserts and deletes
as the incremental timeline response. It has at most 50 entries and the
complete canonical bundle is signed by `origin`. Bundles expire after at most
five minutes. Each node keeps at most 32 pages per origin and evicts the oldest
pages when the relay cache reaches 256 MiB. Sequences must be strictly
increasing, greater than `fromCursor`, and no greater than `toCursor`. A short
page advances to the origin's captured snapshot boundary so unrelated sequence
gaps do not create endless retries.

Every node that obtains a valid bundle may cache and serve it from
`GET /api/swarm/change-bundles?origin=...&after=...`. That endpoint requires an
authenticated federation read. The receiver then independently checks:

- the requested and signed origin are identical and already pinned;
- the origin signature is valid;
- timestamps, byte limits, cursor coverage, ordering, and post origins are
  valid; and
- the bundle advances its current cursor without a gap.

A relay can replay an unexpired page or refuse to answer. It cannot edit a
post, deletion, cursor, classification, or expiry without invalidating the
origin signature. Valid pages are cached durably and can be forwarded again,
which spreads origin load through the gossip overlay.

## Pull scheduling and recovery

An accepted notice coalesces to one durable highest cursor per origin. Nodes
contacted directly by the origin spread their direct pulls deterministically
over 0–1.2 seconds. Nodes contacted by a relay spread relay-cache reads over
0.5–3.5 seconds and combine repeated notices into that same work item. Up to
three authenticated relay hints are tried in parallel.

If no valid relay bundle arrives, a deterministic deadline spreads direct
origin fallback over 15–25 seconds. Higher coalesced notices never move an
existing fallback deadline later, so continuous activity cannot starve
recovery. A missing local base cache also waits for this deadline before doing
the required direct snapshot rebuild.

ChangeNoticeV1 is active whenever the node is configured for public swarm
participation; it has no partial or shadow mode.

Periodic content polling remains permanently enabled. It repairs missed
notices, expired relay waves, offline nodes, incomplete peer views, failed
requests, and nodes that do not implement this protocol.
