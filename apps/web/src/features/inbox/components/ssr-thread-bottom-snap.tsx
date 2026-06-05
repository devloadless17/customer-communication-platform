/**
 * SSR-only position-and-reveal for the message thread.
 *
 * THE PROBLEM IT SOLVES: on a HARD refresh of /inbox?c=<id>, page.tsx SSRs the
 * full thread. Left to paint as-is, the user watches it SETTLE over the first
 * few hundred ms:
 *   1. The `column-reverse` viewport doesn't reliably anchor at the bottom on a
 *      cold document load (Chromium computes the initial offset against a
 *      not-yet-final height) — it paints scrolled to the TOP (oldest).
 *   2. The web font (`Plus_Jakarta_Sans`, display:swap) swaps in a beat after
 *      first paint, re-laying-out EVERY row (FOUT) — the big visible reflow.
 *   3. Images decode in.
 * `useChatScroll` only corrects the scroll AFTER React hydrates (hundreds of ms
 * on a cold prod load), so the net effect is a flicker-then-jump. That's the
 * bug being killed here.
 *
 * THE FIX: the thread is rendered HIDDEN (the reveal gate — see globals.css
 * `[data-thread-gate]`). This inline <script>, emitted by THIS SERVER COMPONENT
 * as a sibling AFTER the shell, runs DURING HTML parse — before first paint,
 * with the viewport already in the DOM. It:
 *   - pins `scrollTop = 0` (column-reverse bottom = newest), re-asserting it
 *     across the first frames while layout settles, and
 *   - reveals the thread (`data-ready` on the gate) only once `document.fonts.
 *     ready` resolves — i.e. AFTER the FOUT reflow, so the swap happens while
 *     hidden — with a hard timeout cap so a slow/failed font never holds it.
 * So the first frame the user actually sees is the thread already at the bottom,
 * in the final font, solid. Zero hydration dependency: fast/cached loads reveal
 * in a few ms; slow loads show the loader until fonts land.
 *
 * Why a SERVER component and not an inline <script> in a Client Component:
 * React 19 warns about <script> rendered inside a Client Component (it only runs
 * on the SSR pass). Rendering it from a server component is the blessed way to
 * emit a one-shot parse-time script. It is NOT hydrated and never re-runs.
 *
 * `data-ready` is set IMPERATIVELY (here + a React effect fallback in
 * message-thread.tsx), never via React's render — the gate carries
 * suppressHydrationWarning — so hydration/re-render can't strip it and cause a
 * reveal→hide→reveal flash.
 */
import { headers } from "next/headers";

export async function SsrThreadBottomSnap() {
  // The prod CSP is `script-src 'self' 'nonce-X' 'strict-dynamic'` with NO
  // 'unsafe-inline' (src/proxy.ts). An inline <script> WITHOUT the per-request
  // nonce is silently blocked in prod — works in dev, dead on deploy. Stamp the
  // nonce that proxy.ts put on the request header, same as app/layout.tsx does.
  // (If the script is ever blocked, message-thread.tsx's effect still reveals.)
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  // No template literals with interpolation — this string is static, so there's
  // no XSS surface. It only reads/writes the thread viewport's scrollTop and the
  // gate's data-ready attribute.
  const js = `(function(){
    var gate = document.querySelector('[data-thread-gate]');
    var vp = document.querySelector('[data-thread-scroll-root]');
    if (!gate || !vp) return;
    var done = false;
    function position(){
      // Once useChatScroll has mounted it owns scroll — stop fighting it.
      if (vp.getAttribute('data-chat-scroll-ready') === '1') return;
      // column-reverse: scrollTop 0 IS the bottom (newest); older is negative.
      vp.scrollTop = 0;
    }
    function reveal(){
      if (done) return;
      done = true;
      position();
      gate.setAttribute('data-ready', '');
    }
    position();
    // Re-assert the bottom across the first frames while bubble heights / image
    // reservations settle (cheap; column-reverse already keeps us pinned).
    var n = 0;
    (function frame(){ if (done) return; position(); if (++n < 30) requestAnimationFrame(frame); })();
    // Reveal once the web font has loaded (kills the FOUT reflow — it happens
    // while hidden). Two rAFs after so the post-swap layout + scroll settle.
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(function(){
        requestAnimationFrame(function(){ requestAnimationFrame(reveal); });
      });
    } else {
      requestAnimationFrame(reveal);
    }
    // Hard cap: never keep the thread hidden longer than this, even if a font
    // load stalls or fails. ~600ms is below the threshold where a blank wait
    // reads as "broken" while still covering a normal font fetch.
    setTimeout(reveal, 600);
  })();`;

  // suppressHydrationWarning: the server emits this <script>; the client never
  // renders it (it's a server component), so React must not try to reconcile it.
  return (
    <script
      nonce={nonce}
      suppressHydrationWarning
      dangerouslySetInnerHTML={{ __html: js }}
    />
  );
}
