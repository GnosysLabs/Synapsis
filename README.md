# Synapsis

**Your node. Your network. Your identity.**

Synapsis is an open-source federated social network built around sovereign DIDs, portable user-owned media storage, and the Swarm network.

The current application includes:

- independent nodes with their own accounts, branding, rules, and moderation;
- Node, Following, and Explore feeds, plus local and cross-node search;
- posts, replies, mentions, likes, reposts, profiles, follows, and collections;
- user-owned image, video, and audio storage through Stuffbox;
- experimental client-encrypted one-to-one messages;
- browser notifications and privacy-limited native iOS push notifications;
- signed account export and import; and
- scoped, revocable CLI credentials for people and posting agents.

Interactive feeds and post search read from the local database. Remote content is synchronized, verified, classified, and cached in the background rather than fetched from a fleet of nodes while a page is loading.

## Run a node on a VPS

Synapsis runs directly under systemd. It does not require Docker, PostgreSQL, or a bundled reverse proxy.

Prerequisites:

- A Linux VPS with systemd
- Node.js 20 or newer
- Git, npm, and OpenSSL
- Your own nginx, Caddy, Traefik, or other reverse proxy

Install from a checkout:

```bash
sudo bash deploy/install.sh --domain social.example.com --admin-email you@example.com
sudo nano /etc/synapsis.env
sudo bash /opt/synapsis/deploy/update.sh
```

The service binds only to `127.0.0.1:43821`. Point your reverse proxy at that address and terminate TLS there. `PORT` can be overridden in `/etc/synapsis.env` if needed.

The installer creates:

- Application checkout: `/opt/synapsis`
- Active release symlink: `/opt/synapsis-current`
- Versioned releases: `/opt/synapsis-releases/<commit>`
- Environment file: `/etc/synapsis.env`
- Embedded Turso database: `/var/lib/synapsis/synapsis.db`
- Service: `synapsis.service`
- Mandatory update timer: `synapsis-update.timer`
- Admin update trigger: `synapsis-update.path`

To install a second or later node on the same server, give it an instance name,
unique port, and domain:

```bash
sudo bash deploy/install.sh \
  --instance onlynerds \
  --port 43822 \
  --domain onlynerds.xyz \
  --admin-email you@example.com
```

The installer derives an isolated user, checkout, data directory, environment,
active-release link, app service, maintenance service, updater, timer, and admin
update trigger from the instance name. For the example above these are rooted at
`/opt/synapsis-onlynerds`, `/var/lib/synapsis-onlynerds`, and
`/etc/synapsis-onlynerds.env`, with systemd units named
`synapsis-onlynerds*`. Every generated updater invokes the repository's shared
atomic updater and refreshes its own generated units on later releases; sibling
instances do not require copied scripts or hand-authored systemd files.

