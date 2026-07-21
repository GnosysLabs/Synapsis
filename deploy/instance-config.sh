#!/usr/bin/env bash

# Shared deployment naming for the primary node and any number of sibling
# instances on the same server. Callers may override individual values before
# sourcing this file, but a named instance gets safe, isolated defaults.
INSTANCE="${INSTANCE:-}"
if [[ "$INSTANCE" == "default" ]]; then
  INSTANCE=""
fi
if [[ -n "$INSTANCE" && ! "$INSTANCE" =~ ^[a-z0-9][a-z0-9-]{0,22}$ ]]; then
  echo "INSTANCE must be 1-23 lowercase letters, numbers, or hyphens." >&2
  return 1 2>/dev/null || exit 1
fi

instance_service_default="synapsis"
if [[ -n "$INSTANCE" ]]; then
  instance_service_default="synapsis-$INSTANCE"
fi

SERVICE_NAME="${SERVICE_NAME:-$instance_service_default}"
SERVICE_USER="${SERVICE_USER:-$SERVICE_NAME}"
SERVICE_GROUP="${SERVICE_GROUP:-$SERVICE_USER}"
MAINTENANCE_SERVICE_NAME="${MAINTENANCE_SERVICE_NAME:-${SERVICE_NAME}-maintenance}"
UPDATE_SERVICE_NAME="${UPDATE_SERVICE_NAME:-${SERVICE_NAME}-update}"
UPDATE_TIMER_NAME="${UPDATE_TIMER_NAME:-$UPDATE_SERVICE_NAME}"
UPDATE_PATH_NAME="${UPDATE_PATH_NAME:-$UPDATE_SERVICE_NAME}"

APP_DIR="${APP_DIR:-/opt/$SERVICE_NAME}"
DATA_DIR="${DATA_DIR:-/var/lib/$SERVICE_NAME}"
ENV_FILE="${ENV_FILE:-/etc/$SERVICE_NAME.env}"
RELEASES_DIR="${RELEASES_DIR:-${APP_DIR}-releases}"
CURRENT_LINK="${CURRENT_LINK:-${APP_DIR}-current}"
PREVIOUS_LINK="${PREVIOUS_LINK:-$DATA_DIR/previous-release}"
REPO_URL="${REPO_URL:-https://github.com/GnosysLabs/Synapsis.git}"
BRANCH="${BRANCH:-main}"

for instance_path_name in APP_DIR DATA_DIR ENV_FILE RELEASES_DIR CURRENT_LINK PREVIOUS_LINK; do
  instance_path_value="${!instance_path_name}"
  if [[ ! "$instance_path_value" =~ ^/[a-zA-Z0-9._/-]+$ \
    || "$instance_path_value" == "/" \
    || "$instance_path_value" == *"/../"* \
    || "$instance_path_value" == */.. \
    || "$instance_path_value" == *"/./"* ]]; then
    echo "$instance_path_name must be a specific absolute path without whitespace or traversal." >&2
    return 1 2>/dev/null || exit 1
  fi
done
unset instance_path_name instance_path_value

if [[ ! "$SERVICE_USER" =~ ^[a-z_][a-z0-9_-]*[$]?$ || ${#SERVICE_USER} -gt 32 ]]; then
  echo "Invalid SERVICE_USER." >&2
  return 1 2>/dev/null || exit 1
fi
if [[ ! "$SERVICE_GROUP" =~ ^[a-z_][a-z0-9_-]*[$]?$ || ${#SERVICE_GROUP} -gt 32 ]]; then
  echo "Invalid SERVICE_GROUP." >&2
  return 1 2>/dev/null || exit 1
fi
for instance_unit_name in SERVICE_NAME MAINTENANCE_SERVICE_NAME UPDATE_SERVICE_NAME UPDATE_TIMER_NAME UPDATE_PATH_NAME; do
  instance_unit_value="${!instance_unit_name}"
  if [[ ! "$instance_unit_value" =~ ^[a-zA-Z0-9_.@-]+$ ]]; then
    echo "Invalid systemd unit name in $instance_unit_name." >&2
    return 1 2>/dev/null || exit 1
  fi
done
unset instance_unit_name instance_unit_value instance_service_default

if [[ ! "$BRANCH" =~ ^[a-zA-Z0-9._/-]+$ || "$BRANCH" == -* || "$BRANCH" == *..* ]]; then
  echo "Invalid BRANCH." >&2
  return 1 2>/dev/null || exit 1
fi
if [[ "$REPO_URL" =~ [[:space:]%\"] ]]; then
  echo "REPO_URL contains characters that cannot be written safely to a systemd unit." >&2
  return 1 2>/dev/null || exit 1
fi
