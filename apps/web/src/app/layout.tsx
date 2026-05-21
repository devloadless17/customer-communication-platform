import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { headers } from "next/headers";

import { ThemeProvider } from "@/providers/theme-provider";
import { TimezoneProvider } from "@/providers/tz-provider";
import { AuthBroadcastListener } from "@/components/auth-broadcast-listener";
import { ServiceWorkerKillSwitch } from "@/components/service-worker-killswitch";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { getServerTimezone } from "@/lib/server-tz";

import "@/styles/globals.css";

// `display: "swap"`, not "optional" — chosen for cross-refresh consistency.
// Both fonts self-host via next/font and both get next/font's metric-matched
// fallback (size-adjust + ascent/descent overrides), so the fallback→Inter
// handoff is ~zero CLS either way. The real difference is *which font you end
// up on*, and how stable that is between page loads:
//
//   optional: gives the web font only a ~100ms window. Miss it (cold or busy
//             load) and the page renders in the fallback for that ENTIRE load
//             and never swaps. So the font visibly alternates refresh-to-
//             refresh, and because the fallback is metric-matched but not
//             metric-IDENTICAL, some elements grow/shrink a hair depending on
//             which font won that load. That coin-flip reads as the
//             flicker/"vibration" on refresh.
//   swap:     paint the fallback immediately, then ALWAYS swap Inter in once
//             it arrives. subsets:["latin"] makes next/font emit a
//             <link rel=preload> for the woff2, and it's served from our own
//             origin, so on a warm cache the swap is a few ms — imperceptible.
//             End state is always Inter, identical on every refresh.
//
// Chat-scroll note: inbox bubbles render in font-sans (Inter), whose metric
// fallback match is tight enough that the swap doesn't drift the snapped-to-
// bottom scroll. (font-mono / JetBrains is only used in scattered badges + IDs,
// never the bubble body, so its looser mono-fallback match doesn't reach the
// scroll-sensitive surface.)
//
// NOTE: `next dev` injects global CSS via JS, so it shows a brief first-paint
// flash regardless of font-display. Judge this in a production build
// (`npm run build && npm run start`), not `npm run dev`.
const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
  display: "swap",
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
        <AuthBroadcastListener />
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
