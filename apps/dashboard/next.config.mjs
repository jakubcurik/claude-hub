// SPDX-License-Identifier: Apache-2.0
/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@claude-hub/shared-types'],
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${process.env.HUB_SERVER_URL ?? 'http://localhost:3000'}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
