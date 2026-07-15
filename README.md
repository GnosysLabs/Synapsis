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

Every node checks `origin/main` about once per minute. When a new commit is available, Synapsis fast-forwards the checkout, replaces the single `backups/latest` database snapshot, installs dependencies, runs migrations, builds, and restarts automatically. The repository commit count is shown in the Network Info card; `/api/version` exposes both that number and the full deployed commit hash.

While an update is being installed, `synapsis-maintenance.service` temporarily serves a maintenance page on the node's configured `PORT`, using that node's logo and accent color. Existing reverse proxies continue receiving an HTTP response instead of showing a gateway error, and browsers automatically reload when Synapsis is ready.

For a node installed before automatic updates existed, bootstrap the timer once with:

```bash
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

Stuffbox is the exclusive media-storage integration. New installs use `https://stuffbox.xyz`; set `STUFFBOX_URL` to a different public URL when using another or self-hosted Stuffbox service. Each Synapsis install registers its callback automatically the first time a user connects, so node operators do not need to create or configure a Stuffbox client ID. Synapsis uses a consent and PKCE flow, keeps the resulting tokens encrypted with `AUTH_SECRET`, and sends file bytes directly from the user's browser to Stuffbox.

## Encrypted direct messages

New one-to-one text DMs use client-side end-to-end encryption with a separate PIN for new-device recovery. The PIN does not change the normal login flow or ordinary sending experience. Node installs generate a distinct `E2EE_RECOVERY_SECRET`; preserve it in a secret manager or protected operational backup because the database alone cannot restore PIN recovery.

V1 is intentionally limited and experimental: metadata remains visible, legacy DMs remain plaintext, and it does not provide forward secrecy or protection from a malicious home node that serves modified client code. See [the E2EE DM security and operations contract](docs/e2ee-dms.md) before enabling or describing the feature.

## Development

```bash
git clone https://githop.xyz/GnosysLabs/Synapsis.git
cd Synapsis
npm install
cp .env.example .env
npm run db:migrate
npm run dev
```

The development database defaults to `./data/synapsis.db`. No separate database server is needed.

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
