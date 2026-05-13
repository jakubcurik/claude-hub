import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";

// Inter Variable — self-hosted z apps/web/app/fonts/. Žádná závislost na Google Fonts
// při buildu (NAS / restriktivní sítě by jinak mohly stahování zablokovat a font
// by spadl na serif fallback).
const inter = localFont({
  src: [
    { path: "./fonts/InterVariable.woff2", style: "normal", weight: "100 900" },
    { path: "./fonts/InterVariable-Italic.woff2", style: "italic", weight: "100 900" }
  ],
  variable: "--font-sans",
  display: "swap"
});

export const metadata: Metadata = {
  title: "Claude Hub",
  description: "Týmový katalog rozšíření pro Claude Code s kontrolou lokální instalace.",
  // Brání Chromu auto-detekovat čísla v tabulkách jako telefony/data a barvit je linkem.
  formatDetection: { telephone: false, date: false, address: false, email: false }
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="cs" className={inter.variable}>
      <body>{children}</body>
    </html>
  );
}
