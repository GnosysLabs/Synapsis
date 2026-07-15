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

const nextConfig: NextConfig = {
  env: {
    APP_COMMIT: getBuildCommit(),
    APP_BUILD_DATE: process.env.APP_BUILD_DATE || new Date().toISOString(),
  },

  // Turso ships a platform-native Node module and must remain a runtime dependency.
  serverExternalPackages: ['@tursodatabase/database'],
  
  // Turbopack configuration
  turbopack: {
    root: process.cwd(),
  },
};

export default nextConfig;