Every node pins `origin` to [`GnosysLabs/Synapsis`](https://github.com/GnosysLabs/Synapsis) on GitHub. The first automatic check becomes eligible five minutes after boot and receives up to 30 minutes of random delay. After a check finishes, the next becomes eligible 15 minutes later and receives the same random delay. When a new commit is available, Synapsis fast-forwards the source checkout and builds a versioned candidate—including dependency installation and an isolated build-database migration—while the current release remains online. Only then does it enter maintenance mode, replace the single `backups/latest` database snapshot, migrate the real database, atomically switch the active-release symlink, and restart. An admin can skip the wait with **Update now** in Admin Settings. The repository commit count is shown in the Network Info card; `/api/version` exposes both that number and the full deployed commit hash.

The maintenance page is now limited to the database migration and release switch rather than the full install/build. If the new release fails its local `/api/health` check, the updater switches back to the previous release automatically; if that release also cannot start, it leaves the branded maintenance page active instead of exposing a gateway error. A failed candidate is not activated repeatedly on every timer tick. The active and immediately previous releases are retained, and older release directories are removed after a successful update.

Operators with nonstandard filesystem conventions may still override `APP_DIR`,
`DATA_DIR`, `ENV_FILE`, `SERVICE_USER`, `SERVICE_GROUP`, and the service-name
variables. The same generated-unit and atomic-update path remains the default.

For a node installed before the GitHub updater migration (or before automatic updates existed), bootstrap it once with:

```bash
sudo -u synapsis git -C /opt/synapsis remote set-url origin https://github.com/GnosysLabs/Synapsis.git
sudo -u synapsis git -C /opt/synapsis pull --ff-only
sudo /opt/synapsis/deploy/update.sh
```

Legacy sibling instances that predate generated units can be adopted once
without recloning, rebuilding, or replacing their data:

```bash
sudo bash /opt/synapsis-onlynerds/deploy/install.sh \
  --instance onlynerds \
  --adopt-existing
```

Adoption preserves the running process and existing environment, installs the
same managed units a fresh sibling receives, and lets its next update build
beside the live release.

Useful commands:

```bash
sudo systemctl status synapsis
sudo systemctl status synapsis-update.timer
sudo systemctl status synapsis-update.path
sudo journalctl -u synapsis -f
sudo journalctl -u synapsis-update -f
sudo /opt/synapsis/deploy/update.sh
sudo /opt/synapsis/deploy/uninstall.sh
sudo /opt/synapsis-onlynerds/deploy/uninstall.sh --instance onlynerds
```

Uninstalling preserves the database and environment by default. Pass `--purge-data` only when you intentionally want to remove both.

## Storage and account portability

The node database is a local embedded Turso/SQLite file. Media remains in storage controlled by each user, so exported accounts retain portable media URLs and can move between Synapsis nodes without requiring the old node to transfer a shared upload directory.

Stuffbox is the exclusive media-storage integration. New installs use `https://stuffbox.xyz`; set `STUFFBOX_URL` to a different public URL when using another or self-hosted Stuffbox service. Each Synapsis install registers its callback automatically the first time a user connects, so node operators do not need to create or configure a Stuffbox client ID. Synapsis uses a consent and PKCE flow, keeps the resulting tokens encrypted with `AUTH_SECRET`, and sends file bytes directly from the user's browser to Stuffbox. Production clients render federated media only from the standard Stuffbox origin or exact origins listed in `NEXT_PUBLIC_FEDERATION_MEDIA_ORIGINS`; add a self-hosted Stuffbox canonical asset/CDN origin there so a hostile peer cannot substitute a tracking URL that receives viewers' IP addresses.

Browser and CLI upload paths remove private photo and video metadata before bytes leave the client. This includes EXIF and GPS data, capture times, camera and device fields, comments, and supported container metadata. Orientation-dependent still images are normalized first so they remain upright. Malformed media fails closed instead of being uploaded unsanitized.

Account exports preserve the account signing identity, public content, relationships, settings, and message records in a signed package. Stuffbox URLs remain portable because media is not stored in a node-owned upload directory. Some federation state is still eventually refreshed after a move, and old encrypted-message history is not made readable on the destination node.

## Federation and content freshness

Synapsis treats every remote node as untrusted. State-changing federation uses a destination-bound node signature and an exact user action signed by the actor's DID key. Reads and discovery are bounded, redirect-free, public-address-only HTTPS requests. Node keys are pinned after direct verification, and invalid signatures, identity discontinuities, replays, oversized responses, and unsafe network destinations fail closed.

Public content is represented as a monotonic stream of upserts and deletion tombstones. Posts, deletes, profile-visible post changes, media changes, likes, reposts, and account deletions advance that stream. Receiving nodes keep a per-origin cursor and apply changes to a bounded local cache.

Freshness uses two complementary paths:

1. An origin signs a tiny, short-lived `ChangeNoticeV1` containing its advanced cursor. Notices are coalesced and gossiped with bounded fanout; duplicate, expired, conflicting, unknown-origin, and incorrectly signed notices are rejected.
2. A receiver schedules its pull inside a short deterministic window so a large fleet does not contact the origin in the same millisecond. It can retrieve a five-minute, origin-signed `ChangeBundleV1` from an untrusted relay and verify the origin signature itself. Relayed receivers fall back to the origin after a deterministic 15–25 second window if no relay can serve the bundle.

Periodic background polling remains enabled permanently, so offline nodes and missed notices recover without depending on the gossip path. Repeated notices for an origin collapse to the newest cursor instead of creating one pull per mutation.

The included one-off simulator can exercise the notice topology without creating real nodes:

```bash
npm run simulate:change-notice -- 1000
npm run simulate:change-notice -- 10000
```

The model has demonstrated bounded origin load and single-digit-second p99 delivery in those simulated topologies. That is design evidence, not a claim that a real 10,000-node deployment has been proven. Churn, malicious peers, cold starts, slow nodes, long histories, and sustained large-fleet operation still require real-world acceptance testing.

## Encrypted direct messages

New one-to-one DMs encrypt text, reply references, and up to four Stuffbox attachment descriptors in the browser. The underlying media bytes remain at their Stuffbox URLs and are not re-encrypted with the message key. Current enrollment uses the account password for new-device recovery; accounts enrolled under the earlier PIN design migrate once using their old PIN and account password. Recognized browsers keep the account encryption key wrapped by a non-extractable IndexedDB key.

Node installs generate a distinct `E2EE_RECOVERY_SECRET`; preserve it separately from the database in a secret manager or protected operational backup. Losing or changing it without a deliberate migration can make existing recovery records unusable.

E2EE v1 is intentionally limited and experimental. Routing metadata remains visible, legacy DMs remain plaintext, account export/import does not move readable old encrypted history, and the protocol does not provide forward secrecy, per-device sessions, key transparency, or protection from a malicious home node that serves modified client code. It has not completed an independent cryptographic and application-security review.

## Native iOS notifications

Compatible Synapsis nodes participate automatically; there is no operator opt-in,
allowlist, Apple credential, or extra worker process to install. The normal Synapsis
server process keeps a durable delivery outbox only for local users who enable iOS
notifications. It sends constrained, privacy-safe events to the central
`https://push.synapsis.social` relay. Raw APNs device tokens and Apple private keys
exist only at that separately deployed relay. See `services/push-relay/README.md` for
the relay protocol and central deployment contract.

## Development

```bash
git clone https://github.com/GnosysLabs/Synapsis.git
cd Synapsis
npm install
cp .env.example .env
npm run db:migrate
npm run dev
```

The development database defaults to `./data/synapsis.db`. No separate database server is needed.

## CLI and agent posting

Install the CLI from npm:

```bash
npm install --global @gnosyslabs/synapsis-cli
synapsis auth connect https://your-node.example
```

After installation, update the CLI and refresh its bundled agent skill with `synapsis update`.

The connect command creates a scoped, revocable device credential and opens the node's browser approval screen. It does not copy the account's primary signing key. Credentials default to 90 days, can be reviewed or revoked under **Settings → CLI & Agents**, and are stored in an owner-only local configuration file.

Connect as many accounts and nodes as needed; the agent can select them by username and asks which account or node to use when a posting request is ambiguous.

Publish text and media from a terminal or agent:

```bash
synapsis post create --text "Hello from the CLI"
synapsis post create --text "A field recording" --media ./recording.m4a --alt "Birdsong beside a creek"
printf '%s' "Caption from an agent" | synapsis post create --stdin --media ./photo.jpg --alt "A moss-covered trail"
```

Media bytes upload directly to the account's connected Stuffbox; the Synapsis node authorizes and records the resulting asset. Before photo or video bytes leave the client, Synapsis removes EXIF, GPS, capture dates, camera/device fields, comments, and container metadata. Orientation-dependent still photos are normalized first so they remain upright. Up to four images, videos, or audio files may be attached. Run `synapsis skill install` to install the bundled `synapsis-post` skill for Codex, Agent Skills-compatible clients, and Claude Code.

Common development commands:

```bash
npm run type-check
npm test
npm run db:generate
npm run db:migrate
npm run build
```

## Architecture

- **Framework:** Next.js 16 and React 19
- **Database:** embedded Turso with Drizzle ORM's relational-query v2 API
- **Identity:** self-certifying `did:key` identities with per-user P-256 signing keys
- **Media:** user-owned Stuffbox storage
- **Federation:** signed HTTPS, bounded gossip notices, verified relay bundles, background synchronization, and permanent polling recovery
- **Deployment:** native Node.js process managed by systemd

## License

Licensed under the [Apache License 2.0](LICENSE).
