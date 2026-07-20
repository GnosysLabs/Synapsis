#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/synapsis}"
DATA_DIR="${DATA_DIR:-/var/lib/synapsis}"
ENV_FILE="${ENV_FILE:-/etc/synapsis.env}"
REPO_URL="${REPO_URL:-https://github.com/GnosysLabs/Synapsis.git}"
BRANCH="${BRANCH:-main}"

if [[ ${EUID} -ne 0 ]]; then
  echo "Run this installer as root." >&2
  exit 1
fi

for command in git node npm openssl runuser systemctl; do
  command -v "$command" >/dev/null || { echo "Missing required command: $command" >&2; exit 1; }
done

node_major="$(node -p 'process.versions.node.split(`.`)[0]')"
if (( node_major < 20 )); then
  echo "Synapsis requires Node.js 20 or newer." >&2
  exit 1
fi

if ! id synapsis >/dev/null 2>&1; then
  useradd --system --home-dir "$DATA_DIR" --create-home --shell /usr/sbin/nologin synapsis
fi

install -d -o synapsis -g synapsis -m 0750 "$DATA_DIR"

if [[ -e "$APP_DIR" ]]; then
  echo "$APP_DIR already exists; use deploy/update.sh for an existing installation." >&2
  exit 1
fi

git clone --branch "$BRANCH" --single-branch "$REPO_URL" "$APP_DIR"
chown -R synapsis:synapsis "$APP_DIR"

if [[ ! -e "$ENV_FILE" ]]; then
  auth_secret="$(openssl rand -base64 48 | tr -d '\n')"
  e2ee_recovery_secret="$(openssl rand -base64 48 | tr -d '\n')"
  port="43821"
  install -m 0600 -o root -g synapsis /dev/null "$ENV_FILE"
  {
    echo "DATABASE_PATH=$DATA_DIR/synapsis.db"
    echo "PORT=$port"
    echo "AUTH_SECRET=$auth_secret"
    echo "E2EE_RECOVERY_SECRET=$e2ee_recovery_secret"
    echo "ADMIN_EMAILS=admin@example.com"
    echo "NEXT_PUBLIC_NODE_DOMAIN=localhost:$port"
    echo "STUFFBOX_URL=https://stuffbox.xyz"
  } > "$ENV_FILE"
fi

set -a
source "$ENV_FILE"
set +a

runuser -u synapsis -- npm --prefix "$APP_DIR" ci
runuser -u synapsis -- npm --prefix "$APP_DIR" run db:migrate
runuser -u synapsis -- npm --prefix "$APP_DIR" run build

install -m 0644 "$APP_DIR/deploy/synapsis.service" /etc/systemd/system/synapsis.service
install -m 0644 "$APP_DIR/deploy/synapsis-maintenance.service" /etc/systemd/system/synapsis-maintenance.service
install -m 0644 "$APP_DIR/deploy/synapsis-update.service" /etc/systemd/system/synapsis-update.service
install -m 0644 "$APP_DIR/deploy/synapsis-update.timer" /etc/systemd/system/synapsis-update.timer
install -m 0644 "$APP_DIR/deploy/synapsis-update.path" /etc/systemd/system/synapsis-update.path
runuser -u synapsis -- git -C "$APP_DIR" rev-parse HEAD | install -m 0644 -o synapsis -g synapsis /dev/stdin "$DATA_DIR/deployed-commit"
systemctl daemon-reload
systemctl enable --now synapsis
systemctl enable --now synapsis-update.timer
systemctl enable --now synapsis-update.path

echo "Synapsis is listening on http://127.0.0.1:${PORT}"
echo "Edit $ENV_FILE, run $APP_DIR/deploy/update.sh, then configure your own reverse proxy."
