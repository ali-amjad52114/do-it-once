import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  // Server-only SDKs: keep them out of the bundler.
  serverExternalPackages: ['@mastra/*', '@onkernel/sdk', 'playwright-core', '@neondatabase/serverless'],
  images: { remotePatterns: [{ protocol: 'https', hostname: '**' }] },
};

export default nextConfig;
