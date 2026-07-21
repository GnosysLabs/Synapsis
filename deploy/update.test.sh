#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UPDATE_SCRIPT="$SCRIPT_DIR/update.sh"
FIXTURES=()

cleanup() {
  local fixture
  for fixture in "${FIXTURES[@]}"; do
    if [[ ( "$fixture" == /tmp/synapsis-update-test.* \
      || "$fixture" == /private/tmp/synapsis-update-test.* ) \
      && -d "$fixture" ]]; then
      rm -rf -- "$fixture"
    fi
  done
}
trap cleanup EXIT

fail() {
  echo "update.test.sh: $*" >&2
  exit 1
}

prepare_fixture() {
  FIXTURE="$(mktemp -d /tmp/synapsis-update-test.XXXXXX)"
  FIXTURE="$(cd "$FIXTURE" && pwd -P)"
  FIXTURES+=("$FIXTURE")
  APP_DIR="$FIXTURE/app"
  DATA_DIR="$FIXTURE/data"
  ENV_FILE="$FIXTURE/synapsis.env"
  RELEASES_DIR="$FIXTURE/releases"
  CURRENT_LINK="$FIXTURE/current"
  PREVIOUS_LINK="$DATA_DIR/previous-release"
  REMOTE_DIR="$FIXTURE/remote.git"
  SOURCE_DIR="$FIXTURE/source"
  FAKE_BIN="$FIXTURE/bin"
  FAKE_STATE_DIR="$FIXTURE/state"
  SERVICE_USER="$(id -un)"
  SERVICE_GROUP="$(id -gn)"

  mkdir -p "$SOURCE_DIR/deploy" "$DATA_DIR" "$FAKE_BIN" "$FAKE_STATE_DIR"
  git init --bare "$REMOTE_DIR" >/dev/null
  git init -b main "$SOURCE_DIR" >/dev/null
  git -C "$SOURCE_DIR" config user.name 'Synapsis updater test'
  git -C "$SOURCE_DIR" config user.email 'updater-test@synapsis.invalid'
  cp "$UPDATE_SCRIPT" "$SOURCE_DIR/deploy/update.sh"
  printf '{"name":"fixture","scripts":{"db:migrate":"true","build":"true","start:server":"true"}}\n' > "$SOURCE_DIR/package.json"
  printf 'old\n' > "$SOURCE_DIR/VERSION"
  git -C "$SOURCE_DIR" add .
  git -C "$SOURCE_DIR" commit -m old >/dev/null
  git -C "$SOURCE_DIR" remote add origin "$REMOTE_DIR"
  git -C "$SOURCE_DIR" push -u origin main >/dev/null 2>&1
  OLD_COMMIT="$(git -C "$SOURCE_DIR" rev-parse HEAD)"

  git clone --branch main "$REMOTE_DIR" "$APP_DIR" >/dev/null 2>&1
  mkdir -p "$APP_DIR/.next"
  printf 'old-build\n' > "$APP_DIR/.next/BUILD_ID"
  printf '%s\n' "$OLD_COMMIT" > "$DATA_DIR/deployed-commit"

  printf 'new\n' > "$SOURCE_DIR/VERSION"
  git -C "$SOURCE_DIR" add VERSION
  git -C "$SOURCE_DIR" commit -m new >/dev/null
  git -C "$SOURCE_DIR" push origin main >/dev/null 2>&1
  TARGET_COMMIT="$(git -C "$SOURCE_DIR" rev-parse HEAD)"

  cat > "$ENV_FILE" <<EOF
DATABASE_PATH=$DATA_DIR/synapsis.db
PORT=43821
AUTH_SECRET=test-auth-secret
E2EE_RECOVERY_SECRET=test-recovery-secret
NEXT_PUBLIC_NODE_DOMAIN=test.example
EOF
  printf 'pre-update-database\n' > "$DATA_DIR/synapsis.db"
  printf 'active\n' > "$FAKE_STATE_DIR/app"
  printf 'inactive\n' > "$FAKE_STATE_DIR/maintenance"
  : > "$FAKE_STATE_DIR/systemctl.log"
  : > "$FAKE_STATE_DIR/npm.log"

  cat > "$FAKE_BIN/runuser" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == "-u" ]]; then shift 2; fi
if [[ "${1:-}" == "--" ]]; then shift; fi
exec "$@"
EOF

  cat > "$FAKE_BIN/npm" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
