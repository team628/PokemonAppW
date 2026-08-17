import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ['better-sqlite3'],
  // Declared explicitly for both bundlers rather than relying on tsconfig
  // `paths` inference, which does not reach the webpack build here.
  turbopack: { resolveAlias: { '@': './src' } },
  webpack: (config) => {
    config.resolve.alias = { ...config.resolve.alias, '@': path.join(root, 'src') };
    return config;
  },
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'images.pokemontcg.io' },
      { protocol: 'https', hostname: 'images.scrydex.com' },
    ],
  },
};
export default nextConfig;
