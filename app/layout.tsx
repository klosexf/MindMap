import type { Metadata } from 'next';

import './globals.css';

export const metadata: Metadata = {
  title: 'MindMap MVP',
  description: 'Single-user mindmap MVP based on G6 + JSON Tree + Zustand',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        {/* 衬线 Display 字体：React 会将 link 提升至 <head> */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        {/* eslint-disable-next-line @next/next/no-page-custom-font -- App Router 根布局对所有页面生效 */}
        <link
          href="https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@700&family=Playfair+Display:ital,wght@0,700;1,500&display=swap"
          rel="stylesheet"
        />
        {children}
      </body>
    </html>
  );
}
