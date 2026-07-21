#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PURGE_DATA=0

while (($#)); do
  case "$1" in
    --instance)
      [[ $# -ge 2 ]] || { echo "--instance requires a name." >&2; exit 2; }
      INSTANCE="$2"
      shift 2
      ;;
    --purge-data)
      PURGE_DATA=1
      shift
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 2
      ;;
  esac
done

source "$SCRIPT_DIR/instance-config.sh"

if [[ ${EUID} -ne 0 ]]; then
  echo "Run this uninstaller as root." >&2
  exit 1
fi

for removal_path in "$APP_DIR" "$RELEASES_DIR" "$DATA_DIR"; do
  if [[ "$removal_path" == "/" \
    || "$removal_path" == "/opt" \
    || "$removal_path" == "/var" \
    || "$removal_path" == "/var/lib" ]]; then
    echo "Refusing unsafe uninstall path: $removal_path" >&2
    exit 1
  fi
done

systemctl disable --now "${UPDATE_TIMER_NAME}.timer" 2>/dev/null || true
systemctl disable --now "${UPDATE_PATH_NAME}.path" 2>/dev/null || true
systemctl stop "${UPDATE_SERVICE_NAME}.service" 2>/dev/null || true
systemctl disable --now "${SERVICE_NAME}.service" 2>/dev/null || true
systemctl stop "${MAINTENANCE_SERVICE_NAME}.service" 2>/dev/null || true
if [[ -n "$INSTANCE" ]]; then
  systemctl disable --now "synapsis-update@${INSTANCE}.path" 2>/dev/null || true
fi

rm -f -- \
  "/etc/systemd/system/${SERVICE_NAME}.service" \
  "/etc/systemd/system/${MAINTENANCE_SERVICE_NAME}.service" \
  "/etc/systemd/system/${UPDATE_SERVICE_NAME}.service" \
  "/etc/systemd/system/${UPDATE_TIMER_NAME}.timer" \
  "/etc/systemd/system/${UPDATE_PATH_NAME}.path"
systemctl daemon-reload
rm -f -- "$DATA_DIR/update-requested"
if [[ -L "$CURRENT_LINK" ]]; then
  rm -f -- "$CURRENT_LINK"
fi
rm -rf -- "$APP_DIR" "$RELEASES_DIR"

if [[ "$PURGE_DATA" == "1" ]]; then
  rm -rf -- "$DATA_DIR"
  rm -f -- "$ENV_FILE"
  userdel "$SERVICE_USER" 2>/dev/null || true
  echo "Removed Synapsis ${INSTANCE:-primary instance}, including its database and environment file."
else
  echo "Removed Synapsis ${INSTANCE:-primary instance}. Preserved $DATA_DIR and $ENV_FILE."
fi
