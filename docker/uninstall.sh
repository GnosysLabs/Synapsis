#!/bin/sh

set -eu

INSTALL_DIR="${1:-${INSTALL_DIR:-/opt/synapsis}}"
PROJECT_NAME="${PROJECT_NAME:-synapsis}"
IMAGE_REPO="${IMAGE_REPO:-ghcr.io/gnosyslabs/synapsis}"

require_command() {
    if ! command -v "$1" >/dev/null 2>&1; then
        echo "❌ Required command not found: $1" >&2
        exit 1
    fi
}

confirm_uninstall() {
    if [ "${FORCE:-0}" = "1" ] || [ "${YES:-0}" = "1" ]; then
        return
    fi

    echo "========================================"
    echo "  Synapsis Docker Uninstaller"
    echo "========================================"
    echo "  Install dir: ${INSTALL_DIR}"
    echo "  Project name: ${PROJECT_NAME}"
    echo ""
    echo "This will permanently remove:"
    echo "  - Synapsis containers"
    echo "  - Synapsis Docker volumes and network"
    echo "  - Synapsis images pulled from GHCR/local cache"
    echo "  - ${INSTALL_DIR}"
    echo ""
    if [ -r /dev/tty ]; then
        printf "Type DELETE to continue: " > /dev/tty
        read -r confirmation < /dev/tty
    else
        echo "❌ Interactive confirmation requires a TTY." >&2
        echo "   Re-run with FORCE=1 if you want to skip the prompt." >&2
        exit 1
    fi

    if [ "$confirmation" != "DELETE" ]; then
        echo "Aborted."
        exit 1
    fi
}

cleanup_with_compose() {
    if [ -f "${INSTALL_DIR}/docker-compose.yml" ]; then
        echo "🧹 Stopping Synapsis compose stack"
        if [ -f "${INSTALL_DIR}/.env" ]; then
            docker compose --env-file "${INSTALL_DIR}/.env" -f "${INSTALL_DIR}/docker-compose.yml" down --volumes --remove-orphans || true
        else
            docker compose -f "${INSTALL_DIR}/docker-compose.yml" down --volumes --remove-orphans || true
        fi
    fi
}

cleanup_named_resources() {
    for container in synapsis-caddy synapsis-app synapsis-db; do
        if docker ps -aq --filter "name=^${container}$" | grep -q .; then
            echo "🗑️  Removing container ${container}"
            docker rm -f "${container}" >/dev/null 2>&1 || true
        fi
    done

    for volume in \
        synapsis_postgres_data \
        synapsis_uploads_data \
        synapsis_port_data \
        synapsis_caddy_data \
        synapsis_caddy_config
    do
        if docker volume inspect "${volume}" >/dev/null 2>&1; then
            echo "🗑️  Removing volume ${volume}"
            docker volume rm -f "${volume}" >/dev/null 2>&1 || true
        fi
    done

    if docker network inspect synapsis_synapsis-network >/dev/null 2>&1; then
        echo "🗑️  Removing network synapsis_synapsis-network"
        docker network rm synapsis_synapsis-network >/dev/null 2>&1 || true
    fi
}

cleanup_images() {
    docker images --format '{{.Repository}}:{{.Tag}}' | while IFS= read -r image; do
        case "$image" in
            "${IMAGE_REPO}:"*|synapsis:*)
                echo "🗑️  Removing image ${image}"
                docker rmi -f "$image" >/dev/null 2>&1 || true
                ;;
        esac
    done
}

remove_install_dir() {
    if [ -d "${INSTALL_DIR}" ]; then
        echo "🗑️  Removing ${INSTALL_DIR}"
        rm -rf "${INSTALL_DIR}"
    fi
}

require_command docker
require_command rm

if [ "$(id -u)" -ne 0 ]; then
    echo "❌ Run this uninstaller as root or with sudo." >&2
    exit 1
fi

confirm_uninstall
cleanup_with_compose
cleanup_named_resources
cleanup_images
remove_install_dir

echo ""
echo "✅ Synapsis has been removed from this host."
