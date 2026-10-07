import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "VibeCheck — Auditor IA para la era del vibe coding",
  description:
    "Open source. Detecta alucinaciones de IA, secretos filtrados, bugs sutiles y sobre-ingeniería en tu código antes de llegar a producción. Consigue tu Vibe Score.",
  keywords: [
    "vibe coding",
    "auditoría de código",
    "IA",
    "alucinaciones IA",
    "slopsquatting",
    "open source",
    "seguridad",
    "Next.js",
  ],
  authors: [{ name: "Comunidad VibeCheck" }],
  icons: {
    icon: "https://z-cdn.chatglm.cn/z-ai/static/logo.svg",
  },
  openGraph: {
    title: "VibeCheck — ¿La IA escribió tu código?",
    description:
      "Auditor de código con IA para la era del vibe coding. Open source, MIT.",
    siteName: "VibeCheck",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="es" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
