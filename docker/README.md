# Synapsis Docker Deployment

Production Docker deployment using pre-built images from GitHub Container Registry.

---

## 🚀 Quick Start

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

---

## ⚙️ Configuration

Edit `.env` and set these required values (domain should be host only, no scheme or path):

| Variable | What to put |
|----------|-------------|
| `DOMAIN` | Your domain (e.g., `synapsis.example.com`) |
| `DB_PASSWORD` | Strong password for PostgreSQL |
| `AUTH_SECRET` | Run: `openssl rand -hex 32` |
| `ADMIN_EMAILS` | Your email address |

Optional (advanced):
- `NEXT_PUBLIC_NODE_DOMAIN` to override the node domain (defaults to `DOMAIN`)
- `NEXT_PUBLIC_APP_URL` to override the public app URL used by background jobs (auto-derived from the node domain)
- `ALLOW_LOCALHOST=1` to allow `localhost` in production containers for local testing
- Shared S3 storage env vars are available if you want app-level fallback storage

Optional shared storage env vars:
- `STORAGE_ENDPOINT`
- `STORAGE_REGION`
- `STORAGE_BUCKET`
- `STORAGE_ACCESS_KEY`
- `STORAGE_SECRET_KEY`
- `STORAGE_PUBLIC_BASE_URL`

**Port Configuration:**
- `PORT=auto` (default) — Automatically finds an available port between 3000-3020
- `PORT=3000` — Use a specific port instead

---

## 🔄 Updates (migrations run automatically)

```bash
cd /opt/synapsis
docker compose pull && docker compose up -d
```

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
`PORT=auto` (default) automatically finds an available port. If you set a specific port that's taken:
```bash
# Check what's using the port
sudo netstat -tlnp | grep :3000

# Switch back to auto or choose a different port
# Edit .env: PORT=auto
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
