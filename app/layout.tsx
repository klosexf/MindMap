import type { Metadata } from 'next';

import './globals.css';

export const metadata: Metadata = {
  title: 'MindMap MVP',
  description: 'Single-user mindmap MVP based on G6 + JSON Tree + Zustand',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
