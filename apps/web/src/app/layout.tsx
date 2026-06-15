import type { Metadata, Viewport } from "next";
import { Plus_Jakarta_Sans, JetBrains_Mono } from "next/font/google";
import { headers } from "next/headers";
import { MotionConfig } from "framer-motion";

import { ThemeProvider } from "@/providers/theme-provider";
import { TimezoneProvider } from "@/providers/tz-provider";
import { AuthBroadcastListener } from "@/components/auth-broadcast-listener";
import { NavProgress } from "@/components/nav-progress";
import { ServiceWorkerKillSwitch } from "@/components/service-worker-killswitch";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { getServerTimezone } from "@/lib/server-tz";

import "@/styles/globals.css";

const plusJakartaSans = Plus_Jakarta_Sans({
  subsets: ["latin"],
  variable: "--font-jakarta",
  display: "swap",
  weight: ["300", "400", "500", "600", "700", "800"],
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

// Lock the viewport to device width without disabling pinch-zoom — no
// userScalable:false / maximumScale (accessibility).
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
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
      className={`${plusJakartaSans.variable} ${jetbrainsMono.variable}`}
    >
      <body className="font-sans">
        {/* Skip-to-content link — first focusable in the DOM so a keyboard
            user can jump past the nav rails straight to the page's <main>
            (which carries id="main-content" + tabIndex={-1} in section-shell).
            Visually hidden until focused (sr-only → focus:not-sr-only). */}
        <a
          href="#main-content"
          className="sr-only rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-md focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
        >
          Skip to content
        </a>
        {/* One-shot unregister of any ghost service worker registered by a
            prior app on this origin. See ServiceWorkerKillSwitch for the
            full rationale. Client component (no inline-script-with-nonce
            path → no hydration-mismatch warning on the nonce attribute). */}
        <ServiceWorkerKillSwitch />
        <AuthBroadcastListener />
        {/* Top progress bar for client navigations. Replaces the per-section
            loading.tsx skeleton-swap (removed) with a hold-current-page +
            progress-bar feel — see components/nav-progress.tsx. */}
        <NavProgress />
        {/* Respect prefers-reduced-motion for ALL framer-motion surfaces in one
            place (Sheet/pill/spring/toast slide animations). CSS keyframes and
            the scroll hooks already honor it; this covers the JS-animated tree. */}
        <MotionConfig reducedMotion="user">
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
        </MotionConfig>
      </body>
    </html>
  );
}
