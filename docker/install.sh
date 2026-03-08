#!/bin/sh

set -eu

REPO="${REPO:-GnosysLabs/Synapsis}"
REF="${REF:-main}"
INSTALL_DIR="${1:-${INSTALL_DIR:-/opt/synapsis}}"
PUBLIC_INSTALL_URL="${PUBLIC_INSTALL_URL:-https://synapsis.social/install.sh}"

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

generate_db_password() {
    openssl rand -base64 24 | tr -d '\n' | tr '/+' '_-' | cut -c1-32
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

echo "========================================"
echo "  Synapsis Docker Installer"
echo "========================================"
echo "  Repo: ${REPO}"
echo "  Ref: ${REF}"
echo "  Install dir: ${INSTALL_DIR}"
echo "========================================"

install_docker_if_needed
mkdir -p "${INSTALL_DIR}"

download_file "docker-compose.yml" "${INSTALL_DIR}/docker-compose.yml"
download_file "docker/Caddyfile" "${INSTALL_DIR}/Caddyfile"
download_file "docker/caddy-entrypoint.sh" "${INSTALL_DIR}/caddy-entrypoint.sh"
download_file "docker/.env.example" "${INSTALL_DIR}/.env.example"

chmod 755 "${INSTALL_DIR}/caddy-entrypoint.sh"

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
echo "  2. Start Synapsis:"
echo "     cd ${INSTALL_DIR} && docker compose up -d"
echo ""
echo "One-line usage examples:"
echo "  curl -fsSL ${PUBLIC_INSTALL_URL} | bash"
echo "  curl -fsSL ${PUBLIC_INSTALL_URL} | DOMAIN=synapsis.example.com ADMIN_EMAILS=you@example.com bash"
