#!/bin/sh

set -eu

REPO="${REPO:-GnosysLabs/Synapsis}"
REF="${REF:-main}"
INSTALL_DIR="${1:-${INSTALL_DIR:-/opt/synapsis}}"
RAW_BASE="https://raw.githubusercontent.com/${REPO}/${REF}"

require_command() {
    if ! command -v "$1" >/dev/null 2>&1; then
        echo "❌ Required command not found: $1" >&2
        exit 1
    fi
}

download_file() {
    source_path="$1"
    target_path="$2"
    echo "⬇️  Downloading ${source_path}"
    curl -fsSL "${RAW_BASE}/${source_path}" -o "${target_path}"
}

detect_proxy_mode() {
    if [ -f "${INSTALL_DIR}/Caddyfile" ] || [ -f "${INSTALL_DIR}/caddy-entrypoint.sh" ]; then
        printf 'caddy\n'
        return
    fi

    printf 'none\n'
}

compose_cmd() {
    if [ -f "${INSTALL_DIR}/.env" ]; then
        docker compose --env-file "${INSTALL_DIR}/.env" -f "${INSTALL_DIR}/docker-compose.yml" "$@"
    else
        docker compose -f "${INSTALL_DIR}/docker-compose.yml" "$@"
    fi
}

require_command curl
require_command docker
require_command chmod
require_command mkdir

if [ ! -d "${INSTALL_DIR}" ]; then
    echo "❌ ${INSTALL_DIR} does not exist." >&2
    exit 1
fi

ACTIVE_PROXY="$(detect_proxy_mode)"

case "${ACTIVE_PROXY}" in
    caddy)
        download_file "docker-compose.yml" "${INSTALL_DIR}/docker-compose.yml"
        download_file "docker/Caddyfile" "${INSTALL_DIR}/Caddyfile"
        download_file "docker/caddy-entrypoint.sh" "${INSTALL_DIR}/caddy-entrypoint.sh"
        chmod 755 "${INSTALL_DIR}/caddy-entrypoint.sh"
        ;;
    none)
        download_file "docker-compose.proxyless.yml" "${INSTALL_DIR}/docker-compose.yml"
        rm -f "${INSTALL_DIR}/Caddyfile" "${INSTALL_DIR}/caddy-entrypoint.sh"
        ;;
esac

download_file "docker/host-updater.py" "${INSTALL_DIR}/host-updater.py"
download_file "docker/update-local.sh" "${INSTALL_DIR}/update-local.sh"
chmod 755 "${INSTALL_DIR}/host-updater.py" "${INSTALL_DIR}/update-local.sh"

echo "🐳 Pulling latest Synapsis image"
compose_cmd pull

echo "🚀 Restarting Synapsis"
compose_cmd up -d --remove-orphans

echo ""
echo "✅ Synapsis has been updated to the latest published image."
