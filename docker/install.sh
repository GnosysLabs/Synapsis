#!/bin/sh

set -eu

REPO="${REPO:-GnosysLabs/Synapsis}"
REF="${REF:-main}"
INSTALL_DIR="${1:-${INSTALL_DIR:-/opt/synapsis}}"
PUBLIC_INSTALL_URL="${PUBLIC_INSTALL_URL:-https://synapsis.social/install.sh}"
PROXY="${PROXY:-caddy}"

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

is_port_in_use() {
    port="$1"

    if command -v ss >/dev/null 2>&1; then
        ss -tulpn 2>/dev/null | grep -q ":${port} "
        return $?
    fi

    if command -v lsof >/dev/null 2>&1; then
        lsof -iTCP:"${port}" -sTCP:LISTEN >/dev/null 2>&1
        return $?
    fi

    if command -v netstat >/dev/null 2>&1; then
        netstat -tulpn 2>/dev/null | grep -q ":${port} "
        return $?
    fi

    return 1
}

ensure_caddy_ports_available() {
    for port in 80 443; do
        if is_port_in_use "$port"; then
            echo "❌ Port ${port} is already in use on this host." >&2
            echo "   The default Synapsis install includes Caddy and needs ports 80/443." >&2
            echo "   If this is a fresh VPS, free those ports and rerun the installer." >&2
            echo "   If this host already runs nginx or another reverse proxy, rerun with:" >&2
            echo "   curl -fsSL ${PUBLIC_INSTALL_URL} | PROXY=none bash" >&2
            exit 1
        fi
    done
}

set_env_value() {
    file="$1"
    key="$2"
    value="$3"

    escaped_value=$(printf '%s\n' "$value" | sed -e 's/[\/&]/\\&/g')
    sed -i.bak -E "s|^${key}=.*$|${key}=${escaped_value}|" "$file"
    rm -f "${file}.bak"
}

generate_db_password() {
    openssl rand -base64 24 | tr -d '\n' | tr '/+' '_-' | cut -c1-32
}

resolve_proxyless_host_port() {
    if [ -n "${APP_HOST_PORT:-}" ]; then
        printf '%s\n' "${APP_HOST_PORT}"
        return
    fi

    printf '%s\n' "3000"
}

install_docker_if_needed() {
    if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
        echo "🐳 Docker is already installed"
        return
    fi

    if [ "$(id -u)" -ne 0 ]; then
        echo "❌ Docker is not installed and this installer is not running as root." >&2
        echo "   Re-run it as root or with sudo so Synapsis can install Docker for you." >&2
        exit 1
    fi

    echo "🐳 Docker not found, installing Docker"
    curl -fsSL https://get.docker.com | sh

    if command -v systemctl >/dev/null 2>&1; then
        systemctl enable --now docker >/dev/null 2>&1 || true
    elif command -v service >/dev/null 2>&1; then
        service docker start >/dev/null 2>&1 || true
    fi

    if ! command -v docker >/dev/null 2>&1; then
        echo "❌ Docker installation did not finish successfully." >&2
        exit 1
    fi

    if ! docker compose version >/dev/null 2>&1; then
        echo "⚠️  Docker was installed, but 'docker compose' is not available yet." >&2
        echo "   Install the Docker Compose plugin before starting Synapsis." >&2
    fi
}

require_command curl
require_command chmod
require_command mkdir
require_command cp

RAW_BASE="https://raw.githubusercontent.com/${REPO}/${REF}"
PROXY="$(normalize_proxy_mode "${PROXY}")"
PROXYLESS_HOST_PORT="$(resolve_proxyless_host_port)"

echo "========================================"
echo "  Synapsis Docker Installer"
echo "========================================"
echo "  Repo: ${REPO}"
echo "  Ref: ${REF}"
echo "  Install dir: ${INSTALL_DIR}"
echo "  Proxy mode: ${PROXY}"
echo "========================================"

install_docker_if_needed
mkdir -p "${INSTALL_DIR}"

download_file "docker/.env.example" "${INSTALL_DIR}/.env.example"
case "${PROXY}" in
    caddy)
        ensure_caddy_ports_available
        download_file "docker-compose.yml" "${INSTALL_DIR}/docker-compose.yml"
        download_file "docker/Caddyfile" "${INSTALL_DIR}/Caddyfile"
        download_file "docker/caddy-entrypoint.sh" "${INSTALL_DIR}/caddy-entrypoint.sh"
        chmod 755 "${INSTALL_DIR}/caddy-entrypoint.sh"
        rm -f "${INSTALL_DIR}/docker-compose.proxyless.yml"
        ;;
    none)
        download_file "docker-compose.proxyless.yml" "${INSTALL_DIR}/docker-compose.yml"
        rm -f "${INSTALL_DIR}/Caddyfile" "${INSTALL_DIR}/caddy-entrypoint.sh"
        ;;
esac

if [ ! -f "${INSTALL_DIR}/.env" ]; then
    cp "${INSTALL_DIR}/.env.example" "${INSTALL_DIR}/.env"
    echo "📝 Created ${INSTALL_DIR}/.env"

    if command -v openssl >/dev/null 2>&1; then
        set_env_value "${INSTALL_DIR}/.env" "AUTH_SECRET" "$(openssl rand -hex 32)"
        set_env_value "${INSTALL_DIR}/.env" "DB_PASSWORD" "$(generate_db_password)"
        echo "🔐 Generated AUTH_SECRET and DB_PASSWORD"
    else
        echo "⚠️  openssl not found, leaving placeholder secrets in .env"
    fi

    if [ -n "${DOMAIN:-}" ]; then
        set_env_value "${INSTALL_DIR}/.env" "DOMAIN" "${DOMAIN}"
        echo "🌐 Set DOMAIN=${DOMAIN}"
    fi

    if [ -n "${ADMIN_EMAILS:-}" ]; then
        set_env_value "${INSTALL_DIR}/.env" "ADMIN_EMAILS" "${ADMIN_EMAILS}"
        echo "📧 Set ADMIN_EMAILS=${ADMIN_EMAILS}"
    fi
else
    echo "📝 Existing ${INSTALL_DIR}/.env found, leaving it unchanged"
fi

echo ""
echo "Next steps:"
echo "  1. Review ${INSTALL_DIR}/.env"
if [ "${PROXY}" = "caddy" ]; then
    echo "  2. Start Synapsis:"
    echo "     cd ${INSTALL_DIR} && docker compose up -d"
else
    echo "  2. Start Synapsis:"
    echo "     cd ${INSTALL_DIR} && docker compose up -d"
    echo "  3. Configure your existing reverse proxy to forward to:"
    echo "     http://127.0.0.1:${PROXYLESS_HOST_PORT}"
    echo "     (change APP_HOST_PORT in ${INSTALL_DIR}/.env if you want a different localhost port)"
fi
