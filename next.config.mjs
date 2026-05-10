/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false,
  experimental: {
    serverComponentsExternalPackages: ['pdfjs-dist'],
    serverActions: {
      bodySizeLimit: '10mb',
    },
  },
};

export default nextConfig;
