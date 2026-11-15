import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  async redirects() {
    return [
      {
        source: "/markets",
        destination: "/pools",
        permanent: false,
      },
    ];
  },
};

export default nextConfig;
