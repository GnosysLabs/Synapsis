# ChangeNoticeV1

Status: experimental. Nodes must keep periodic content polling enabled.

## Purpose

`ChangeNoticeV1` is a small, signed wake-up. It never contains post content and
never makes a relay authoritative. A receiver that accepts a notice pulls the
origin's existing signed `/api/swarm/timeline?changesSince=...` stream.

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

Acceptance grants no content authority. The receiver still fetches from the
exact HTTPS origin, verifies the signed read, and applies all existing content,
identity, moderation, size, and cache limits.

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

## Pulling and recovery

An accepted notice schedules a single-flight immediate pull whenever its cursor
is ahead of the receiver's local pull cursor. ChangeNoticeV1 is active whenever
the node is configured for public swarm participation; it has no partial or
shadow mode.

Periodic content polling remains permanently enabled. It repairs missed
notices, expired relay waves, offline nodes, incomplete peer views, failed
requests, and nodes that do not implement this protocol.
