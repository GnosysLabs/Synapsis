#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/instance-config.sh"

DEPLOYED_COMMIT_FILE="$DATA_DIR/deployed-commit"
UPDATE_REQUEST_FILE="$DATA_DIR/update-requested"
HEALTHCHECK_TIMEOUT_SECONDS="${HEALTHCHECK_TIMEOUT_SECONDS:-60}"
CAPTURE_MAINTENANCE_BRANDING="${CAPTURE_MAINTENANCE_BRANDING:-1}"
INSTALL_UPDATE_UNITS="${INSTALL_UPDATE_UNITS:-1}"

if [[ ${EUID} -ne 0 && "${SYNAPSIS_ALLOW_NON_ROOT_FOR_TESTS:-0}" != "1" ]]; then
  echo "Run this updater as root." >&2
  exit 1
fi

for command in cmp curl flock git install ln mv node npm openssl readlink runuser systemctl tar; do
  command -v "$command" >/dev/null || { echo "Missing required command: $command" >&2; exit 1; }
done

# A web-admin request is a one-shot signal. Remove it before any fallible work
# so a failed update cannot make the path unit retry in a tight loop.
rm -f -- "$UPDATE_REQUEST_FILE"

[[ -d "$APP_DIR/.git" ]] || { echo "No Synapsis checkout found at $APP_DIR" >&2; exit 1; }
[[ -f "$ENV_FILE" ]] || { echo "Missing $ENV_FILE" >&2; exit 1; }

install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 0750 "$DATA_DIR"
if [[ "${SYNAPSIS_UPDATE_LOCK_HELD:-0}" != "1" ]]; then
  exec 9>"$DATA_DIR/update.lock"
  if ! flock -n 9; then
    echo "A Synapsis update is already running."
    exit 0
  fi
fi

set -a
source "$ENV_FILE"
set +a

REPO_URL="${REPO_URL:-https://github.com/GnosysLabs/Synapsis.git}"
PORT="${PORT:-43821}"

if [[ ! "$PORT" =~ ^[0-9]{1,5}$ || "$PORT" -lt 1 || "$PORT" -gt 65535 ]]; then
  echo "PORT must be between 1 and 65535." >&2
  exit 1
fi
if [[ ! "$HEALTHCHECK_TIMEOUT_SECONDS" =~ ^[1-9][0-9]{0,3}$ ]]; then
  echo "HEALTHCHECK_TIMEOUT_SECONDS must be between 1 and 9999." >&2
  exit 1
fi
if [[ ! "$INSTALL_UPDATE_UNITS" =~ ^[01]$ || ! "$CAPTURE_MAINTENANCE_BRANDING" =~ ^[01]$ ]]; then
  echo "Updater feature flags must be 0 or 1." >&2
  exit 1
fi

# Existing installations predate encrypted-message recovery. Enroll them with
# a distinct stable secret before migrations/builds make E2EE available.
if [[ -z "${E2EE_RECOVERY_SECRET:-}" ]]; then
  E2EE_RECOVERY_SECRET="$(openssl rand -base64 48 | tr -d '\n')"
  printf '\nE2EE_RECOVERY_SECRET=%s\n' "$E2EE_RECOVERY_SECRET" >> "$ENV_FILE"
  export E2EE_RECOVERY_SECRET
  echo "Added E2EE_RECOVERY_SECRET to $ENV_FILE. Back it up separately from the database."
fi

atomic_symlink() {
  local target="$1"
  local link_path="$2"
  local temporary_link="${link_path}.new.$$"

  rm -f -- "$temporary_link"
  ln -s "$target" "$temporary_link"
  mv -Tf "$temporary_link" "$link_path"
}

install_update_units() {
  [[ "$INSTALL_UPDATE_UNITS" == "1" ]] || return 0

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

  local trigger
  for trigger in "${UPDATE_TIMER_NAME}.timer" "${UPDATE_PATH_NAME}.path"; do
    if ! systemctl is-enabled --quiet "$trigger"; then
      systemctl enable "$trigger"
    fi
    if ! systemctl is-active --quiet "$trigger"; then
      systemctl start "$trigger"
    fi
  done
}

wait_for_health() {
  local elapsed=0
  while (( elapsed < HEALTHCHECK_TIMEOUT_SECONDS )); do
    if curl --fail --silent --show-error --max-time 2 \
      "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  return 1
}

