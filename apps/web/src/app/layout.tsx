import type { Metadata } from "next";
import { Plus_Jakarta_Sans, JetBrains_Mono } from "next/font/google";
import { headers } from "next/headers";

import { ThemeProvider } from "@/providers/theme-provider";
import { TimezoneProvider } from "@/providers/tz-provider";
import { AuthBroadcastListener } from "@/components/auth-broadcast-listener";
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
