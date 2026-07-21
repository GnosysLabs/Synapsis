#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/instance-config.sh"

SYSTEMD_DIR="${SYSTEMD_DIR:-/etc/systemd/system}"
if [[ ! "$SYSTEMD_DIR" =~ ^/[a-zA-Z0-9._/-]+$ || "$SYSTEMD_DIR" == "/" ]]; then
  echo "SYSTEMD_DIR must be a specific absolute path." >&2
  exit 1
fi
if [[ ${EUID} -ne 0 && "${SYNAPSIS_ALLOW_NON_ROOT_FOR_TESTS:-0}" != "1" ]]; then
  echo "Run this unit installer as root." >&2
  exit 1
fi

for command in cmp install mktemp; do
  command -v "$command" >/dev/null || { echo "Missing required command: $command" >&2; exit 1; }
done

unit_staging="$(mktemp -d "${TMPDIR:-/tmp}/synapsis-units.XXXXXX")"
cleanup_units() {
  if [[ "$unit_staging" == "${TMPDIR:-/tmp}/synapsis-units."* && -d "$unit_staging" ]]; then
    rm -rf -- "$unit_staging"
  fi
}
trap cleanup_units EXIT

cat > "$unit_staging/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=Synapsis node${INSTANCE:+ ($INSTANCE)}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_GROUP
WorkingDirectory=$CURRENT_LINK
EnvironmentFile=$ENV_FILE
Environment=NODE_ENV=production
ExecStart=/usr/bin/env npm run start:server
Restart=on-failure
RestartSec=5
TimeoutStartSec=90
TimeoutStopSec=30
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$DATA_DIR $CURRENT_LINK/.next

[Install]
WantedBy=multi-user.target
EOF

cat > "$unit_staging/${MAINTENANCE_SERVICE_NAME}.service" <<EOF
[Unit]
Description=Synapsis update maintenance page${INSTANCE:+ ($INSTANCE)}
After=network-online.target
Wants=network-online.target
Conflicts=${SERVICE_NAME}.service

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_GROUP
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
Environment=MAINTENANCE_APP_DIR=$CURRENT_LINK
Environment=MAINTENANCE_DATA_DIR=$DATA_DIR
ExecStart=/usr/bin/env node $APP_DIR/deploy/maintenance-server.mjs
Restart=on-failure
RestartSec=1
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$DATA_DIR
EOF

cat > "$unit_staging/${UPDATE_SERVICE_NAME}.service" <<EOF
[Unit]
Description=Update Synapsis${INSTANCE:+ instance $INSTANCE} to the latest $BRANCH commit
After=network-online.target
Wants=network-online.target
ConditionPathExists=$APP_DIR/.git

[Service]
Type=oneshot
Environment="INSTANCE=$INSTANCE"
Environment="APP_DIR=$APP_DIR"
Environment="DATA_DIR=$DATA_DIR"
Environment="ENV_FILE=$ENV_FILE"
Environment="RELEASES_DIR=$RELEASES_DIR"
Environment="CURRENT_LINK=$CURRENT_LINK"
Environment="PREVIOUS_LINK=$PREVIOUS_LINK"
Environment="REPO_URL=$REPO_URL"
Environment="BRANCH=$BRANCH"
Environment="SERVICE_USER=$SERVICE_USER"
Environment="SERVICE_GROUP=$SERVICE_GROUP"
Environment="SERVICE_NAME=$SERVICE_NAME"
Environment="MAINTENANCE_SERVICE_NAME=$MAINTENANCE_SERVICE_NAME"
Environment="UPDATE_SERVICE_NAME=$UPDATE_SERVICE_NAME"
Environment="UPDATE_TIMER_NAME=$UPDATE_TIMER_NAME"
Environment="UPDATE_PATH_NAME=$UPDATE_PATH_NAME"
Environment="INSTALL_UPDATE_UNITS=1"
ExecStart=/usr/bin/env bash $APP_DIR/deploy/update.sh
TimeoutStartSec=30min
UMask=0027
EOF

cat > "$unit_staging/${UPDATE_TIMER_NAME}.timer" <<EOF
[Unit]
Description=Keep Synapsis${INSTANCE:+ instance $INSTANCE} on the latest $BRANCH commit

[Timer]
OnBootSec=5min
OnUnitInactiveSec=15min
RandomizedDelaySec=30min
AccuracySec=1min
Persistent=true
Unit=${UPDATE_SERVICE_NAME}.service

[Install]
WantedBy=timers.target
EOF

cat > "$unit_staging/${UPDATE_PATH_NAME}.path" <<EOF
[Unit]
Description=Start a Synapsis${INSTANCE:+ $INSTANCE} update when requested by an administrator

[Path]
PathExists=$DATA_DIR/update-requested
Unit=${UPDATE_SERVICE_NAME}.service

[Install]
WantedBy=multi-user.target
EOF


install -d -m 0755 "$SYSTEMD_DIR"
units_changed=0
for unit_path in "$unit_staging"/*; do
  installed_unit="$SYSTEMD_DIR/$(basename "$unit_path")"
  if ! cmp -s "$unit_path" "$installed_unit"; then
    install -m 0644 "$unit_path" "$installed_unit"
    units_changed=1
  fi
done

if [[ "$units_changed" == "1" && "${SKIP_SYSTEMD_RELOAD:-0}" != "1" ]]; then
  systemctl daemon-reload
fi

if [[ "$units_changed" == "1" ]]; then
  echo "Installed systemd units for ${INSTANCE:-the primary Synapsis instance}."
else
  echo "Systemd units are current for ${INSTANCE:-the primary Synapsis instance}."
fi
