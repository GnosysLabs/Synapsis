#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/synapsis}"
DATA_DIR="${DATA_DIR:-/var/lib/synapsis}"
ENV_FILE="${ENV_FILE:-/etc/synapsis.env}"

if [[ ${EUID} -ne 0 ]]; then
  echo "Run this updater as root." >&2
  exit 1
fi

[[ -d "$APP_DIR/.git" ]] || { echo "No Synapsis checkout found at $APP_DIR" >&2; exit 1; }
[[ -f "$ENV_FILE" ]] || { echo "Missing $ENV_FILE" >&2; exit 1; }

set -a
source "$ENV_FILE"
set +a

systemctl stop synapsis
trap 'systemctl start synapsis' EXIT

if [[ -f "${DATABASE_PATH:-$DATA_DIR/synapsis.db}" ]]; then
  database_file="${DATABASE_PATH:-$DATA_DIR/synapsis.db}"
  backup_dir="$DATA_DIR/backups/$(date -u +%Y%m%dT%H%M%SZ)"
  install -d -o synapsis -g synapsis -m 0750 "$backup_dir"
  cp "$database_file" "$backup_dir/synapsis.db"
  for suffix in -wal -shm; do
    if [[ -f "${database_file}${suffix}" ]]; then
      cp "${database_file}${suffix}" "$backup_dir/synapsis.db${suffix}"
    fi
  done
  chown -R synapsis:synapsis "$backup_dir"
fi

runuser -u synapsis -- git -C "$APP_DIR" pull --ff-only
runuser -u synapsis -- npm --prefix "$APP_DIR" ci
runuser -u synapsis -- npm --prefix "$APP_DIR" run db:migrate
runuser -u synapsis -- npm --prefix "$APP_DIR" run build

systemctl start synapsis
trap - EXIT
echo "Synapsis updated successfully."