backup_database() {
  local database_file="${DATABASE_PATH:-$DATA_DIR/synapsis.db}"
  database_backup_attempted=1
  database_existed_before_update=0
  database_backup_created=0
  if [[ ! -f "$database_file" ]]; then
    return 0
  fi
  database_existed_before_update=1

  local backup_root="$DATA_DIR/backups"
  local backup_staging="$backup_root/.latest.$$"
  local backup_dir="$backup_root/latest"
  install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 0750 "$backup_root"
  rm -rf -- "$backup_staging"
  install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 0750 "$backup_staging"
  cp "$database_file" "$backup_staging/synapsis.db"
  local suffix
  for suffix in -wal -shm; do
    if [[ -f "${database_file}${suffix}" ]]; then
      cp "${database_file}${suffix}" "$backup_staging/synapsis.db${suffix}"
    fi
  done
  chown -R "$SERVICE_USER:$SERVICE_GROUP" "$backup_staging"
  rm -rf -- "$backup_dir"
  mv "$backup_staging" "$backup_dir"
  database_backup_created=1
}

restore_database_backup() {
  local database_file="${DATABASE_PATH:-$DATA_DIR/synapsis.db}"
  local backup_dir="$DATA_DIR/backups/latest"
  local suffix

  if [[ "$database_backup_attempted" != "1" ]]; then
    return 0
  fi
  if [[ "$database_backup_created" == "1" ]]; then
    rm -f -- "$database_file" "${database_file}-wal" "${database_file}-shm"
    cp "$backup_dir/synapsis.db" "$database_file"
    for suffix in -wal -shm; do
      if [[ -f "$backup_dir/synapsis.db${suffix}" ]]; then
        cp "$backup_dir/synapsis.db${suffix}" "${database_file}${suffix}"
      fi
    done
    chown "$SERVICE_USER:$SERVICE_GROUP" "$database_file"
    for suffix in -wal -shm; do
      if [[ -f "${database_file}${suffix}" ]]; then
        chown "$SERVICE_USER:$SERVICE_GROUP" "${database_file}${suffix}"
      fi
    done
  elif [[ "$database_existed_before_update" == "1" ]]; then
    echo "The pre-update database snapshot is unavailable; refusing an incomplete rollback." >&2
    return 1
  else
    rm -f -- "$database_file" "${database_file}-wal" "${database_file}-shm"
  fi
}

database_backup_attempted=0
database_existed_before_update=0
database_backup_created=0

current_repo_url="$(runuser -u "$SERVICE_USER" -- git -C "$APP_DIR" remote get-url origin 2>/dev/null || true)"
if [[ "$current_repo_url" != "$REPO_URL" ]]; then
  if [[ -n "$current_repo_url" ]]; then
    runuser -u "$SERVICE_USER" -- git -C "$APP_DIR" remote set-url origin "$REPO_URL"
  else
    runuser -u "$SERVICE_USER" -- git -C "$APP_DIR" remote add origin "$REPO_URL"
  fi
  echo "Synapsis update source set to $REPO_URL."
fi

runuser -u "$SERVICE_USER" -- git -C "$APP_DIR" fetch --prune origin "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH"

current_commit="$(runuser -u "$SERVICE_USER" -- git -C "$APP_DIR" rev-parse HEAD)"
target_commit="$(runuser -u "$SERVICE_USER" -- git -C "$APP_DIR" rev-parse "origin/$BRANCH")"
target_commit_count="$(runuser -u "$SERVICE_USER" -- git -C "$APP_DIR" rev-list --count "$target_commit")"
deployed_commit=""
if [[ -f "$DEPLOYED_COMMIT_FILE" ]]; then
  deployed_commit="$(tr -d '[:space:]' < "$DEPLOYED_COMMIT_FILE")"
fi

if [[ "$current_commit" != "$target_commit" ]]; then
  if ! runuser -u "$SERVICE_USER" -- git -C "$APP_DIR" merge-base --is-ancestor "$current_commit" "$target_commit"; then
    echo "Cannot auto-update: local checkout has diverged from origin/$BRANCH." >&2
    exit 1
  fi
  runuser -u "$SERVICE_USER" -- git -C "$APP_DIR" merge --ff-only "origin/$BRANCH"
fi