prefix=''
args=("$@")
if [[ "${1:-}" == "--prefix" ]]; then
  prefix="$2"
  shift 2
fi
app_state="$(<"$FAKE_STATE_DIR/app")"
printf '%s|%s|%s\n' "$app_state" "${DATABASE_PATH:-}" "${args[*]}" >> "$FAKE_STATE_DIR/npm.log"
if [[ "${FAKE_FAIL_BUILD:-0}" == "1" && "${*:-}" == "run build" ]]; then
  exit 12
fi
if [[ "${*:-}" == "run db:migrate" ]]; then
  mkdir -p "$(dirname "${DATABASE_PATH:?}")"
  printf 'migrated-database\n' > "$DATABASE_PATH"
fi
if [[ "${*:-}" == "run build" ]]; then
  mkdir -p "$prefix/.next"
  printf 'new-build\n' > "$prefix/.next/BUILD_ID"
fi
EOF

  cat > "$FAKE_BIN/systemctl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$FAKE_STATE_DIR/systemctl.log"
command_name="${1:-}"
unit_name="${2:-}"
case "$command_name:$unit_name" in
  stop:fixture-app) printf 'inactive\n' > "$FAKE_STATE_DIR/app" ;;
  start:fixture-app) printf 'active\n' > "$FAKE_STATE_DIR/app" ;;
  stop:fixture-maintenance) printf 'inactive\n' > "$FAKE_STATE_DIR/maintenance" ;;
  start:fixture-maintenance) printf 'active\n' > "$FAKE_STATE_DIR/maintenance" ;;
esac
EOF

  cat > "$FAKE_BIN/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[[ "$(<"$FAKE_STATE_DIR/app")" == "active" ]] || exit 22
if [[ "${FAKE_FAIL_NEW_HEALTH:-0}" == "1" ]]; then
  resolved="$(readlink -f "$CURRENT_LINK")"
  [[ "$resolved" != "$RELEASES_DIR/"* ]] || exit 22
fi
exit 0
EOF

  cat > "$FAKE_BIN/flock" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF

  cat > "$FAKE_BIN/mv" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == "-Tf" ]]; then
  shift
  if /bin/mv --help 2>&1 | /usr/bin/grep -q -- '--no-target-directory'; then
    exec /bin/mv -Tf "$@"
  fi
  exec /bin/mv -fh "$@"
fi
exec /bin/mv "$@"
EOF

  cat > "$FAKE_BIN/install" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
directory_mode=0
positional=()
while (($#)); do
  case "$1" in
    -d) directory_mode=1; shift ;;
    -o|-g|-m) shift 2 ;;
    *) positional+=("$1"); shift ;;
  esac
done
if [[ "$directory_mode" == "1" ]]; then
  positional_count="${#positional[@]}"
  mkdir -p "${positional[$((positional_count - 1))]}"
  exit 0
fi
positional_count="${#positional[@]}"
source_path="${positional[$((positional_count - 2))]}"
destination_path="${positional[$((positional_count - 1))]}"
if [[ "$source_path" == "/dev/stdin" ]]; then
  /bin/cat > "$destination_path"
else
  /bin/cp "$source_path" "$destination_path"
fi
EOF

  chmod +x "$FAKE_BIN/runuser" "$FAKE_BIN/npm" "$FAKE_BIN/systemctl" "$FAKE_BIN/curl" "$FAKE_BIN/flock" "$FAKE_BIN/mv" "$FAKE_BIN/install"
}

run_updater() {
  env \
    PATH="$FAKE_BIN:$PATH" \
    FAKE_STATE_DIR="$FAKE_STATE_DIR" \
    APP_DIR="$APP_DIR" \
    DATA_DIR="$DATA_DIR" \
    ENV_FILE="$ENV_FILE" \
    RELEASES_DIR="$RELEASES_DIR" \
    CURRENT_LINK="$CURRENT_LINK" \
    PREVIOUS_LINK="$PREVIOUS_LINK" \
    REPO_URL="$REMOTE_DIR" \
    SERVICE_USER="$SERVICE_USER" \
    SERVICE_GROUP="$SERVICE_GROUP" \
    SERVICE_NAME=fixture-app \
    MAINTENANCE_SERVICE_NAME=fixture-maintenance \
    INSTALL_UPDATE_UNITS=0 \
    CAPTURE_MAINTENANCE_BRANDING=0 \
    HEALTHCHECK_TIMEOUT_SECONDS=2 \
    SYNAPSIS_ALLOW_NON_ROOT_FOR_TESTS=1 \
    CURRENT_LINK="$CURRENT_LINK" \
    "$@" \
    bash "$UPDATE_SCRIPT"
}

