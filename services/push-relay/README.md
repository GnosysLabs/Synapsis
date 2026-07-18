# Synapsis Push Relay

This is the single, independently deployed service behind `https://push.synapsis.social`.
It is kept in the Synapsis monorepo so the iOS, node, and relay protocols can evolve
together, but it must run as a separate production deployment.

Community nodes do **not** run this service and never receive Apple credentials or raw
APNs device tokens. Updated Synapsis nodes automatically run the small durable outbox
worker built into the normal server process. The worker is idle when no local iOS user
has registered a subscription.

## Configuration

Copy `.env.example` into the deployment's secret configuration. Generate
`PUSH_RELAY_DATA_KEY` once and retain it; changing it makes existing encrypted device
tokens unreadable. Mount the two `.p8` files from the deployment secret manager at the
configured paths. Never copy either Apple key into this repository or a container image.

- Team ID: `4PDUNTF69S`
- APNs topic: `xyz.gnosyslabs.synapsis`
- Production key ID: `BD9K3G3825`
- Sandbox key ID: `48ZW9MQ7QM`

The production key serves App Store/TestFlight builds. The sandbox key serves Debug
builds installed from Xcode.

## Run

From the repository root:

```sh
npm run push-relay:start
```

The relay creates its SQLite schema on startup. Put it behind TLS at
`push.synapsis.social` and persist the directory containing `PUSH_RELAY_DATABASE_PATH`.
Use `GET /healthz` for readiness checks. A reverse proxy or edge service should also
apply a broad IP-level abuse limit; the relay itself applies per-IP registration and
per-subscription delivery limits.

The process binds to `127.0.0.1` by default. Set `HOST=0.0.0.0` only in an isolated
container or network where the platform requires it.

The `push.synapsis.social` DNS record may and should be Cloudflare-proxied (orange
cloud). Use **Full (strict)** origin TLS, preserve Cloudflare's `CF-Connecting-IP`
header, and do not add a cache-everything rule for `/v1/*`. The relay uses the
Cloudflare client address for its registration abuse limit and falls back to the
socket address for direct/local development. Restrict the public origin firewall to
Cloudflare address ranges or use Authenticated Origin Pulls; the relay itself should
remain bound to localhost behind the origin reverse proxy.

The supplied `deploy/nginx-bootstrap.conf` serves only the ACME challenge while the
certificate is issued. Replace it with `deploy/nginx.conf` afterward. Both files
allow only Cloudflare's published proxy ranges to reach the HTTPS application;
the HTTP ACME challenge path remains reachable by Let's Encrypt validators. Update
the proxy ranges whenever Cloudflare changes its published list.

For the same native-systemd deployment style as Synapsis itself, copy this service
directory to `/opt/synapsis-push-relay`, run `npm ci --omit=dev` inside it, and install the supplied
`deploy/synapsis-push-relay.service` as `/etc/systemd/system/synapsis-push-relay.service`.
Create `/etc/synapsis-push-relay.env` from `.env.example` (leave the two key-file values
out because the unit supplies them), and place the one-time Apple downloads at:

```text
/etc/synapsis-push-relay/apns-production.p8
/etc/synapsis-push-relay/apns-sandbox.p8
```

Set both key files to owner-readable only. The unit exposes them through systemd's
credential directory, runs under an isolated dynamic user, and writes only to
`/var/lib/synapsis-push-relay`. Bind `PORT` only behind the TLS reverse proxy for
`push.synapsis.social`.

## Protocol and privacy boundary

1. The iOS app sends its APNs token directly to the relay.
2. The relay returns an opaque subscription ID plus separate management and delivery tokens.
3. The app registers only the subscription ID and delivery token with its authenticated node.
4. The node sends a constrained interaction event; the relay constructs and sends the APNs payload.

Push payloads never include post text. They contain an actor/action title, a generic body,
and IDs used by the app to open its authenticated notification view.
