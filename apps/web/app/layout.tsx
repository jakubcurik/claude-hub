import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Claude Hub",
  description: "Týmový katalog rozšíření pro Claude Code s kontrolou lokální instalace."
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="cs">
      <body>{children}</body>
    </html>
  );
}
