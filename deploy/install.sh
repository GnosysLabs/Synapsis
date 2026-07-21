#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ADOPT_EXISTING=0
INSTALL_PORT="${PORT:-}"
INSTALL_DOMAIN="${NEXT_PUBLIC_NODE_DOMAIN:-}"
INSTALL_ADMIN_EMAILS="${ADMIN_EMAILS:-admin@example.com}"

usage() {
  cat <<'EOF'
Usage: install.sh [options]

  --instance NAME       Install an isolated sibling instance (for example, onlynerds)
  --port PORT           Local listen port; required for a new named instance
  --domain DOMAIN       Public node domain written to the new environment file
  --admin-email EMAIL   Initial admin email for a new environment file
  --adopt-existing      Generate managed units for an existing checkout and data directory
  --help                Show this help

The primary instance keeps the traditional /opt/synapsis paths and systemd
names. Named instances automatically use synapsis-NAME users, paths, services,
maintenance service, update timer, and admin update trigger.
EOF
}

while (($#)); do
  case "$1" in
    --instance)
      [[ $# -ge 2 ]] || { echo "--instance requires a name." >&2; exit 2; }
      INSTANCE="$2"
      shift 2
      ;;
    --port)
      [[ $# -ge 2 ]] || { echo "--port requires a value." >&2; exit 2; }
      INSTALL_PORT="$2"
      shift 2
      ;;
    --domain)
      [[ $# -ge 2 ]] || { echo "--domain requires a value." >&2; exit 2; }
      INSTALL_DOMAIN="$2"
      shift 2
      ;;
    --admin-email)
      [[ $# -ge 2 ]] || { echo "--admin-email requires a value." >&2; exit 2; }
      INSTALL_ADMIN_EMAILS="$2"
      shift 2
      ;;
    --adopt-existing)
      ADOPT_EXISTING=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

source "$SCRIPT_DIR/instance-config.sh"

if [[ ${EUID} -ne 0 ]]; then
  echo "Run this installer as root." >&2
  exit 1
fi

for command in curl flock getent git groupadd node npm openssl runuser systemctl tar useradd; do
  command -v "$command" >/dev/null || { echo "Missing required command: $command" >&2; exit 1; }
done

node_major="$(node -p 'process.versions.node.split(`.`)[0]')"
if (( node_major < 20 )); then
  echo "Synapsis requires Node.js 20 or newer." >&2
  exit 1
fi

if [[ -e "$APP_DIR" ]]; then
  if [[ "$ADOPT_EXISTING" != "1" ]]; then
    echo "$APP_DIR already exists; use deploy/update.sh for an existing managed installation or --adopt-existing for a legacy one." >&2
    exit 1
  fi
  [[ -d "$APP_DIR/.git" ]] || { echo "$APP_DIR is not a Synapsis Git checkout." >&2; exit 1; }
  [[ -f "$APP_DIR/package.json" ]] || { echo "$APP_DIR is missing package.json." >&2; exit 1; }
  [[ -f "$ENV_FILE" ]] || { echo "Cannot adopt without existing environment file $ENV_FILE." >&2; exit 1; }
else
  if [[ "$ADOPT_EXISTING" == "1" ]]; then
    echo "Cannot adopt missing checkout $APP_DIR." >&2
    exit 1
  fi
  if [[ -n "$INSTANCE" && -z "$INSTALL_PORT" && ! -f "$ENV_FILE" ]]; then
    echo "A new named instance requires --port so sibling nodes cannot collide." >&2
    exit 2
  fi
fi

if [[ ! -f "$ENV_FILE" ]]; then
  install_port_resolved="${INSTALL_PORT:-43821}"
  if [[ ! "$install_port_resolved" =~ ^[0-9]{1,5}$ \
    || "$install_port_resolved" -lt 1 \
    || "$install_port_resolved" -gt 65535 ]]; then
    echo "--port must be between 1 and 65535." >&2
    exit 2
  fi
  install_domain_resolved="${INSTALL_DOMAIN:-localhost:$install_port_resolved}"
  if [[ ! "$install_domain_resolved" =~ ^[a-zA-Z0-9.-]+(:[0-9]{1,5})?$ ]]; then
    echo "--domain must be a hostname with an optional port." >&2
    exit 2
  fi
  if [[ ! "$INSTALL_ADMIN_EMAILS" =~ ^[a-zA-Z0-9._%+@,-]+$ ]]; then
    echo "--admin-email must be an email address or comma-separated email addresses." >&2
    exit 2
  fi
fi

if ! getent group "$SERVICE_GROUP" >/dev/null 2>&1; then
  groupadd --system "$SERVICE_GROUP"
fi
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --gid "$SERVICE_GROUP" --home-dir "$DATA_DIR" --create-home --shell /usr/sbin/nologin "$SERVICE_USER"
fi

install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 0750 "$DATA_DIR"

if [[ ! -e "$APP_DIR" ]]; then
  git clone --branch "$BRANCH" --single-branch "$REPO_URL" "$APP_DIR"
  chown -R "$SERVICE_USER:$SERVICE_GROUP" "$APP_DIR"
fi

if [[ ! -e "$ENV_FILE" ]]; then
  auth_secret="$(openssl rand -base64 48 | tr -d '\n')"
  e2ee_recovery_secret="$(openssl rand -base64 48 | tr -d '\n')"

  install -m 0600 -o root -g "$SERVICE_GROUP" /dev/null "$ENV_FILE"
  {
    echo "DATABASE_PATH=$DATA_DIR/synapsis.db"
    echo "PORT=$install_port_resolved"
    echo "AUTH_SECRET=$auth_secret"
    echo "E2EE_RECOVERY_SECRET=$e2ee_recovery_secret"
    echo "ADMIN_EMAILS=$INSTALL_ADMIN_EMAILS"
    echo "NEXT_PUBLIC_NODE_DOMAIN=$install_domain_resolved"
    echo "STUFFBOX_URL=https://stuffbox.xyz"
  } > "$ENV_FILE"
fi

set -a
source "$ENV_FILE"
set +a

if [[ "$ADOPT_EXISTING" != "1" ]]; then
  runuser -u "$SERVICE_USER" -- npm --prefix "$APP_DIR" ci
  runuser -u "$SERVICE_USER" -- npm --prefix "$APP_DIR" run db:migrate
  runuser -u "$SERVICE_USER" -- npm --prefix "$APP_DIR" run build
fi

if [[ -e "$CURRENT_LINK" && ! -L "$CURRENT_LINK" ]]; then
  echo "$CURRENT_LINK exists but is not a symlink; refusing to replace it." >&2
  exit 1
fi
if [[ ! -L "$CURRENT_LINK" ]]; then
  temporary_link="${CURRENT_LINK}.new.$$"
  ln -s "$APP_DIR" "$temporary_link"
  mv -Tf "$temporary_link" "$CURRENT_LINK"
fi

env \
  INSTANCE="$INSTANCE" \
  APP_DIR="$APP_DIR" \
  DATA_DIR="$DATA_DIR" \
  ENV_FILE="$ENV_FILE" \
  RELEASES_DIR="$RELEASES_DIR" \
  CURRENT_LINK="$CURRENT_LINK" \
  PREVIOUS_LINK="$PREVIOUS_LINK" \
  REPO_URL="$REPO_URL" \
  BRANCH="$BRANCH" \
  SERVICE_USER="$SERVICE_USER" \
  SERVICE_GROUP="$SERVICE_GROUP" \
  SERVICE_NAME="$SERVICE_NAME" \
  MAINTENANCE_SERVICE_NAME="$MAINTENANCE_SERVICE_NAME" \
  UPDATE_SERVICE_NAME="$UPDATE_SERVICE_NAME" \
  UPDATE_TIMER_NAME="$UPDATE_TIMER_NAME" \
  UPDATE_PATH_NAME="$UPDATE_PATH_NAME" \
  bash "$APP_DIR/deploy/install-units.sh"

if [[ ! -f "$DATA_DIR/deployed-commit" ]]; then
  runuser -u "$SERVICE_USER" -- git -C "$APP_DIR" rev-parse HEAD \
    | install -m 0644 -o "$SERVICE_USER" -g "$SERVICE_GROUP" /dev/stdin "$DATA_DIR/deployed-commit"
fi

# Older sibling installs used a shared template path plus a hand-authored
# updater. Disable that trigger after the generated per-instance path exists.
if [[ -n "$INSTANCE" ]]; then
  systemctl disable --now "synapsis-update@${INSTANCE}.path" >/dev/null 2>&1 || true
fi

if systemctl is-active --quiet "${SERVICE_NAME}.service"; then
  systemctl enable "${SERVICE_NAME}.service" >/dev/null
else
  systemctl enable --now "${SERVICE_NAME}.service"
fi
systemctl enable --now "${UPDATE_TIMER_NAME}.timer"
systemctl enable --now "${UPDATE_PATH_NAME}.path"

echo "Synapsis ${INSTANCE:-primary instance} is listening on http://127.0.0.1:${PORT}"
echo "Environment: $ENV_FILE"
echo "Updates: ${UPDATE_SERVICE_NAME}.service (staged while the current release remains online)"
