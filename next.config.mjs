/** @type {import('next').NextConfig} */
const isDev = process.env.NODE_ENV === 'development';

const nextConfig = {
  // Isolate dev artifacts from production build output.
  // Prevents style/static asset 404 when `next build` runs while `next dev` is active.
  distDir: isDev ? '.next-dev' : '.next',
  reactStrictMode: false,
  experimental: {
    serverComponentsExternalPackages: ['pdfjs-dist'],
    serverActions: {
      bodySizeLimit: '10mb',
    },
  },
};

export default nextConfig;
