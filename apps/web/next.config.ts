import path from "node:path";
import type { NextConfig } from "next";
import dotenv from "dotenv";

// The shared .env lives at the monorepo root; Next only auto-loads app-local ones.
dotenv.config({ path: path.join(__dirname, "..", "..", ".env") });

const nextConfig: NextConfig = {
  transpilePackages: ["@mission-control/db", "@mission-control/core"],
};

export default nextConfig;
