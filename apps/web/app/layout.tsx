import type { Metadata, Viewport } from "next";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import { ThemeProvider } from "next-themes";
import { SiteFooter } from "@/components/shell/site-footer";
import { SiteHeader } from "@/components/shell/site-header";
import { TimezoneSync } from "@/components/shell/tz-sync";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SITE_URL } from "@/lib/data";
import { viewerTimeZone } from "@/lib/tz-server";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: "relay — your coding-agent subscriptions as one system", template: "%s · relay" },
  description:
    "relay is an open-source harness that turns Claude Code, Codex and Grok subscriptions into one system: GitHub issues as the task bus, runners on your own machines, shared memory, and a feed of everything agents did and what it cost.",
  applicationName: "relay",
  keywords: ["coding agents", "Claude Code", "Codex", "Grok", "GitHub Actions", "self-hosted runners", "agent harness", "open source"],
  openGraph: {
    type: "website",
    siteName: "relay",
    title: "relay — your coding-agent subscriptions as one system",
    description: "GitHub issues as the task bus, runners on your own machines, shared memory, and a feed of everything agents did and what it cost.",
    url: SITE_URL,
  },
  twitter: { card: "summary_large_image" },
  alternates: { canonical: SITE_URL },
  other: { "is-agentic-site-type": "app" },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fbfbfa" },
    { media: "(prefers-color-scheme: dark)", color: "#171718" },
  ],
};

// TODO(auth): sign-in goes here. The layout will read the session, pass the viewer into
// the data layer, and show a sign-in button in the header. /info, /docs and the
// well-known files stay public.

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const tz = await viewerTimeZone();
  return (
    <html lang="en" suppressHydrationWarning className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <head>
        <link rel="ai-catalog" href="/.well-known/ai-catalog.json" />
        <link rel="alternate" type="text/markdown" href="/info" title="relay (Markdown)" />
      </head>
      <body className="min-h-dvh flex flex-col">
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
          <TooltipProvider delayDuration={200}>
            <SiteHeader />
            <main className="mx-auto w-full max-w-6xl flex-1 px-4">{children}</main>
            <SiteFooter />
          </TooltipProvider>
        </ThemeProvider>
        <TimezoneSync current={tz} />
      </body>
    </html>
  );
}