# A release can change the updater itself. Re-exec the version from the target
# commit before building so critical deployment fixes take effect immediately,
# while retaining the already acquired per-instance lock.
if [[ "${SYNAPSIS_UPDATER_TARGET:-}" != "$target_commit" ]]; then
  updater_reexec_count="${SYNAPSIS_UPDATER_REEXEC_COUNT:-0}"
  if [[ ! "$updater_reexec_count" =~ ^[0-3]$ || "$updater_reexec_count" == "3" ]]; then
    echo "The target branch changed repeatedly during update preparation; retrying on the next check." >&2
    exit 1
  fi
  exec env \
    INSTANCE="$INSTANCE" \
    APP_DIR="$APP_DIR" \
    DATA_DIR="$DATA_DIR" \
    ENV_FILE="$ENV_FILE" \
    BRANCH="$BRANCH" \
    REPO_URL="$REPO_URL" \
    SERVICE_USER="$SERVICE_USER" \
    SERVICE_GROUP="$SERVICE_GROUP" \
    SERVICE_NAME="$SERVICE_NAME" \
    MAINTENANCE_SERVICE_NAME="$MAINTENANCE_SERVICE_NAME" \
    UPDATE_SERVICE_NAME="$UPDATE_SERVICE_NAME" \
    UPDATE_TIMER_NAME="$UPDATE_TIMER_NAME" \
    UPDATE_PATH_NAME="$UPDATE_PATH_NAME" \
    RELEASES_DIR="$RELEASES_DIR" \
    CURRENT_LINK="$CURRENT_LINK" \
    PREVIOUS_LINK="$PREVIOUS_LINK" \
    INSTALL_UPDATE_UNITS="$INSTALL_UPDATE_UNITS" \
    CAPTURE_MAINTENANCE_BRANDING="$CAPTURE_MAINTENANCE_BRANDING" \
    HEALTHCHECK_TIMEOUT_SECONDS="$HEALTHCHECK_TIMEOUT_SECONDS" \
    SYNAPSIS_ALLOW_NON_ROOT_FOR_TESTS="${SYNAPSIS_ALLOW_NON_ROOT_FOR_TESTS:-0}" \
    SYNAPSIS_UPDATE_LOCK_HELD=1 \
    SYNAPSIS_UPDATER_TARGET="$target_commit" \
    SYNAPSIS_UPDATER_REEXEC_COUNT="$((updater_reexec_count + 1))" \
    bash "$APP_DIR/deploy/update.sh"
fi

install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 0755 "$RELEASES_DIR"
if [[ -e "$CURRENT_LINK" && ! -L "$CURRENT_LINK" ]]; then
  echo "$CURRENT_LINK exists but is not a symlink; refusing an unsafe release switch." >&2
  exit 1
fi
if [[ ! -L "$CURRENT_LINK" ]]; then
  atomic_symlink "$APP_DIR" "$CURRENT_LINK"
fi
if [[ -e "$PREVIOUS_LINK" && ! -L "$PREVIOUS_LINK" ]]; then
  echo "$PREVIOUS_LINK exists but is not a symlink; refusing to replace it." >&2
  exit 1
fi

install_update_units

release_dir="$RELEASES_DIR/$target_commit"
release_marker="$release_dir/.synapsis-release-complete"
release_failure_marker="$release_dir/.synapsis-release-failed"
current_release="$(readlink -f "$CURRENT_LINK")"
if [[ ! -d "$current_release" ]]; then
  echo "The active release link points to a missing directory: $current_release" >&2
  exit 1
fi
if [[ "$deployed_commit" == "$target_commit" && "$current_release" == "$release_dir" && -f "$release_marker" ]]; then
  echo "Synapsis is already current at ${target_commit:0:7}."
  exit 0
fi
if [[ -f "$release_failure_marker" ]]; then
  echo "Release ${target_commit:0:7} previously failed activation; waiting for a newer commit." >&2
  exit 1
fi

# Everything through the production build happens beside the running release.
# The build gets its own database so module evaluation cannot touch or lock the
# live embedded database.
staging_dir=""
cleanup_staging() {
  if [[ -n "$staging_dir" && "$staging_dir" == "$RELEASES_DIR/"* && -d "$staging_dir" ]]; then
    rm -rf -- "$staging_dir"
  fi
}
trap cleanup_staging EXIT

if [[ ! -f "$release_marker" ]]; then
  if [[ -d "$release_dir" ]]; then
    rm -rf -- "$release_dir"
  fi
  staging_dir="$(mktemp -d "$RELEASES_DIR/.stage-${target_commit:0:12}.XXXXXX")"
  runuser -u "$SERVICE_USER" -- git -C "$APP_DIR" archive "$target_commit" | tar -x -C "$staging_dir"
  chown -R "$SERVICE_USER:$SERVICE_GROUP" "$staging_dir"

  echo "Building Synapsis ${target_commit:0:7} while the current release stays online..."
  runuser -u "$SERVICE_USER" -- npm --prefix "$staging_dir" ci

  build_data_dir="$staging_dir/.synapsis-build"
  build_database="$build_data_dir/synapsis.db"
  install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 0750 "$build_data_dir"
  runuser -u "$SERVICE_USER" -- env \
    DATABASE_PATH="$build_database" \
    APP_COMMIT="$target_commit" \
    APP_COMMIT_COUNT="$target_commit_count" \
    APP_BUILD_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    npm --prefix "$staging_dir" run db:migrate
  runuser -u "$SERVICE_USER" -- env \
    DATABASE_PATH="$build_database" \
    APP_COMMIT="$target_commit" \
    APP_COMMIT_COUNT="$target_commit_count" \
    APP_BUILD_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    npm --prefix "$staging_dir" run build
  rm -rf -- "$build_data_dir"
  touch "$staging_dir/.synapsis-release-complete"
  mv "$staging_dir" "$release_dir"
  staging_dir=""
