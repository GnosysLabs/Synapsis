import type { NextConfig } from "next";
import { execFileSync } from "node:child_process";

function getBuildCommit(): string {
  if (process.env.APP_COMMIT) return process.env.APP_COMMIT;

  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    }).trim();
  } catch {
    return 'unknown';
  }
}

function getBuildCommitCount(): string {
  if (process.env.APP_COMMIT_COUNT) return process.env.APP_COMMIT_COUNT;

  try {
    return execFileSync('git', ['rev-list', '--count', 'HEAD'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    }).trim();
  } catch {
    return 'unknown';
  }
}

export const contentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'${process.env.NODE_ENV === 'development' ? " 'unsafe-eval'" : ''} https://challenges.cloudflare.com`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' https: wss:",
  "frame-src https://challenges.cloudflare.com",
  "worker-src 'self' blob:",
].join('; ');

const nextConfig: NextConfig = {
  env: {
    APP_COMMIT: getBuildCommit(),
    APP_COMMIT_COUNT: getBuildCommitCount(),
    APP_BUILD_DATE: process.env.APP_BUILD_DATE || new Date().toISOString(),
  },

  // Turso ships a platform-native Node module and must remain a runtime dependency.
  serverExternalPackages: ['@tursodatabase/database'],
  
  // Turbopack configuration
  turbopack: {
    root: process.cwd(),
  },

  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: contentSecurityPolicy },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin-allow-popups' },
        ],
      },
      {
        // API bodies vary by session, sensitive-content permission, and signed
        // federation trust. Never let a reverse proxy reuse one viewer's body.
        source: '/api/:path*',
        headers: [
          { key: 'Cache-Control', value: 'private, no-store, max-age=0' },
        ],
      },
    ];
  },
};

export default nextConfig;