assert_staged_build_precedes_stop() {
  first_stop_line="$(awk '/^stop fixture-app$/ { print NR; exit }' "$FAKE_STATE_DIR/systemctl.log")"
  [[ -n "$first_stop_line" ]] || fail 'application service was never stopped for activation'
  while IFS='|' read -r app_state database_path npm_args; do
    if [[ "$npm_args" == *'ci'* || "$database_path" == "$RELEASES_DIR/"*'/.synapsis-build/'* ]]; then
      [[ "$app_state" == 'active' ]] || fail "staged work ran after the app stopped: $npm_args"
    fi
  done < "$FAKE_STATE_DIR/npm.log"
}

test_successful_atomic_activation() {
  prepare_fixture
  output="$(run_updater 2>"$FIXTURE/updater.err")"

  [[ "$(readlink -f "$CURRENT_LINK")" == "$RELEASES_DIR/$TARGET_COMMIT" ]] || fail 'new release was not activated'
  [[ "$(<"$DATA_DIR/deployed-commit")" == "$TARGET_COMMIT" ]] || fail 'deployed commit was not recorded'
  [[ "$(readlink -f "$PREVIOUS_LINK")" == "$APP_DIR" ]] || fail 'rollback release was not retained'
  [[ "$(<"$FAKE_STATE_DIR/app")" == 'active' ]] || fail 'application was not healthy after activation'
  [[ "$output" == *'visible maintenance lasted'* ]] || fail 'maintenance duration was not reported'
  assert_staged_build_precedes_stop

  real_migration_state="$(awk -F'|' -v data="$DATA_DIR/synapsis.db" '$2 == data { print $1 }' "$FAKE_STATE_DIR/npm.log" | tail -1)"
  [[ "$real_migration_state" == 'inactive' ]] || fail 'production migration did not run inside maintenance'
}

test_build_failure_leaves_live_release_untouched() {
  prepare_fixture
  if run_updater env FAKE_FAIL_BUILD=1 >/dev/null 2>&1; then
    fail 'build failure unexpectedly succeeded'
  fi

  [[ "$(<"$FAKE_STATE_DIR/app")" == 'active' ]] || fail 'build failure stopped the live app'
  [[ ! -s "$FAKE_STATE_DIR/systemctl.log" ]] || fail 'build failure touched systemd services'
  [[ "$(<"$DATA_DIR/deployed-commit")" == "$OLD_COMMIT" ]] || fail 'build failure changed deployed commit'
  [[ -L "$CURRENT_LINK" && "$(readlink -f "$CURRENT_LINK")" == "$APP_DIR" ]] || fail 'build failure changed current release'
}

test_failed_health_check_rolls_back() {
  prepare_fixture
  if run_updater env FAKE_FAIL_NEW_HEALTH=1 >/dev/null 2>&1; then
    fail 'failed health check unexpectedly succeeded'
  fi

  [[ "$(readlink -f "$CURRENT_LINK")" == "$APP_DIR" ]] || fail 'health failure did not restore previous release'
  [[ "$(<"$FAKE_STATE_DIR/app")" == 'active' ]] || fail 'previous release was not restarted'
  [[ "$(<"$DATA_DIR/deployed-commit")" == "$OLD_COMMIT" ]] || fail 'failed release was recorded as deployed'
  [[ -f "$RELEASES_DIR/$TARGET_COMMIT/.synapsis-release-failed" ]] || fail 'failed release was not quarantined'
  [[ "$(<"$DATA_DIR/synapsis.db")" == 'pre-update-database' ]] || fail 'health failure did not restore the database snapshot'

  : > "$FAKE_STATE_DIR/systemctl.log"
  if run_updater env FAKE_FAIL_NEW_HEALTH=1 >/dev/null 2>&1; then
    fail 'quarantined release unexpectedly succeeded on retry'
  fi
  [[ ! -s "$FAKE_STATE_DIR/systemctl.log" ]] || fail 'quarantined release caused another maintenance window'
}

test_successful_atomic_activation
test_build_failure_leaves_live_release_untouched
test_failed_health_check_rolls_back
echo 'Atomic updater tests passed.'