fi

previous_release="$(readlink -f "$CURRENT_LINK")"
if [[ "$CAPTURE_MAINTENANCE_BRANDING" == "1" ]]; then
  if ! runuser -u "$SERVICE_USER" -- env \
    PORT="$PORT" \
    MAINTENANCE_APP_DIR="$previous_release" \
    MAINTENANCE_DATA_DIR="$DATA_DIR" \
    node "$APP_DIR/deploy/maintenance-server.mjs" --capture-branding; then
    echo "Warning: could not refresh maintenance-page branding; using the last captured branding." >&2
  fi
fi

maintenance_started=0
recover_previous_release() {
  local original_status="$1"
  trap - EXIT
  set +e
  if [[ -d "$release_dir" ]]; then
    touch "$release_failure_marker"
  fi
  echo "Update activation failed; restoring the previous release." >&2
  systemctl stop "$SERVICE_NAME" 2>/dev/null
  systemctl start "$MAINTENANCE_SERVICE_NAME" 2>/dev/null
  atomic_symlink "$previous_release" "$CURRENT_LINK"
  if ! restore_database_backup; then
    systemctl stop "$SERVICE_NAME" 2>/dev/null
    systemctl start "$MAINTENANCE_SERVICE_NAME" 2>/dev/null
    echo "Database rollback failed; maintenance mode remains active." >&2
    exit "$original_status"
  fi
  systemctl stop "$MAINTENANCE_SERVICE_NAME" 2>/dev/null
  if systemctl start "$SERVICE_NAME" && wait_for_health; then
    echo "Previous release restored successfully." >&2
  else
    systemctl stop "$SERVICE_NAME" 2>/dev/null
    systemctl start "$MAINTENANCE_SERVICE_NAME" 2>/dev/null
    echo "Previous release did not recover; maintenance mode remains active." >&2
  fi
  exit "$original_status"
}

activation_failed() {
  local status=$?
  cleanup_staging
  if [[ "$maintenance_started" == "1" ]]; then
    recover_previous_release "$status"
  fi
  exit "$status"
}
trap activation_failed EXIT

maintenance_started_at="$(date +%s)"
systemctl stop "$SERVICE_NAME"
maintenance_started=1
systemctl start "$MAINTENANCE_SERVICE_NAME"

backup_database
runuser -u "$SERVICE_USER" -- npm --prefix "$release_dir" run db:migrate
atomic_symlink "$previous_release" "$PREVIOUS_LINK"
atomic_symlink "$release_dir" "$CURRENT_LINK"

systemctl stop "$MAINTENANCE_SERVICE_NAME"
systemctl start "$SERVICE_NAME"
if ! wait_for_health; then
  recover_previous_release 1
fi
maintenance_started=0

printf '%s\n' "$target_commit" | install -m 0644 -o "$SERVICE_USER" -g "$SERVICE_GROUP" /dev/stdin "$DEPLOYED_COMMIT_FILE"

# Keep only the active release and its immediate rollback target. Release
# directory names are full Git object IDs, so refuse to remove anything else.
active_release="$(readlink -f "$CURRENT_LINK")"
rollback_release="$(readlink -f "$PREVIOUS_LINK")"
while IFS= read -r candidate; do
  candidate_name="$(basename "$candidate")"
  if [[ "$candidate_name" =~ ^[0-9a-f]{40}$ \
    && "$candidate" != "$active_release" \
    && "$candidate" != "$rollback_release" ]]; then
    rm -rf -- "$candidate"
  fi
done < <(find "$RELEASES_DIR" -mindepth 1 -maxdepth 1 -type d -print)

trap - EXIT
maintenance_seconds=$(( $(date +%s) - maintenance_started_at ))
echo "Synapsis updated successfully to ${target_commit:0:7}; visible maintenance lasted ${maintenance_seconds}s."
