import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { headers } from "next/headers";

import { ThemeProvider } from "@/providers/theme-provider";
import { TimezoneProvider } from "@/providers/tz-provider";
import { ServiceWorkerKillSwitch } from "@/components/service-worker-killswitch";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { getServerTimezone } from "@/lib/server-tz";

import "@/styles/globals.css";

// `display: "optional"` eliminates the font-swap reflow that "swap" causes.
// With swap: browser paints in fallback, then re-renders in Inter when the
// font arrives → bubble heights shift → the snapped-to-bottom message drifts
// up → useChatScroll has to re-snap. The user sees this as a small "lag"
// after first paint on hard refresh.
//
// With optional: the browser keeps the fallback for this page load if Inter
// doesn't arrive within ~100ms. Inter caches for next time, so every
// subsequent visit (including normal navigations within a session) gets the
// custom font without any CLS. First cold visit on a slow connection shows
// the fallback — acceptable trade for zero layout shift inside the inbox.
//
// next/font already injects size-adjust + ascent/descent overrides so the
// fallback and Inter have closely matched metrics; "optional" plus that
// metric-matching is the modern best-practice combo for chat-style UIs.
const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "optional",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
  display: "optional",
});

export const metadata: Metadata = {
  title: "Inbox · Loadless",
  description: "Shared inbox for WhatsApp customer conversations.",
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const tz = await getServerTimezone();
  const serverNow = Date.now();
  // CSP nonce is stamped onto the request by src/proxy.ts. Pass it to
  // next-themes so the inline FOUC-prevention script executes under the
  // page's `script-src 'nonce-...'`. Missing nonce (e.g. during static
  // prerendering with no proxy on the path) falls through as undefined.
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${inter.variable} ${jetbrainsMono.variable}`}
    >
      <body className="font-sans">
        {/* One-shot unregister of any ghost service worker registered by a
            prior app on this origin. See ServiceWorkerKillSwitch for the
            full rationale. Client component (no inline-script-with-nonce
            path → no hydration-mismatch warning on the nonce attribute). */}
        <ServiceWorkerKillSwitch />
        <ThemeProvider
          attribute="class"
          defaultTheme="light"
          enableSystem
          disableTransitionOnChange
          nonce={nonce}
        >
          <TimezoneProvider tz={tz} serverNow={serverNow}>
            <TooltipProvider delayDuration={150}>{children}</TooltipProvider>
            <Toaster />
          </TimezoneProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
