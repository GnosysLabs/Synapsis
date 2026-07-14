#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/synapsis}"
DATA_DIR="${DATA_DIR:-/var/lib/synapsis}"
ENV_FILE="${ENV_FILE:-/etc/synapsis.env}"

if [[ ${EUID} -ne 0 ]]; then
  echo "Run this uninstaller as root." >&2
  exit 1
fi

systemctl disable --now synapsis 2>/dev/null || true
rm -f /etc/systemd/system/synapsis.service
systemctl daemon-reload
rm -rf "$APP_DIR"

if [[ "${1:-}" == "--purge-data" ]]; then
  rm -rf "$DATA_DIR"
  rm -f "$ENV_FILE"
  userdel synapsis 2>/dev/null || true
  echo "Synapsis and its database were removed."
else
  echo "Synapsis was removed; $DATA_DIR and $ENV_FILE were preserved."
fi
