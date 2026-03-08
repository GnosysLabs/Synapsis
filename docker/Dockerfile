# Synapsis - Multi-stage Production Dockerfile
# This Dockerfile creates a production-ready image that:
# - Keeps source files immutable (prevents accidental modifications)
# - Optimizes build size with multi-stage approach
# - Runs as non-root user for security

# ============================================
# Stage 1: Dependencies
# ============================================
FROM node:22-alpine AS deps
RUN apk add --no-cache libc6-compat openssl

WORKDIR /app

# Copy package files for efficient layer caching
COPY package.json package-lock.json* ./

# Install all dependencies (production + dev all in dependencies now)
RUN npm ci --ignore-scripts && npm cache clean --force

# ============================================
# Stage 2: Builder
# ============================================
FROM node:22-alpine AS builder
RUN apk add --no-cache libc6-compat openssl

WORKDIR /app

# Copy dependencies from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy all source files
COPY . .

# Set environment variables for build
ARG APP_VERSION=dev
ARG APP_COMMIT=unknown
ARG APP_BUILD_DATE=
ARG APP_GITHUB_URL=
ARG APP_IMAGE_REPO=ghcr.io/gnosyslabs/synapsis
ARG APP_SOURCE_REPO=https://github.com/GnosysLabs/Synapsis

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV APP_VERSION=${APP_VERSION}
ENV APP_COMMIT=${APP_COMMIT}
ENV APP_BUILD_DATE=${APP_BUILD_DATE}
ENV APP_GITHUB_URL=${APP_GITHUB_URL}
ENV APP_IMAGE_REPO=${APP_IMAGE_REPO}
ENV APP_SOURCE_REPO=${APP_SOURCE_REPO}

# Build the Next.js application
RUN npm run build

# ============================================
# Stage 3: Production Dependencies
# ============================================
FROM deps AS prod-deps
RUN npm prune --omit=dev && npm cache clean --force

# ============================================
# Stage 4: Production Runner
# ============================================
FROM node:22-alpine AS runner
RUN apk add --no-cache libc6-compat openssl netcat-openbsd wget

WORKDIR /app

ARG APP_VERSION=dev
ARG APP_COMMIT=unknown
ARG APP_BUILD_DATE=
ARG APP_GITHUB_URL=
ARG APP_IMAGE_REPO=ghcr.io/gnosyslabs/synapsis
ARG APP_SOURCE_REPO=https://github.com/GnosysLabs/Synapsis

LABEL org.opencontainers.image.source="${APP_SOURCE_REPO}"
LABEL org.opencontainers.image.description="Synapsis self-hosted social node"
LABEL org.opencontainers.image.version="${APP_VERSION}"
LABEL org.opencontainers.image.revision="${APP_COMMIT}"
LABEL org.opencontainers.image.created="${APP_BUILD_DATE}"

# Create non-root user for security
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# Create shared directory for port file (must be writable by nextjs)
RUN mkdir -p /var/run/synapsis && chown nextjs:nodejs /var/run/synapsis

# Set production environment
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
ENV APP_VERSION=${APP_VERSION}
ENV APP_COMMIT=${APP_COMMIT}
ENV APP_BUILD_DATE=${APP_BUILD_DATE}
ENV APP_GITHUB_URL=${APP_GITHUB_URL}
ENV APP_IMAGE_REPO=${APP_IMAGE_REPO}
ENV APP_SOURCE_REPO=${APP_SOURCE_REPO}

# Copy public assets
COPY --from=builder /app/public ./public

# Copy Next.js build output
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# Copy pruned runtime dependencies
COPY --from=prod-deps --chown=nextjs:nodejs /app/node_modules ./node_modules

# Copy drizzle migrations, config, and schema (needed for migrations)
COPY --from=builder --chown=nextjs:nodejs /app/drizzle ./drizzle
COPY --from=builder --chown=nextjs:nodejs /app/drizzle.config.ts ./
COPY --from=builder --chown=nextjs:nodejs /app/package.json ./
COPY --from=builder --chown=nextjs:nodejs /app/src/db/schema.ts ./src/db/schema.ts

# Copy entrypoint script
COPY --from=builder --chown=nextjs:nodejs /app/docker/docker-entrypoint.sh ./
RUN chmod +x ./docker-entrypoint.sh

# Switch to non-root user
USER nextjs

# Expose port range for auto-detection
EXPOSE 3000-3020

# Health check - longer start period to allow migrations to run
# Reads dynamic port file when PORT=auto
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=5 \
    CMD sh -c 'PORT_FILE=/var/run/synapsis/port; PORT=3000; if [ -f "$PORT_FILE" ]; then PORT=$(cat "$PORT_FILE"); fi; case "$PORT" in ""|*[!0-9]*) PORT=3000;; esac; wget -q --spider "http://127.0.0.1:${PORT}/api/health" || exit 1'

# Set the entrypoint
ENTRYPOINT ["./docker-entrypoint.sh"]
