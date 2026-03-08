#!/bin/sh

set -eu

IMAGE_REPO="${IMAGE_REPO:-ghcr.io/gnosyslabs/synapsis}"
PACKAGE_API="${PACKAGE_API:-/orgs/GnosysLabs/packages/container/synapsis/versions?per_page=100}"
BUILDER="${BUILDER:-colima}"
PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"
DATE_PREFIX="${DATE_PREFIX:-$(date -u +%Y.%m.%d)}"
SOURCE_REPO="${SOURCE_REPO:-https://github.com/GnosysLabs/Synapsis}"

require_command() {
    if ! command -v "$1" >/dev/null 2>&1; then
        echo "❌ Required command not found: $1" >&2
        exit 1
    fi
}

require_command docker
require_command gh
require_command git

CURRENT_SHA="$(git rev-parse --short HEAD)"
CURRENT_FULL_SHA="$(git rev-parse HEAD)"
BUILD_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

existing_tags="$(
    gh api "${PACKAGE_API}" --paginate --jq '.[].metadata.container.tags[]?' 2>/dev/null || true
)"

max_build=0
for tag in ${existing_tags}; do
    case "${tag}" in
        "${DATE_PREFIX}".*)
            build_number="${tag##${DATE_PREFIX}.}"
            case "${build_number}" in
                ''|*[!0-9]*)
                    ;;
                *)
                    if [ "${build_number}" -gt "${max_build}" ]; then
                        max_build="${build_number}"
                    fi
                    ;;
            esac
            ;;
    esac
done

next_build=$((max_build + 1))
APP_VERSION="${DATE_PREFIX}.${next_build}"
GITHUB_URL="${SOURCE_REPO}/commit/${CURRENT_FULL_SHA}"

echo "========================================"
echo "  Synapsis Docker Publish"
echo "========================================"
echo "  Version: ${APP_VERSION}"
echo "  Commit: ${CURRENT_SHA}"
echo "  Image: ${IMAGE_REPO}"
echo "========================================"

docker buildx build \
  --builder "${BUILDER}" \
  --platform "${PLATFORMS}" \
  --build-arg "APP_VERSION=${APP_VERSION}" \
  --build-arg "APP_COMMIT=${CURRENT_FULL_SHA}" \
  --build-arg "APP_BUILD_DATE=${BUILD_DATE}" \
  --build-arg "APP_GITHUB_URL=${GITHUB_URL}" \
  --build-arg "APP_IMAGE_REPO=${IMAGE_REPO}" \
  --build-arg "APP_SOURCE_REPO=${SOURCE_REPO}" \
  -f docker/Dockerfile \
  -t "${IMAGE_REPO}:latest" \
  -t "${IMAGE_REPO}:${APP_VERSION}" \
  -t "${IMAGE_REPO}:${CURRENT_SHA}" \
  --push \
  .

echo ""
echo "✅ Published:"
echo "  ${IMAGE_REPO}:latest"
echo "  ${IMAGE_REPO}:${APP_VERSION}"
echo "  ${IMAGE_REPO}:${CURRENT_SHA}"
