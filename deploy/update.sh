#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/synapsis}"
DATA_DIR="${DATA_DIR:-/var/lib/synapsis}"
ENV_FILE="${ENV_FILE:-/etc/synapsis.env}"
BRANCH="${BRANCH:-main}"
DEPLOYED_COMMIT_FILE="$DATA_DIR/deployed-commit"

if [[ ${EUID} -ne 0 ]]; then
  echo "Run this updater as root." >&2
  exit 1
fi

[[ -d "$APP_DIR/.git" ]] || { echo "No Synapsis checkout found at $APP_DIR" >&2; exit 1; }
[[ -f "$ENV_FILE" ]] || { echo "Missing $ENV_FILE" >&2; exit 1; }

set -a
source "$ENV_FILE"
set +a

install_update_units() {
  units_changed=0
  for unit in synapsis.service synapsis-maintenance.service synapsis-update.service synapsis-update.timer; do
    if ! cmp -s "$APP_DIR/deploy/$unit" "/etc/systemd/system/$unit"; then
      install -m 0644 "$APP_DIR/deploy/$unit" "/etc/systemd/system/$unit"
      units_changed=1
    fi
  done

  if [[ "$units_changed" == "1" ]]; then
    systemctl daemon-reload
  fi
  if ! systemctl is-enabled --quiet synapsis-update.timer; then
    systemctl enable synapsis-update.timer
  fi
  if ! systemctl is-active --quiet synapsis-update.timer; then
    systemctl start synapsis-update.timer
  fi
}

if [[ "${SYNAPSIS_APPLY_UPDATE:-0}" != "1" ]]; then
  runuser -u synapsis -- git -C "$APP_DIR" fetch --prune origin "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH"

  current_commit="$(runuser -u synapsis -- git -C "$APP_DIR" rev-parse HEAD)"
  target_commit="$(runuser -u synapsis -- git -C "$APP_DIR" rev-parse "origin/$BRANCH")"
  deployed_commit=""
  if [[ -f "$DEPLOYED_COMMIT_FILE" ]]; then
    deployed_commit="$(tr -d '[:space:]' < "$DEPLOYED_COMMIT_FILE")"
  fi

  if [[ -n "$deployed_commit" && "$deployed_commit" == "$target_commit" ]]; then
    install_update_units
    echo "Synapsis is already current at ${target_commit:0:7}."
    exit 0
  fi

  if [[ "$current_commit" != "$target_commit" ]]; then
    if ! runuser -u synapsis -- git -C "$APP_DIR" merge-base --is-ancestor "$current_commit" "$target_commit"; then
      echo "Cannot auto-update: local checkout has diverged from origin/$BRANCH." >&2
      exit 1
    fi
    runuser -u synapsis -- git -C "$APP_DIR" merge --ff-only "origin/$BRANCH"
  fi

  exec env SYNAPSIS_APPLY_UPDATE=1 APP_DIR="$APP_DIR" DATA_DIR="$DATA_DIR" ENV_FILE="$ENV_FILE" BRANCH="$BRANCH" bash "$APP_DIR/deploy/update.sh"
fi

install_update_units
systemctl stop synapsis
systemctl start synapsis-maintenance

restore_service() {
  systemctl stop synapsis-maintenance 2>/dev/null || true
  systemctl start synapsis
}
trap restore_service EXIT

if [[ -f "${DATABASE_PATH:-$DATA_DIR/synapsis.db}" ]]; then
  database_file="${DATABASE_PATH:-$DATA_DIR/synapsis.db}"
  backup_root="$DATA_DIR/backups"
  backup_staging="$backup_root/.latest.$$"
  backup_dir="$backup_root/latest"
  install -d -o synapsis -g synapsis -m 0750 "$backup_root"
  rm -rf "$backup_staging"
  install -d -o synapsis -g synapsis -m 0750 "$backup_staging"
  cp "$database_file" "$backup_staging/synapsis.db"
  for suffix in -wal -shm; do
    if [[ -f "${database_file}${suffix}" ]]; then
      cp "${database_file}${suffix}" "$backup_staging/synapsis.db${suffix}"
    fi
  done
  chown -R synapsis:synapsis "$backup_staging"
  rm -rf "$backup_dir"
  mv "$backup_staging" "$backup_dir"
  find "$backup_root" -mindepth 1 -maxdepth 1 ! -name latest -exec rm -rf {} +
fi

runuser -u synapsis -- npm --prefix "$APP_DIR" ci
runuser -u synapsis -- npm --prefix "$APP_DIR" run db:migrate
runuser -u synapsis -- npm --prefix "$APP_DIR" run build

deployed_commit="$(runuser -u synapsis -- git -C "$APP_DIR" rev-parse HEAD)"
printf '%s\n' "$deployed_commit" | install -m 0644 -o synapsis -g synapsis /dev/stdin "$DEPLOYED_COMMIT_FILE"
install_update_units
systemctl stop synapsis-maintenance
systemctl start synapsis
trap - EXIT
echo "Synapsis updated successfully to ${deployed_commit:0:7}."
