import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Turso ships a platform-native Node module and must remain a runtime dependency.
  serverExternalPackages: ['@tursodatabase/database'],
  
  // Turbopack configuration
  turbopack: {
    root: process.cwd(),
  },
};

export default nextConfig;
