#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/synapsis}"
DATA_DIR="${DATA_DIR:-/var/lib/synapsis}"
ENV_FILE="${ENV_FILE:-/etc/synapsis.env}"
RELEASES_DIR="${RELEASES_DIR:-${APP_DIR}-releases}"
CURRENT_LINK="${CURRENT_LINK:-${APP_DIR}-current}"

if [[ ${EUID} -ne 0 ]]; then
  echo "Run this uninstaller as root." >&2
  exit 1
fi

for removal_path in "$APP_DIR" "$RELEASES_DIR" "$DATA_DIR"; do
  if [[ "$removal_path" != /* \
    || "$removal_path" == "/" \
    || "$removal_path" == "/opt" \
    || "$removal_path" == "/var" \
    || "$removal_path" == "/var/lib" ]]; then
    echo "Refusing unsafe uninstall path: $removal_path" >&2
    exit 1
  fi
done

systemctl disable --now synapsis-update.timer 2>/dev/null || true
systemctl disable --now synapsis-update.path 2>/dev/null || true
systemctl stop synapsis-update.service 2>/dev/null || true
systemctl stop synapsis-maintenance.service 2>/dev/null || true
systemctl disable --now synapsis 2>/dev/null || true
rm -f /etc/systemd/system/synapsis.service \
  /etc/systemd/system/synapsis-maintenance.service \
  /etc/systemd/system/synapsis-update.service \
  /etc/systemd/system/synapsis-update.timer \
  /etc/systemd/system/synapsis-update.path
systemctl daemon-reload
rm -f "$DATA_DIR/update-requested"
if [[ -L "$CURRENT_LINK" ]]; then
  rm -f -- "$CURRENT_LINK"
fi
rm -rf -- "$APP_DIR" "$RELEASES_DIR"

if [[ "${1:-}" == "--purge-data" ]]; then
  rm -rf "$DATA_DIR"
  rm -f "$ENV_FILE"
  userdel synapsis 2>/dev/null || true
  echo "Synapsis and its database were removed."
else
  echo "Synapsis was removed; $DATA_DIR and $ENV_FILE were preserved."
fi
