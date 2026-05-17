import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";

import { ThemeProvider } from "@/providers/theme-provider";
import { TimezoneProvider } from "@/providers/tz-provider";
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
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${inter.variable} ${jetbrainsMono.variable}`}
    >
      <body className="font-sans">
        <ThemeProvider attribute="class" defaultTheme="light" enableSystem disableTransitionOnChange>
          <TimezoneProvider tz={tz} serverNow={serverNow}>
            <TooltipProvider delayDuration={150}>{children}</TooltipProvider>
          </TimezoneProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
