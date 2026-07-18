import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: process.cwd(),
  allowedDevOrigins: ["127.0.0.1"],
};

export default nextConfig;
