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

Useful commands:

```bash
sudo systemctl status synapsis
sudo journalctl -u synapsis -f
sudo /opt/synapsis/deploy/update.sh
sudo /opt/synapsis/deploy/uninstall.sh
```

Uninstalling preserves the database and environment by default. Pass `--purge-data` only when you intentionally want to remove both.

## Storage and account portability

The node database is a local embedded Turso/SQLite file. Media remains in each user's S3-compatible bucket so exported accounts can retain portable media URLs and move between Synapsis nodes without requiring the old node to transfer a shared upload directory.

Supported S3-compatible providers include AWS S3, Cloudflare R2, Backblaze B2, Wasabi, and Contabo. Synapsis stores each user's credentials encrypted with `AUTH_SECRET`.

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
- **Media:** user-owned S3-compatible storage
- **Federation:** Synapsis Swarm discovery and signed interactions
- **Deployment:** native Node.js process managed by systemd

## License

Licensed under the [Apache License 2.0](LICENSE).
