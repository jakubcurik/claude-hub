// SPDX-License-Identifier: Apache-2.0
import type { ReactNode } from 'react';
import './globals.css';

export const metadata = {
  title: 'Claude Hub',
  description: 'Self-hosted team marketplace for Claude Code',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
