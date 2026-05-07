import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Custom server (server.ts) replaces Next's default server, so the
  // standalone output pattern from slice 1 is dropped.
};

export default nextConfig;
