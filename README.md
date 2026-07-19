# Synapsis

**Your node. Your network. Your identity.**

Synapsis is an open-source federated social network built around sovereign DIDs, portable user-owned media storage, and the Swarm network.

## Run a node on a VPS

Synapsis runs directly under systemd. It does not require Docker, PostgreSQL, or a bundled reverse proxy.

Prerequisites:

- A Linux VPS with systemd
- Node.js 20 or newer
- Git, npm, and OpenSSL
- Your own nginx, Caddy, Traefik, or other reverse proxy

Install from a checkout:

```bash
sudo bash deploy/install.sh
sudo nano /etc/synapsis.env
sudo bash /opt/synapsis/deploy/update.sh
```

The service binds only to `127.0.0.1:43821`. Point your reverse proxy at that address and terminate TLS there. `PORT` can be overridden in `/etc/synapsis.env` if needed.

The installer creates:

- Application checkout: `/opt/synapsis`
- Environment file: `/etc/synapsis.env`
- Embedded Turso database: `/var/lib/synapsis/synapsis.db`
- Service: `synapsis.service`
- Mandatory update timer: `synapsis-update.timer`

Every node pins `origin` to [`GnosysLabs/Synapsis`](https://github.com/GnosysLabs/Synapsis) on GitHub and checks `origin/main` about once per minute. When a new commit is available, Synapsis fast-forwards the checkout, replaces the single `backups/latest` database snapshot, installs dependencies, runs migrations, builds, and restarts automatically. The repository commit count is shown in the Network Info card; `/api/version` exposes both that number and the full deployed commit hash.

While an update is being installed, `synapsis-maintenance.service` temporarily serves a maintenance page on the node's configured `PORT`, using that node's logo and accent color. Existing reverse proxies continue receiving an HTTP response instead of showing a gateway error, and browsers automatically reload when Synapsis is ready.

For a node installed before the GitHub updater migration (or before automatic updates existed), bootstrap it once with:

```bash
sudo -u synapsis git -C /opt/synapsis remote set-url origin https://github.com/GnosysLabs/Synapsis.git
sudo -u synapsis git -C /opt/synapsis pull --ff-only
sudo /opt/synapsis/deploy/update.sh
```

Useful commands:

```bash
sudo systemctl status synapsis
sudo systemctl status synapsis-update.timer
sudo journalctl -u synapsis -f
sudo journalctl -u synapsis-update -f
sudo /opt/synapsis/deploy/update.sh
sudo /opt/synapsis/deploy/uninstall.sh
```

Uninstalling preserves the database and environment by default. Pass `--purge-data` only when you intentionally want to remove both.

## Storage and account portability

The node database is a local embedded Turso/SQLite file. Media remains in storage controlled by each user, so exported accounts retain portable media URLs and can move between Synapsis nodes without requiring the old node to transfer a shared upload directory.

Stuffbox is the exclusive media-storage integration. New installs use `https://stuffbox.xyz`; set `STUFFBOX_URL` to a different public URL when using another or self-hosted Stuffbox service. Each Synapsis install registers its callback automatically the first time a user connects, so node operators do not need to create or configure a Stuffbox client ID. Synapsis uses a consent and PKCE flow, keeps the resulting tokens encrypted with `AUTH_SECRET`, and sends file bytes directly from the user's browser to Stuffbox. Production clients render federated media only from the standard Stuffbox origin or exact origins listed in `NEXT_PUBLIC_FEDERATION_MEDIA_ORIGINS`; add a self-hosted Stuffbox canonical asset/CDN origin there so a hostile peer cannot substitute a tracking URL that receives viewers' IP addresses.

## Encrypted direct messages

New one-to-one text DMs use client-side end-to-end encryption with a separate PIN for new-device recovery. The PIN does not change the normal login flow or ordinary sending experience. Node installs generate a distinct `E2EE_RECOVERY_SECRET`; preserve it in a secret manager or protected operational backup because the database alone cannot restore PIN recovery.

V1 is intentionally limited and experimental: metadata remains visible, legacy DMs remain plaintext, and it does not provide forward secrecy or protection from a malicious home node that serves modified client code. See [the E2EE DM security and operations contract](docs/e2ee-dms.md) before enabling or describing the feature.

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

Common commands:

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
- **Identity:** DIDs and per-user signing keys
- **Media:** user-owned Stuffbox storage
- **Federation:** Synapsis Swarm discovery and signed interactions
- **Deployment:** native Node.js process managed by systemd

## License

Licensed under the [Apache License 2.0](LICENSE).
