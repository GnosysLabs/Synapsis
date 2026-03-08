#!/bin/sh

set -eu

REPO="${REPO:-GnosysLabs/Synapsis}"
REF="${REF:-main}"
INSTALL_DIR="${1:-${INSTALL_DIR:-/opt/synapsis}}"
RAW_BASE="https://raw.githubusercontent.com/${REPO}/${REF}"
PROXY="${PROXY:-}"
HOST_UPDATER_SOCKET_PATH="${HOST_UPDATER_SOCKET_PATH:-/var/run/synapsis-updater/updater.sock}"

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

set_env_value() {
    file="$1"
    key="$2"
    value="$3"

    escaped_value=$(printf '%s\n' "$value" | sed -e 's/[\/&]/\\&/g')
    sed -i.bak -E "s|^${key}=.*$|${key}=${escaped_value}|" "$file"
    rm -f "${file}.bak"
}

ensure_env_value() {
    file="$1"
    key="$2"
    value="$3"

    if grep -q "^${key}=" "$file" 2>/dev/null; then
        set_env_value "$file" "$key" "$value"
        return
    fi

    printf '%s=%s\n' "$key" "$value" >> "$file"
}

get_env_value() {
    file="$1"
    key="$2"
    sed -n -E "s/^${key}=(.*)$/\\1/p" "$file" | head -n 1
}

generate_token() {
    if command -v openssl >/dev/null 2>&1; then
        openssl rand -hex 32
        return
    fi

    date +%s | sha256sum | awk '{print $1}'
}

normalize_proxy_mode() {
    case "$1" in
        caddy|none)
            printf '%s\n' "$1"
            ;;
        *)
            echo "❌ Unsupported PROXY mode: $1" >&2
            echo "   Supported values: caddy, none" >&2
            exit 1
            ;;
    esac
}

detect_proxy_mode() {
    if [ -n "${PROXY}" ]; then
        normalize_proxy_mode "${PROXY}"
        return
    fi

    if [ -f "${INSTALL_DIR}/Caddyfile" ] || [ -f "${INSTALL_DIR}/caddy-entrypoint.sh" ]; then
        printf 'caddy\n'
        return
    fi

    printf 'none\n'
}

install_python3_if_needed() {
    if command -v python3 >/dev/null 2>&1; then
        return
    fi

    if command -v apt-get >/dev/null 2>&1; then
        apt-get update
        apt-get install -y python3
        return
    fi

    if command -v apk >/dev/null 2>&1; then
        apk add --no-cache python3
        return
    fi
}

install_host_updater() {
    if [ "$(id -u)" -ne 0 ]; then
        return
    fi

    if [ ! -f "${INSTALL_DIR}/.env" ]; then
        return
    fi

    download_file "docker/host-updater.py" "${INSTALL_DIR}/host-updater.py"
    download_file "docker/update-local.sh" "${INSTALL_DIR}/update-local.sh"
    chmod 755 "${INSTALL_DIR}/host-updater.py" "${INSTALL_DIR}/update-local.sh"

    mkdir -p "$(dirname "${HOST_UPDATER_SOCKET_PATH}")"

    updater_token="$(get_env_value "${INSTALL_DIR}/.env" "HOST_UPDATER_TOKEN" || true)"
    if [ -z "${updater_token}" ]; then
        updater_token="$(generate_token)"
        ensure_env_value "${INSTALL_DIR}/.env" "HOST_UPDATER_TOKEN" "${updater_token}"
    fi

    ensure_env_value "${INSTALL_DIR}/.env" "HOST_UPDATER_SOCKET" "${HOST_UPDATER_SOCKET_PATH}"

    if ! command -v systemctl >/dev/null 2>&1; then
        return
    fi

    install_python3_if_needed
    if ! command -v python3 >/dev/null 2>&1; then
        return
    fi

    cat > "${INSTALL_DIR}/updater.env" <<EOF
HOST_UPDATER_TOKEN=${updater_token}
REPO=${REPO}
REF=${REF}
EOF
    chmod 600 "${INSTALL_DIR}/updater.env"

    cat > /etc/systemd/system/synapsis-updater.service <<EOF
[Unit]
Description=Synapsis Host Updater
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
User=root
Group=root
WorkingDirectory=${INSTALL_DIR}
Environment=INSTALL_DIR=${INSTALL_DIR}
Environment=HOST_UPDATER_SOCKET=${HOST_UPDATER_SOCKET_PATH}
Environment=HOST_UPDATER_STATUS_FILE=${INSTALL_DIR}/updater-status.json
Environment=HOST_UPDATER_LOG_FILE=${INSTALL_DIR}/updater.log
Environment=HOST_UPDATER_SCRIPT=${INSTALL_DIR}/update-local.sh
EnvironmentFile=${INSTALL_DIR}/updater.env
ExecStart=/usr/bin/env python3 ${INSTALL_DIR}/host-updater.py
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

    systemctl daemon-reload
    systemctl enable --now synapsis-updater.service >/dev/null 2>&1 || true
    systemctl restart synapsis-updater.service >/dev/null 2>&1 || true
}

require_command curl
require_command docker
require_command chmod
require_command mkdir

if [ ! -d "${INSTALL_DIR}" ]; then
    echo "❌ ${INSTALL_DIR} does not exist." >&2
    echo "   Run the installer first:" >&2
    echo "   curl -fsSL https://synapsis.social/install.sh | bash" >&2
    exit 1
fi

if [ ! -f "${INSTALL_DIR}/docker-compose.yml" ]; then
    echo "❌ ${INSTALL_DIR}/docker-compose.yml was not found." >&2
    echo "   This does not look like a Synapsis install directory." >&2
    exit 1
fi

ACTIVE_PROXY="$(detect_proxy_mode)"

echo "========================================"
echo "  Synapsis Docker Updater"
echo "========================================"
echo "  Repo: ${REPO}"
echo "  Ref: ${REF}"
echo "  Install dir: ${INSTALL_DIR}"
echo "  Proxy mode: ${ACTIVE_PROXY}"
echo "========================================"

mkdir -p "${INSTALL_DIR}"

download_file "docker/.env.example" "${INSTALL_DIR}/.env.example"

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

install_host_updater

echo "🐳 Pulling latest Synapsis image"
if [ -f "${INSTALL_DIR}/.env" ]; then
    docker compose --env-file "${INSTALL_DIR}/.env" -f "${INSTALL_DIR}/docker-compose.yml" pull
    echo "🚀 Restarting Synapsis"
    docker compose --env-file "${INSTALL_DIR}/.env" -f "${INSTALL_DIR}/docker-compose.yml" up -d --remove-orphans
else
    docker compose -f "${INSTALL_DIR}/docker-compose.yml" pull
    echo "🚀 Restarting Synapsis"
    docker compose -f "${INSTALL_DIR}/docker-compose.yml" up -d --remove-orphans
fi

echo ""
echo "✅ Synapsis has been updated to the latest published image."
