import type { NextConfig } from "next";

// In dev, proxy /api to FastAPI. In production Caddy routes /api directly.
const backend = process.env.BACKEND_URL ?? "http://localhost:8000";

const nextConfig: NextConfig = {
  output: "standalone",
  async redirects() {
    return [{ source: "/runs/:id/review", destination: "/bmquery?run=:id", permanent: false }];
  },
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${backend}/api/:path*` }];
  },
};

export default nextConfig;
