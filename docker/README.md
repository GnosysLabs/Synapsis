# Synapsis Docker Deployment

Production Docker deployment using pre-built images from GitHub Container Registry.

---

## 🚀 Quick Start

This is the default install path for a fresh VPS where Synapsis should manage its own HTTPS with Caddy.

```bash
curl -fsSL https://synapsis.social/install.sh | bash
nano /opt/synapsis/.env  # Add your domain and admin email
cd /opt/synapsis
docker compose up -d
```

Your node is live at `https://your-domain.com` with automatic SSL.

---

## 📋 What You Need

| Requirement | Details |
|-------------|---------|
| **Server** | 2GB RAM, 2 CPU cores, 20GB SSD (minimum) |
| **Domain** | A domain or subdomain pointing to your server |
| **Docker** | Installed automatically by `install.sh` when missing on supported Linux hosts |
| **Ports** | `80` and `443` must be free for the default Caddy install |

---

## ⚙️ Configuration

Edit `.env` and set these required values (domain should be host only, no scheme or path):

| Variable | What to put |
|----------|-------------|
| `DOMAIN` | Your domain (e.g., `synapsis.example.com`) |
| `DB_PASSWORD` | Strong password for PostgreSQL |
| `AUTH_SECRET` | Run: `openssl rand -hex 32` |
| `ADMIN_EMAILS` | Your email address |

Use the bare/canonical host in `DOMAIN`. Example: set `DOMAIN=synapsis.example.com`, not `www.synapsis.example.com`.
If you also want `www.synapsis.example.com` to work, create a DNS record for `www` pointing to the same server. The bundled Caddy config will redirect `www` to the canonical `DOMAIN`.

Optional (advanced):
- `NEXT_PUBLIC_NODE_DOMAIN` to override the node domain (defaults to `DOMAIN`)
- `NEXT_PUBLIC_APP_URL` to override the public app URL used by background jobs (auto-derived from the node domain)
- `ALLOW_LOCALHOST=1` to allow `localhost` in production containers for local testing

**Port Configuration:**
- `PORT=auto` (default) — Automatically finds an available port between 3000-3020
- `PORT=3000` — Use a specific port instead

---

## Advanced: Existing nginx/Traefik/Caddy Host

If your server already runs a reverse proxy on `80/443`, use the advanced mode:

```bash
curl -fsSL https://synapsis.social/install.sh | PROXY=none bash
nano /opt/synapsis/.env
cd /opt/synapsis
docker compose up -d
```

This mode:
- skips the bundled Caddy service
- binds Synapsis to `127.0.0.1:${PORT:-3000}`
- expects your existing reverse proxy to forward traffic there

In `PROXY=none` mode, `PORT` is the localhost port your reverse proxy should target. The installer automatically changes `PORT=auto` to `PORT=3000` unless you override it.

Example nginx site:

```nginx
server {
    server_name node.example.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

---

## 🔄 Updates (migrations run automatically)

```bash
cd /opt/synapsis
docker compose pull && docker compose up -d
```

## 🗑️ Full Uninstall

To remove Synapsis completely from a host and start over:

```bash
curl -fsSL https://synapsis.social/uninstall.sh | bash
```

The uninstaller destroys the Synapsis containers, volumes, network, cached Synapsis images, and `/opt/synapsis`. It requires typing `DELETE` unless you set `FORCE=1`.

---

## 🛠️ Common Commands

```bash
# View logs
docker compose logs -f app

# Restart services
docker compose restart app

# Stop everything
docker compose down

# Database backup
docker compose exec postgres pg_dump -U synapsis synapsis > backup.sql

# Access database
docker compose exec postgres psql -U synapsis -d synapsis
```

---

## 🔍 Troubleshooting

### Container won't start
```bash
docker compose config  # Validate config
docker compose logs app --tail=50  # Check errors
```

### Port already in use
If the installer says `80` or `443` is already in use, another reverse proxy is already bound there.

Use a fresh VPS for the default Caddy install, or rerun the installer in advanced mode:

```bash
curl -fsSL https://synapsis.social/install.sh | PROXY=none bash
```

For the application port itself, `PORT=auto` (default) automatically finds an available port. If you set a specific port that's taken:
```bash
# Check what's using the port
sudo netstat -tlnp | grep :3000

# Choose a different fixed port in /opt/synapsis/.env
# Example: PORT=3013
```

### Database connection failed
```bash
# Check database health
docker compose ps

# Verify environment variables loaded
docker compose exec app env | grep DATABASE
```

### SSL certificate issues
```bash
# Check Caddy logs
docker compose logs caddy

# Test Caddy config
docker compose exec caddy caddy validate --config /etc/caddy/Caddyfile
```

### Image pull fails
```bash
# Verify image exists
docker pull ghcr.io/gnosyslabs/synapsis:latest

# Check the published package tags in GitHub Container Registry
```

---

## 💾 Backup Strategy

Create `/opt/synapsis/backup.sh`:

```bash
#!/bin/bash
BACKUP_DIR="/var/backups/synapsis"
DATE=$(date +%Y%m%d_%H%M%S)
mkdir -p $BACKUP_DIR

# Database backup
docker compose exec -T postgres pg_dump -U synapsis synapsis > "$BACKUP_DIR/db_$DATE.sql"

echo "✅ Backup complete: $DATE"
```

Schedule daily backups:
```bash
chmod +x /opt/synapsis/backup.sh
echo "0 2 * * * /opt/synapsis/backup.sh" | sudo crontab -
```

---

## 🏗️ Building from Source

To build locally instead of using pre-built images:

```bash
git clone https://github.com/GnosysLabs/Synapsis.git
cd synapsis/docker
docker compose up -d --build
```

---

For full documentation, visit [docs.synapsis.social](https://docs.synapsis.social)
