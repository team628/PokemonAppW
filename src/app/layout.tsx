import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'SetValue — what you have, what you need, what it is worth',
  description:
    'SetValue is the operating system for Pokémon card collectors. Track what you have, see exactly what you need to finish a set, and know what both are worth.',
  applicationName: 'SetValue',
  appleWebApp: { capable: true, statusBarStyle: 'black-translucent', title: 'SetValue' },
  manifest: '/manifest.webmanifest',
};

export const viewport: Viewport = {
  themeColor: '#0B0E14',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh bg-ink text-white">{children}</body>
    </html>
  );
}
